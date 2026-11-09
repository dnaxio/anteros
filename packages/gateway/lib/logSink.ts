import { createReadStream, createWriteStream, existsSync, mkdirSync, promises as fs, statSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { dirname, extname, join, parse } from "node:path";
import type { DuckDBAppender, DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { GatewayConfigError } from "../types";
import type {
    GatewayLogEntry,
    GatewayLogRotation,
    ResolvedGatewayLoggingConfig,
    ResolvedGatewayLogRotation,
} from "../types";

export interface LogSink {
    /** Resolves when the sink can accept writes (DuckDB opens the database asynchronously). */
    readonly ready: Promise<void>;
    write(entry: GatewayLogEntry): void;
    close(): Promise<void>;
}

const CORE_FIELDS = new Set([
    "timestamp",
    "level",
    "logger",
    "requestId",
    "method",
    "path",
    "microservice",
    "upstream",
    "status",
    "durationMs",
    "requestBody",
]);

const MAX_PENDING_DUCKDB = 10_000;
const FLUSH_EVERY = 100;

const CREATE_LOGS_TABLE = `
    CREATE TABLE IF NOT EXISTS logs (
        timestamp    VARCHAR NOT NULL,
        level        VARCHAR NOT NULL,
        logger       VARCHAR NOT NULL,
        request_id   VARCHAR NOT NULL,
        method       VARCHAR NOT NULL,
        path         VARCHAR NOT NULL,
        microservice VARCHAR,
        upstream     VARCHAR,
        status       INTEGER NOT NULL,
        duration_ms  BIGINT  NOT NULL,
        fields       VARCHAR,
        raw          VARCHAR
    )
`;

export function createLogSink(
    logging: ResolvedGatewayLoggingConfig,
    customLogger?: (entry: GatewayLogEntry) => void,
): LogSink {
    if (!logging.enabled) return noopSink();
    if (customLogger) return customSink(customLogger);
    if (logging.engine === "file") {
        return new FileSink(logging.file ?? ".logs/gateway.log", logging.rotate);
    }
    if (logging.engine === "duckdb") {
        return new DuckDbSink(
            logging.file ?? ".logs/gateway.duckdb",
            logging.ttlMs,
            logging.purgeEveryMs,
            logging.purgeOnStart ?? true,
        );
    }
    return stdoutSink();
}

function noopSink(): LogSink {
    return { ready: Promise.resolve(), write: () => {}, close: async () => {} };
}

function stdoutSink(): LogSink {
    return {
        ready: Promise.resolve(),
        write: (entry) => {
            try {
                console.log(JSON.stringify(entry));
            } catch {
                // Logging must never fail a request.
            }
        },
        close: async () => {},
    };
}

function customSink(logger: (entry: GatewayLogEntry) => void): LogSink {
    return {
        ready: Promise.resolve(),
        write: (entry) => {
            try {
                logger(entry);
            } catch (error) {
                reportFailure("custom logger", error);
            }
        },
        close: async () => {},
    };
}

/**
 * JSONL file sink. With `rotate` set, the live file is archived by period or by size,
 * compressed optionally, and pruned to `maxFiles`; writes are serialized in a promise
 * queue so a rotation always lands before the next append.
 */
class FileSink implements LogSink {
    readonly ready = Promise.resolve();
    readonly #file: string;
    readonly #rotate: ResolvedGatewayLogRotation | null;
    #queue: Promise<void> = Promise.resolve();
    #size = 0;
    #period = "";
    #closed = false;

    constructor(file: string, rotate: ResolvedGatewayLogRotation | null) {
        this.#file = file;
        this.#rotate = rotate;

        try {
            mkdirSync(dirname(file), { recursive: true });
            const stat = statSync(file);
            this.#size = stat.size;
            // A live file left by a previous period is archived under its own period
            // on the next write, instead of mixing two periods in one file.
            if (rotate && rotate.mode !== "size" && stat.size > 0) {
                this.#period = periodOf(stat.mtime, rotate.mode) ?? "";
            }
        } catch (error: any) {
            if (error?.code !== "ENOENT") {
                throw new GatewayConfigError(`cannot open log file '${file}': ${error.message}`);
            }
        }
    }

    write(entry: GatewayLogEntry): void {
        if (this.#closed) return;

        const line = JSON.stringify(entry) + "\n";
        const bytes = Buffer.byteLength(line);
        const rotate = this.#rotate;

        if (rotate) {
            if (rotate.mode === "size") {
                if (this.#size > 0 && this.#size + bytes > (rotate.maxSize ?? 0)) {
                    this.#size = 0;
                    this.#enqueue(() => this.#rotateBySize());
                }
            } else {
                const current = periodOf(new Date(), rotate.mode)!;
                if (this.#period && current !== this.#period) {
                    const previous = this.#period;
                    this.#size = 0;
                    this.#enqueue(() => this.#rotateToPeriod(previous));
                    this.#period = current;
                } else if (!this.#period) {
                    this.#period = current;
                }
            }
        }

        this.#size += bytes;
        this.#enqueue(() => fs.appendFile(this.#file, line));
    }

    async close(): Promise<void> {
        this.#closed = true;
        await this.#queue;
    }

    #enqueue(task: () => Promise<unknown>): void {
        this.#queue = this.#queue
            .then(task)
            .then(() => undefined)
            .catch((error) => reportFailure("file logger", error));
    }

    async #rotateToPeriod(period: string): Promise<void> {
        const dir = dirname(this.#file);
        const base = parse(this.#file).name;
        const ext = extname(this.#file);
        const target = this.#uniqueArchive(join(dir, `${base}-${period}${ext}`));
        await fs.rename(this.#file, target).catch((error) => reportFailure("file logger", error));
        await this.#finishArchive(target);
    }

    async #rotateBySize(): Promise<void> {
        const dir = dirname(this.#file);
        const base = parse(this.#file).name;
        const ext = extname(this.#file);
        const today = new Date().toISOString().slice(0, 10);
        let index = 1;

        try {
            const re = new RegExp(`^${escapeRegExp(base)}-${today}-(\\d+)${escapeRegExp(ext)}$`);
            for (const file of await fs.readdir(dir)) {
                const match = file.match(re);
                if (match) index = Math.max(index, Number(match[1]) + 1);
            }
        } catch {
            // The directory is missing: the rename below reports the real error.
        }

        const target = join(dir, `${base}-${today}-${index}${ext}`);
        await fs.rename(this.#file, target).catch((error) => reportFailure("file logger", error));
        await this.#finishArchive(target);
    }

    async #finishArchive(target: string): Promise<void> {
        if (this.#rotate?.compress) {
            try {
                await pipeline(createReadStream(target), createGzip(), createWriteStream(`${target}.gz`));
                await fs.unlink(target);
            } catch (error) {
                reportFailure("file logger", error);
            }
        }
        await this.#prune();
    }

    #uniqueArchive(candidate: string): string {
        if (!existsSync(candidate)) return candidate;

        const { dir, name, ext } = parse(candidate);
        let index = 1;
        while (existsSync(join(dir, `${name}-${index}${ext}`))) index += 1;
        return join(dir, `${name}-${index}${ext}`);
    }

    async #prune(): Promise<void> {
        const rotate = this.#rotate;
        if (!rotate) return;

        const dir = dirname(this.#file);
        const base = parse(this.#file).name;
        const ext = extname(this.#file);
        const period = rotate.mode === "size" ? `\\d{4}-\\d{2}-\\d{2}-\\d+` : periodPattern(rotate.mode);
        const re = new RegExp(`^${escapeRegExp(base)}-${period}${escapeRegExp(ext)}(?:\\.gz)?$`);

        try {
            let files = (await fs.readdir(dir)).filter((file) => re.test(file));
            if (rotate.mode === "size") {
                const withTime = await Promise.all(
                    files.map(async (file) => ({ file, time: (await fs.stat(join(dir, file))).mtimeMs })),
                );
                files = withTime.sort((a, b) => b.time - a.time).map((entry) => entry.file);
            } else {
                files.sort((a, b) => b.localeCompare(a));
            }

            for (const file of files.slice(rotate.maxFiles)) {
                await fs.unlink(join(dir, file)).catch(() => {});
            }
        } catch {
            // Retention is best effort: never break a log write.
        }
    }
}

class DuckDbSink implements LogSink {
    readonly ready: Promise<void>;
    #appender?: DuckDBAppender;
    #connection?: DuckDBConnection;
    #instance?: DuckDBInstance;
    #pending: GatewayLogEntry[] = [];
    #rows = 0;
    #failed = false;
    #closed = false;
    readonly #ttlMs?: number;
    readonly #purgeEveryMs?: number;
    readonly #purgeOnStart: boolean;
    #purgeTimer?: ReturnType<typeof setInterval>;
    #purgeQueue: Promise<void> = Promise.resolve();

    constructor(file: string, ttlMs?: number, purgeEveryMs?: number, purgeOnStart = true) {
        this.#ttlMs = ttlMs;
        this.#purgeEveryMs = purgeEveryMs;
        this.#purgeOnStart = purgeOnStart;

        try {
            mkdirSync(dirname(file), { recursive: true });
        } catch (error) {
            this.ready = Promise.reject(error);
            this.ready.catch(() => {});
            this.#failed = true;
            return;
        }

        this.ready = this.#init(file);
        this.ready.catch((error) => {
            this.#failed = true;
            reportFailure("duckdb logger", error);
        });
    }

    async #init(file: string): Promise<void> {
        const { DuckDBInstance: Instance } = await import("@duckdb/node-api");
        this.#instance = await Instance.create(file);
        this.#connection = await this.#instance.connect();
        await this.#connection.run(CREATE_LOGS_TABLE);
        this.#appender = await this.#connection.createAppender("logs");

        const pending = this.#pending.splice(0);
        for (const entry of pending) this.#append(entry);

        if (this.#ttlMs) {
            if (this.#purgeOnStart) await this.#purgeNow();
            if (this.#purgeEveryMs) {
                this.#purgeTimer = setInterval(() => {
                    void this.#purgeNow();
                }, this.#purgeEveryMs);
                (this.#purgeTimer as { unref?: () => void }).unref?.();
            }
        }
    }

    #purgeNow(): Promise<void> {
        const run = async (): Promise<void> => {
            if (this.#closed || !this.#ttlMs || !this.#connection) return;

            // Make buffered appender rows visible before deleting.
            this.#appender?.flushSync();
            const cutoff = new Date(Date.now() - this.#ttlMs).toISOString();
            await this.#connection.run(
                "DELETE FROM logs WHERE CAST(timestamp AS TIMESTAMP) < CAST(? AS TIMESTAMP)",
                [cutoff],
            );
        };

        this.#purgeQueue = this.#purgeQueue.then(run).catch((error) => reportFailure("duckdb purge", error));
        return this.#purgeQueue;
    }

    write(entry: GatewayLogEntry): void {
        if (this.#closed || this.#failed) return;

        if (this.#appender) {
            this.#append(entry);
            return;
        }

        this.#pending.push(entry);
        if (this.#pending.length > MAX_PENDING_DUCKDB) this.#pending.shift();
    }

    #append(entry: GatewayLogEntry): void {
        const appender = this.#appender;
        if (!appender || this.#failed) return;

        try {
            const fields: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(entry)) {
                if (!CORE_FIELDS.has(key)) fields[key] = value;
            }

            appender.appendVarchar(entry.timestamp);
            appender.appendVarchar(entry.level);
            appender.appendVarchar(entry.logger);
            appender.appendVarchar(entry.requestId);
            appender.appendVarchar(entry.method);
            appender.appendVarchar(entry.path);
            entry.microservice === undefined ? appender.appendNull() : appender.appendVarchar(entry.microservice);
            entry.upstream === undefined ? appender.appendNull() : appender.appendVarchar(entry.upstream);
            appender.appendInteger(entry.status);
            appender.appendBigInt(BigInt(entry.durationMs));
            appender.appendVarchar(JSON.stringify(fields));
            appender.appendVarchar(JSON.stringify(entry));
            appender.endRow();

            if (++this.#rows >= FLUSH_EVERY) {
                appender.flushSync();
                this.#rows = 0;
            }
        } catch (error) {
            this.#failed = true;
            reportFailure("duckdb logger", error);
        }
    }

    async close(): Promise<void> {
        if (this.#purgeTimer) {
            clearInterval(this.#purgeTimer);
            this.#purgeTimer = undefined;
        }
        this.#closed = true;
        await this.ready.catch(() => {});
        await this.#purgeQueue;

        if (this.#appender && !this.#failed) {
            try {
                this.#appender.flushSync();
                this.#appender.closeSync();
            } catch (error) {
                reportFailure("duckdb logger", error);
            }
        }

        try {
            this.#connection?.closeSync();
        } catch {}
        try {
            this.#instance?.closeSync();
        } catch {}
    }
}

function periodOf(date: Date, mode: Exclude<GatewayLogRotation, "size">): string {
    const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

    if (mode === "yearly") return String(date.getFullYear());
    if (mode === "monthly") return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
    if (mode === "daily") return day;
    if (mode === "hourly") return `${day}-${pad2(date.getHours())}`;

    const week = isoWeek(date);
    return `${week.year}-W${pad2(week.week)}`;
}

function periodPattern(mode: Exclude<GatewayLogRotation, "size">): string {
    if (mode === "hourly") return "\\d{4}-\\d{2}-\\d{2}-\\d{2}";
    if (mode === "daily") return "\\d{4}-\\d{2}-\\d{2}";
    if (mode === "weekly") return "\\d{4}-W\\d{2}";
    if (mode === "monthly") return "\\d{4}-\\d{2}";
    return "\\d{4}";
}

function isoWeek(date: Date): { year: number; week: number } {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNumber = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNumber);
    const year = d.getUTCFullYear();
    const yearStart = Date.UTC(year, 0, 1);
    return { year, week: Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7) };
}

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reportFailure(source: string, error: unknown): void {
    try {
        console.error(`[gateway] ${source} failed: ${(error as Error)?.message ?? String(error)}`);
    } catch {
        // Nothing left to do.
    }
}
