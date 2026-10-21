import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Rotation trigger: size (default) or a calendar period. */
export type LogRotation = 'size' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** ANSI colors (no dependency on @colors/colors import order) */
const CONSOLE_COLORS: Record<LogLevel, string> = {
    debug: '\x1b[90m', // gray
    info: '\x1b[36m',  // cyan
    warn: '\x1b[33m',  // yellow
    error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

export type LoggerOptions = {
    /** Minimum level to emit (default: 'info') */
    level?: LogLevel;
    /** Also write to the console (default: true) */
    console?: boolean;
    /** File logging: `true` → `<dir>/app.log`, `string` → custom path, `false` → disabled (default: true) */
    file?: boolean | string;
    /** Directory used when `file` is `true` (default: '.logs') */
    dir?: string;
    /** Rotation trigger (default: 'size'). Calendar modes ignore `maxSize`. */
    rotate?: LogRotation;
    /** Rotate when the file exceeds this size in bytes — `rotate: 'size'` only (default: 10MB) */
    maxSize?: number;
    /** Keep this many rotated files (default: 5) */
    maxFiles?: number;
};

const DEFAULT_OPTIONS: Required<Pick<LoggerOptions, 'level' | 'console' | 'dir' | 'rotate' | 'maxSize' | 'maxFiles'>> & { file: boolean | string } = {
    level: 'info',
    console: true,
    file: true,
    dir: '.logs',
    rotate: 'size',
    maxSize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** ISO week-numbering year + week (2026-W17). */
function isoWeek(date: Date): { year: number; week: number } {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const year = d.getUTCFullYear();
    const yearStart = Date.UTC(year, 0, 1);
    return { year, week: Math.ceil((((d.getTime() - yearStart) / 86_400_000) + 1) / 7) };
}

/**
 * The rotation period of a date, used both to detect a boundary and to name the
 * archive (`2026-04.log`, `2026-04-18.log`, `2026-W17.log`, `2026-04-18-14.log`, …).
 */
function periodOf(date: Date, rotate: LogRotation): string | null {
    if (rotate === 'size') return null;
    const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    if (rotate === 'yearly') return String(date.getFullYear());
    if (rotate === 'monthly') return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
    if (rotate === 'daily') return day;
    if (rotate === 'hourly') return `${day}-${pad2(date.getHours())}`;
    const week = isoWeek(date);
    return `${week.year}-W${pad2(week.week)}`;
}

function safeStringify(value: unknown): string {
    if (value === undefined) return '';
    try {
        const seen = new WeakSet();
        return JSON.stringify(value, (_key, v) => {
            if (typeof v === 'bigint') return String(v);
            if (v && typeof v === 'object') {
                if (seen.has(v)) return '[Circular]';
                seen.add(v);
            }
            return v;
        });
    } catch {
        return String(value);
    }
}

class Logger {
    #options: LoggerOptions & typeof DEFAULT_OPTIONS;
    #filePath: string = '';
    /** Period the live file belongs to (calendar modes only). */
    #period: string = '';
    #size = 0;
    #pending: Promise<void>[] = [];
    #queue: Promise<void> = Promise.resolve();

    constructor(options: LoggerOptions = {}) {
        this.#options = { ...DEFAULT_OPTIONS, ...options };
    }

    /** Serialize file operations (appends + renames) — preserves order, no races */
    #enqueue(fn: () => Promise<void>) {
        this.#queue = this.#queue.then(fn).catch(() => {});
        this.#pending.push(this.#queue);
    }

    /** (Re)configure — each call is independent: unspecified options reset to defaults */
    configure(options: LoggerOptions = {}) {
        this.#options = { ...DEFAULT_OPTIONS, ...options };
        this.#openFile();
    }

    #resolvePath(): string {
        const file = this.#options.file;
        if (typeof file === 'string') return file;
        const dir = this.#options.dir;
        // Keep relative dirs explicit (`./logs`), but never double-prefix
        // dot-dirs (`.logs`, `./logs`, `../logs`) or absolute paths
        const prefix = /^(\/|\.|[A-Za-z]:)/.test(dir) ? dir : `./${dir}`;
        return `${prefix}/app.log`;
    }

    #openFile() {
        if (!this.#options.file) {
            this.#filePath = '';
            this.#size = 0;
            this.#period = '';
            return;
        }
        this.#filePath = this.#resolvePath();
        fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
        const rotate = this.#options.rotate;
        try {
            const stat = fs.statSync(this.#filePath);
            this.#size = stat.size;
            // The live file may be from a previous period (server restart): its mtime
            // tells us when it was last written, so the next write archives it under
            // that period instead of mixing two months in one file.
            this.#period = rotate === 'size' || stat.size === 0
                ? ''
                : periodOf(stat.mtime, rotate) ?? '';
        } catch {
            this.#size = 0;
            this.#period = '';
        }
    }

    /** Archive-name matcher for the active rotation mode (retention only). */
    #archivePattern(): RegExp {
        switch (this.#options.rotate) {
            case 'hourly': return /^\d{4}-\d{2}-\d{2}-\d{2}\.log$/;
            case 'daily': return /^\d{4}-\d{2}-\d{2}\.log$/;
            case 'weekly': return /^\d{4}-W\d{2}\.log$/;
            case 'monthly': return /^\d{4}-\d{2}\.log$/;
            case 'yearly': return /^\d{4}\.log$/;
            case 'size':
            default: return /^\d{4}-\d{2}-\d{2}-\d+\.log$/;
        }
    }

    /** Keep only the `maxFiles` most recent archives matching the active pattern. */
    #prune(dir: string): Promise<void> {
        const { maxFiles } = this.#options;
        const re = this.#archivePattern();
        return (async () => {
            try {
                let files = (await fs.promises.readdir(dir)).filter((file) => re.test(file));
                if (this.#options.rotate === 'size') {
                    const withTime = await Promise.all(
                        files.map(async (file) => ({
                            file,
                            time: (await fs.promises.stat(path.join(dir, file))).mtimeMs,
                        })),
                    );
                    withTime.sort((a, b) => b.time - a.time);
                    files = withTime.map((entry) => entry.file);
                } else {
                    // Calendar names are chronological (zero-padded): sort by name,
                    // not mtime — a renamed archive keeps the old file's mtime.
                    files.sort((a, b) => b.localeCompare(a));
                }
                for (const file of files.slice(maxFiles)) {
                    await fs.promises.unlink(path.join(dir, file)).catch(() => {});
                }
            } catch {
                // Retention is best-effort: never break a log write
            }
        })();
    }

    /** Rename the live file to its period archive (`2026-04.log`), then prune. */
    #rotateToPeriod(filePath: string, period: string) {
        this.#enqueue(async () => {
            const dir = path.dirname(filePath);
            await fs.promises.rename(filePath, path.join(dir, `${period}.log`)).catch(() => {});
            await this.#prune(dir);
        });
    }

    /** Size rotation: `2026-04-18-1.log`, `-2`, … (index resets per day). */
    #rotateBySize(filePath: string) {
        this.#enqueue(async () => {
            const dir = path.dirname(filePath);
            const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            let index = 1;
            try {
                const re = new RegExp(`^${today}-(\\d+)\\.log$`);
                for (const file of await fs.promises.readdir(dir)) {
                    const match = file.match(re);
                    if (match) index = Math.max(index, parseInt(match[1]!, 10) + 1);
                }
            } catch {}
            await fs.promises.rename(filePath, path.join(dir, `${today}-${index}.log`)).catch(() => {});
            await this.#prune(dir);
        });
    }

    #write(level: LogLevel, msg: string, meta?: unknown, opts: { console?: boolean } = {}) {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#options.level]) return;

        const tsLocal = new Date().toLocaleTimeString('en-GB', { hour12: false });
        const ts = Date.now() / 1000;
        const date = new Date().toISOString(); // ISO 8601 — YYYY-MM-DDTHH:mm:ss.sssZ
        const pad = level.toUpperCase().padEnd(5);
        const isPlain = (v: any): boolean =>
            v !== null && typeof v === 'object' && !Array.isArray(v)
            && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

        // JSONL payload (file): Caddy-style envelope + user meta (user keys win)
        const payload: Record<string, unknown> = { ts, date, level, msg };
        if (isPlain(meta)) {
            Object.assign(payload, meta);
        } else if (meta !== undefined && meta !== null) {
            payload.value = meta;
        }

        // Console (human-readable, colorized) — skipped when opts.console === false
        if (this.#options.console && opts.console !== false) {
            const metaStr = safeStringify(meta);
            const color = CONSOLE_COLORS[level];
            const line = `[${tsLocal}] ${color}${pad}${RESET} ${msg}${metaStr ? ` ${metaStr}` : ''}`;
            if (level === 'error') console.error(line);
            else if (level === 'warn') console.warn(line);
            else console.log(line);
        }

        // File: pure JSONL — one JSON object per line
        if (!this.#filePath) return;
        const line = safeStringify(payload) + '\n';
        const bytes = Buffer.byteLength(line);
        const filePath = this.#filePath;
        const rotate = this.#options.rotate;

        if (rotate !== 'size') {
            const current = periodOf(new Date(), rotate)!;
            if (this.#period && current !== this.#period) {
                // The live file holds the previous period — archive it under its own name.
                this.#size = 0;
                this.#rotateToPeriod(filePath, this.#period);
                this.#period = current;
            } else if (!this.#period) {
                this.#period = current;
            }
        } else if (this.#size + bytes > this.#options.maxSize) {
            this.#size = 0;
            this.#rotateBySize(filePath);
        }

        this.#size += bytes;
        this.#enqueue(() => fs.promises.appendFile(filePath, line));
    }

    debug(msg: string, meta?: unknown) { this.#write('debug', msg, meta); }
    info(msg: string, meta?: unknown) { this.#write('info', msg, meta); }
    warn(msg: string, meta?: unknown) { this.#write('warn', msg, meta); }
    error(msg: string, meta?: unknown) { this.#write('error', msg, meta); }

    /**
     * Write to the file only (no console output) — for framework-internal events
     * (access log, MCP operations, slow queries) that would clutter the terminal.
     * Level defaults to 'info'; `file('warn', msg, meta)` keeps the level.
     */
    file(msg: string, meta?: unknown): void;
    file(level: LogLevel, msg: string, meta?: unknown): void;
    file(levelOrMsg: LogLevel | string, msgOrMeta?: unknown, meta?: unknown): void {
        if (levelOrMsg === 'debug' || levelOrMsg === 'info' || levelOrMsg === 'warn' || levelOrMsg === 'error') {
            this.#write(levelOrMsg, msgOrMeta as string, meta, { console: false });
        } else {
            this.#write('info', levelOrMsg, msgOrMeta, { console: false });
        }
    }

    /** Current log file path (empty when file logging is disabled) */
    get filePath(): string { return this.#filePath; }

    /** Wait until every pending write is on disk */
    async flush(): Promise<void> {
        while (this.#pending.length) {
            const batch = this.#pending;
            this.#pending = [];
            await Promise.all(batch);
        }
    }

    /** Fire-and-forget flush (used at shutdown) */
    close() {
        void this.flush();
    }
}

/** Singleton — console + file. Configured at boot from `cfg.server.logging`. */
export const logger = new Logger({ console: true, file: false });

export default logger;
