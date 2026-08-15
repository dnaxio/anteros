import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

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
    /** File logging: `true` → `<dir>/anteros.log`, `string` → custom path, `false` → disabled (default: true) */
    file?: boolean | string;
    /** Directory used when `file` is `true` (default: '.logs') */
    dir?: string;
    /** Rotate when the file exceeds this size in bytes (default: 10MB) */
    maxSize?: number;
    /** Keep this many rotated files (default: 5) */
    maxFiles?: number;
};

const DEFAULT_OPTIONS: Required<Pick<LoggerOptions, 'level' | 'console' | 'dir' | 'maxSize' | 'maxFiles'>> & { file: boolean | string } = {
    level: 'info',
    console: true,
    file: true,
    dir: '.logs',
    maxSize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
};

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
        return `${prefix}/anteros.log`;
    }

    #openFile() {
        if (!this.#options.file) {
            this.#filePath = '';
            this.#size = 0;
            return;
        }
        this.#filePath = this.#resolvePath();
        fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
        try {
            this.#size = fs.statSync(this.#filePath).size;
        } catch {
            this.#size = 0;
        }
    }

    #rotate(filePath: string) {
        const { maxFiles } = this.#options;
        this.#enqueue(async () => {
            const dir = path.dirname(filePath);
            const ext = path.extname(filePath);
            const base = path.basename(filePath, ext);
            const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

            // Dated rotation name: anteros-2026-07-08-1.log, -2, … (index resets per day)
            let n = 1;
            try {
                const files = await fs.promises.readdir(dir);
                const re = new RegExp(`^${esc(base)}-${today}-(\\d+)${esc(ext)}$`);
                for (const f of files) {
                    const m = f.match(re);
                    if (m) n = Math.max(n, parseInt(m[1]!, 10) + 1);
                }
            } catch {}
            await fs.promises.rename(filePath, path.join(dir, `${base}-${today}-${n}${ext}`)).catch(() => {});

            // Prune: keep only the maxFiles most recent rotated files
            try {
                const re = new RegExp(`^${esc(base)}-\\d{4}-\\d{2}-\\d{2}-\\d+${esc(ext)}$`);
                const files = (await fs.promises.readdir(dir)).filter((f) => re.test(f));
                const withTime = await Promise.all(
                    files.map(async (f) => ({ f, t: (await fs.promises.stat(path.join(dir, f))).mtimeMs }))
                );
                withTime.sort((a, b) => b.t - a.t);
                for (const { f } of withTime.slice(maxFiles)) {
                    await fs.promises.unlink(path.join(dir, f)).catch(() => {});
                }
            } catch {}
        });
    }

    #write(level: LogLevel, msg: string, meta?: unknown, opts: { console?: boolean } = {}) {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#options.level]) return;

        const tsLocal = new Date().toLocaleTimeString('en-GB', { hour12: false });
        const ts = Date.now() / 1000;
        const pad = level.toUpperCase().padEnd(5);
        const isPlain = (v: any): boolean =>
            v !== null && typeof v === 'object' && !Array.isArray(v)
            && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

        // JSONL payload (file): Caddy-style envelope + user meta (user keys win)
        const payload: Record<string, unknown> = { ts, level, msg };
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
        if (this.#size + bytes > this.#options.maxSize) {
            this.#size = 0;
            this.#rotate(filePath);
        }
        this.#size += bytes;
        this.#enqueue(() => fs.promises.appendFile(filePath, line));
    }

    debug(msg: string, meta?: unknown) { this.#write('debug', msg, meta); }
    info(msg: string, meta?: unknown) { this.#write('info', msg, meta); }
    warn(msg: string, meta?: unknown) { this.#write('warn', msg, meta); }
    error(msg: string, meta?: unknown) { this.#write('error', msg, meta); }

    /** Write to the file only (no console output) — for events that would clutter the terminal */
    file(msg: string, meta?: unknown) { this.#write('info', msg, meta, { console: false }); }

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
