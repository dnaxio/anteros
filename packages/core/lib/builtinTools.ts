import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import Joi from "joi";
import { AppError } from "./error";
import type { AgentTool, BuiltinToolName, BuiltinToolsOptions } from "../types/agent";

/**
 * The **built-in tools** an agent may opt into (`define.Agent({ builtinTools })`).
 *
 * They are **off by default**, because they are powerful: `shell`, `bun` and `spawn`
 * run code with the process's own permissions, and the file tools read and write the
 * workspace. A coding agent enables what it needs; a support agent enables nothing.
 *
 * Every path-taking tool is **confined to a workspace root** (`builtinToolsOptions.root`,
 * default `process.cwd()`): a path that resolves outside it — or a symlink that leads
 * outside — is refused with `BUILTIN_TOOL_PATH_ESCAPE`. That confinement does **not**
 * apply to a command: `shell`, `bun` and `spawn` only use the root as their `cwd`.
 */

export const BUILTIN_TOOL_NAMES: readonly BuiltinToolName[] = [
    "bun",
    "shell",
    "read_file",
    "write_file",
    "edit_file",
    "grep",
    "ls",
    "image",
    "spawn",
    "browser_control",
    "archive_file",
];

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_READ = 500_000;
const DEFAULT_MAX_OUTPUT = 200_000;
const MAX_LIST = 500;
const MAX_MATCHES = 200;
const MAX_SCAN_FILES = 20_000;
const MAX_GREP_FILE = 1_000_000;
const MAX_ARCHIVE_ENTRIES = 2_000;
/** Directories a workspace walk never descends into. */
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".output", ".nuxt", ".cache", "coverage"]);

type Resolved = {
    root: string;
    realRoot: string;
    timeoutMs: number;
    maxRead: number;
    maxOutput: number;
    browser: { backend?: "webkit" | "chrome"; width: number; height: number };
};

function resolveOptions(options: BuiltinToolsOptions = {}): Resolved {
    const root = resolve(options.root ?? process.cwd());
    let realRoot = root;
    try { realRoot = realpathSync(root); } catch { /* the root may not exist yet */ }
    return {
        root,
        realRoot,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRead: options.maxReadBytes ?? DEFAULT_MAX_READ,
        maxOutput: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
        browser: {
            ...(options.browser?.backend ? { backend: options.browser.backend } : {}),
            width: options.browser?.width ?? 1024,
            height: options.browser?.height ?? 768,
        },
    };
}

function fail(code: string, message: string): never {
    throw new AppError(message, { status: 400, code });
}

function isInside(root: string, abs: string): boolean {
    return abs === root || abs.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * A path inside the workspace, or `BUILTIN_TOOL_PATH_ESCAPE`.
 *
 * `resolve()` alone would let a symlink point outside the root, so the real path of
 * the target (or of its closest existing parent, for a file about to be created) is
 * checked as well.
 */
function resolveInside(options: Resolved, path: string | undefined, label = "path"): string {
    const value = typeof path === "string" ? path.trim() : "";
    if (!value) fail("BUILTIN_TOOL_PATH_REQUIRED", `\`${label}\` is required`);

    const abs = resolve(options.root, value);
    if (!isInside(options.root, abs)) {
        fail("BUILTIN_TOOL_PATH_ESCAPE", `'${value}' is outside the workspace (${options.root})`);
    }

    let probe = abs;
    while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);

    // The check stays **outside** the try: `fail()` throws, and a bare catch around it
    // would swallow the refusal (a symlink would then be followed happily).
    let real: string | null = null;
    try { real = realpathSync(probe); } catch { /* vanished — the resolve() check still holds */ }
    if (real && !isInside(options.realRoot, real) && !isInside(options.root, real)) {
        fail("BUILTIN_TOOL_PATH_ESCAPE", `'${value}' resolves outside the workspace through a symlink`);
    }

    return abs;
}

function relativeTo(options: Resolved, abs: string): string {
    const value = relative(options.root, abs);
    return value === "" ? "." : value;
}

function cap(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} characters truncated)` : text;
}

/* ------------------------------------------------------------------ */
/* Processes                                                          */
/* ------------------------------------------------------------------ */

type RunResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };

async function run(
    argv: string[],
    options: Resolved,
    extra: { cwd?: string; timeoutMs?: number; stdin?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
    let proc: any;
    try {
        proc = Bun.spawn(argv, {
            cwd: extra.cwd ?? options.root,
            stdin: extra.stdin === undefined ? "ignore" : "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: extra.env ? { ...process.env, ...extra.env } : process.env,
        });
    } catch (error: any) {
        fail("BUILTIN_TOOL_SPAWN_FAILED", `Cannot run '${argv[0]}': ${error?.message ?? error}`);
    }

    if (extra.stdin !== undefined && proc.stdin) {
        try {
            proc.stdin.write(extra.stdin);
            await proc.stdin.end();
        } catch { /* the child may have exited already */ }
    }

    let timedOut = false;
    const timeoutMs = extra.timeoutMs ?? options.timeoutMs;
    const timer = setTimeout(() => {
        timedOut = true;
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    (timer as any)?.unref?.();

    try {
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        return {
            exitCode: exitCode ?? null,
            stdout: cap(stdout, options.maxOutput),
            stderr: cap(stderr, options.maxOutput),
            timedOut,
        };
    } finally {
        clearTimeout(timer);
    }
}

function render(result: RunResult): string {
    const parts: string[] = [];
    parts.push(result.timedOut ? "timed out (killed)" : `exit code: ${result.exitCode}`);
    if (result.stdout) parts.push(`--- stdout ---\n${result.stdout.replace(/\s+$/, "")}`);
    if (result.stderr) parts.push(`--- stderr ---\n${result.stderr.replace(/\s+$/, "")}`);
    if (!result.stdout && !result.stderr) parts.push("(no output)");
    return parts.join("\n");
}

/* ------------------------------------------------------------------ */
/* Filesystem helpers                                                 */
/* ------------------------------------------------------------------ */

function assertFile(abs: string, path: string): void {
    let stat;
    try { stat = statSync(abs); } catch { fail("BUILTIN_TOOL_NOT_FOUND", `No such file: '${path}'`); }
    if (stat!.isDirectory()) fail("BUILTIN_TOOL_NOT_A_FILE", `'${path}' is a directory`);
}

function readTextFile(options: Resolved, path: string): string {
    const abs = resolveInside(options, path);
    assertFile(abs, path);
    const size = statSync(abs).size;
    if (size > options.maxRead) {
        fail("BUILTIN_TOOL_FILE_TOO_LARGE", `'${path}' is ${size} bytes (limit ${options.maxRead}) — use \`grep\` or \`shell\` to read a slice`);
    }
    const text = readFileSync(abs, "utf8");
    if (text.includes("\0")) fail("BUILTIN_TOOL_BINARY_FILE", `'${path}' looks like a binary file`);
    return text;
}

function walk(base: string, pattern: string): string[] {
    const files: string[] = [];
    try {
        const glob = new Bun.Glob(pattern);
        for (const entry of glob.scanSync({ cwd: base, dot: false, absolute: true, followSymlinks: false })) {
            if (files.length >= MAX_SCAN_FILES) break;
            const parts = entry.split(sep);
            if (parts.some((part) => IGNORED_DIRS.has(part))) continue;
            try { if (statSync(entry).isFile()) files.push(entry); } catch { /* vanished */ }
        }
    } catch { /* an empty/missing directory scans to nothing */ }
    return files;
}

function truncateLine(text: string, max = 400): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* ------------------------------------------------------------------ */
/* Browser (Bun.WebView)                                              */
/* ------------------------------------------------------------------ */

let view: any = null;

function browserView(options: Resolved): any {
    const WebView = (Bun as any).WebView;
    if (typeof WebView !== "function") {
        fail("BUILTIN_TOOL_BROWSER_UNAVAILABLE", "Bun.WebView is not available in this runtime (Bun 1.4.4+ required)");
    }
    if (!view) {
        try {
            view = new WebView({ width: options.browser.width, height: options.browser.height, backend: options.browser.backend });
        } catch (error: any) {
            fail("BUILTIN_TOOL_BROWSER_UNAVAILABLE", `Cannot open a browser view: ${error?.message ?? error}`);
        }
    }
    return view;
}

/* ------------------------------------------------------------------ */
/* The tools                                                          */
/* ------------------------------------------------------------------ */

export function builtinToolsFor(
    names: boolean | readonly BuiltinToolName[] | undefined,
    options?: BuiltinToolsOptions,
): AgentTool[] {
    if (!names) return [];
    const wanted = new Set<BuiltinToolName>(names === true ? BUILTIN_TOOL_NAMES : names);
    const resolved = resolveOptions(options);
    const tools: AgentTool[] = [];

    if (wanted.has("read_file")) tools.push({
        id: "read_file",
        readOnly: true,
        description: "Read a UTF-8 text file inside the workspace. Returns its content, optionally a range of lines.",
        inputSchema: Joi.object({
            path: Joi.string().required().description("File path, relative to the workspace root"),
            offset: Joi.number().integer().min(0).default(0).description("First line to return (0-based)"),
            limit: Joi.number().integer().min(1).max(5000).default(2000).description("Maximum lines to return"),
        }),
        execute: async (input: any) => {
            const text = readTextFile(resolved, input.path);
            const lines = text.split("\n");
            const offset = input.offset ?? 0;
            const limit = input.limit ?? 2000;
            const slice = lines.slice(offset, offset + limit);
            const suffix = offset + slice.length < lines.length
                ? `\n… (${lines.length - offset - slice.length} more lines — raise \`offset\`)`
                : "";
            return slice.join("\n") + suffix;
        },
    });

    if (wanted.has("write_file")) tools.push({
        id: "write_file",
        description: "Write a UTF-8 file inside the workspace, creating its parent directories. Replaces the whole file.",
        inputSchema: Joi.object({
            path: Joi.string().required().description("File path, relative to the workspace root"),
            content: Joi.string().allow("").required().description("The complete new content"),
        }),
        execute: async (input: any) => {
            const abs = resolveInside(resolved, input.path);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, input.content, "utf8");
            return `Wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${relativeTo(resolved, abs)}`;
        },
    });

    if (wanted.has("edit_file")) tools.push({
        id: "edit_file",
        description: "Replace an exact string in a workspace file. Fails when the string is absent, and when it is ambiguous unless `replace_all` is set.",
        inputSchema: Joi.object({
            path: Joi.string().required(),
            old_string: Joi.string().required().description("The exact text to replace"),
            new_string: Joi.string().allow("").required().description("The replacement text"),
            replace_all: Joi.boolean().default(false),
        }),
        execute: async (input: any) => {
            const abs = resolveInside(resolved, input.path);
            const before = readTextFile(resolved, input.path);
            const oldString = input.old_string;
            const occurrences = before.split(oldString).length - 1;
            if (occurrences === 0) fail("BUILTIN_TOOL_EDIT_NOT_FOUND", `'${input.path}' does not contain the requested text`);
            if (occurrences > 1 && !input.replace_all) {
                fail("BUILTIN_TOOL_EDIT_AMBIGUOUS", `The text appears ${occurrences} times in '${input.path}' — pass \`replace_all: true\` or a longer excerpt`);
            }
            const after = input.replace_all
                ? before.split(oldString).join(input.new_string)
                : before.replace(oldString, input.new_string);
            writeFileSync(abs, after, "utf8");
            return `Replaced ${input.replace_all ? occurrences : 1} occurrence(s) in ${relativeTo(resolved, abs)}`;
        },
    });

    if (wanted.has("ls")) tools.push({
        id: "ls",
        readOnly: true,
        description: "List files and directories inside the workspace (`recursive` walks the tree; `glob` filters, e.g. `src/**/*.ts`).",
        inputSchema: Joi.object({
            path: Joi.string().default(".").description("Directory to list, relative to the workspace root"),
            recursive: Joi.boolean().default(false),
            glob: Joi.string().description("Glob filter — implies `recursive`"),
        }),
        execute: async (input: any) => {
            const base = resolveInside(resolved, input.path ?? ".");
            if (!existsSync(base)) fail("BUILTIN_TOOL_NOT_FOUND", `No such directory: '${input.path}'`);
            if (!statSync(base).isDirectory()) fail("BUILTIN_TOOL_NOT_A_DIRECTORY", `'${input.path}' is not a directory`);

            const entries: string[] = [];
            if (input.glob) {
                const glob = new Bun.Glob(input.glob);
                for (const entry of glob.scanSync({ cwd: base, dot: true, absolute: true, followSymlinks: false })) {
                    if (entries.length >= MAX_LIST) break;
                    if (entry.split(sep).some((part) => IGNORED_DIRS.has(part))) continue;
                    entries.push(`${relativeTo(resolved, entry)}${statSync(entry).isDirectory() ? "/" : ""}`);
                }
            } else if (input.recursive) {
                for (const entry of walk(base, "**/*")) {
                    if (entries.length >= MAX_LIST) break;
                    entries.push(relativeTo(resolved, entry));
                }
            } else {
                for (const entry of readdirSync(base, { withFileTypes: true })) {
                    if (entries.length >= MAX_LIST) break;
                    if (IGNORED_DIRS.has(entry.name)) continue;
                    const abs = join(base, entry.name);
                    entries.push(`${relativeTo(resolved, abs)}${entry.isDirectory() ? "/" : ""}`);
                }
            }
            if (!entries.length) return "(empty)";
            const suffix = entries.length >= MAX_LIST ? `\n… (stopped at ${MAX_LIST} entries)` : "";
            return entries.sort().join("\n") + suffix;
        },
    });

    if (wanted.has("grep")) tools.push({
        id: "grep",
        readOnly: true,
        description: "Search the workspace for a regular expression (or a fixed string). Returns `file:line: text` matches.",
        inputSchema: Joi.object({
            pattern: Joi.string().required().description("Regular expression, or a literal string when `fixed` is set"),
            path: Joi.string().default(".").description("Directory to search, relative to the workspace root"),
            glob: Joi.string().default("**/*").description("Files to scan"),
            ignore_case: Joi.boolean().default(false),
            fixed: Joi.boolean().default(false).description("Treat `pattern` as a literal string"),
            max_results: Joi.number().integer().min(1).max(2000).default(MAX_MATCHES),
        }),
        execute: async (input: any) => {
            const base = resolveInside(resolved, input.path ?? ".");
            if (!existsSync(base)) fail("BUILTIN_TOOL_NOT_FOUND", `No such directory: '${input.path}'`);

            let expression: RegExp;
            try {
                const source = input.fixed ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : input.pattern;
                expression = new RegExp(source, input.ignore_case ? "i" : "");
            } catch (error: any) {
                fail("BUILTIN_TOOL_INVALID_PATTERN", `Invalid pattern: ${error?.message ?? error}`);
            }

            const matches: string[] = [];
            const limit = input.max_results ?? MAX_MATCHES;
            for (const file of walk(base, input.glob ?? "**/*")) {
                if (matches.length >= limit) break;
                let size = 0;
                try { size = statSync(file).size; } catch { continue; }
                if (size > MAX_GREP_FILE) continue;

                let text = "";
                try { text = readFileSync(file, "utf8"); } catch { continue; }
                if (text.includes("\0")) continue;

                const lines = text.split("\n");
                for (let index = 0; index < lines.length; index++) {
                    const line = lines[index]!;
                    if (!expression.test(line)) continue;
                    matches.push(`${relativeTo(resolved, file)}:${index + 1}: ${truncateLine(line)}`);
                    if (matches.length >= limit) break;
                }
            }

            if (!matches.length) return "No match";
            const suffix = matches.length >= limit ? `\n… (stopped at ${limit} matches)` : "";
            return matches.join("\n") + suffix;
        },
    });

    if (wanted.has("shell")) tools.push({
        id: "shell",
        description: "Run a shell command in the workspace root (`/bin/sh -c`, `cmd /c` on Windows) and return its exit code, stdout and stderr.",
        inputSchema: Joi.object({
            command: Joi.string().required(),
            timeout_ms: Joi.number().integer().min(100).max(600_000).description("Kill the command after this many milliseconds"),
        }),
        execute: async (input: any) => {
            const argv = process.platform === "win32"
                ? ["cmd.exe", "/d", "/s", "/c", input.command]
                : ["/bin/sh", "-c", input.command];
            return render(await run(argv, resolved, { timeoutMs: input.timeout_ms, cwd: resolved.root }));
        },
    });

    if (wanted.has("bun")) tools.push({
        id: "bun",
        description: "Run a Bun/TypeScript snippet (`bun -e`) in the workspace root and return its output.",
        inputSchema: Joi.object({
            code: Joi.string().required().description("The program source"),
            timeout_ms: Joi.number().integer().min(100).max(600_000),
        }),
        execute: async (input: any) =>
            render(await run([process.execPath, "-e", input.code], resolved, { timeoutMs: input.timeout_ms })),
    });

    if (wanted.has("spawn")) tools.push({
        id: "spawn",
        description: "Run a program with an argument array — no shell, so nothing is interpreted. Returns its exit code and output.",
        inputSchema: Joi.object({
            command: Joi.string().required(),
            args: Joi.array().items(Joi.string()).default([]),
            cwd: Joi.string().description("Working directory, relative to the workspace root"),
            stdin: Joi.string().description("Text written to the child's stdin"),
            env: Joi.object().pattern(Joi.string(), Joi.string()).description("Extra environment variables"),
            timeout_ms: Joi.number().integer().min(100).max(600_000),
        }),
        execute: async (input: any) => {
            const cwd = input.cwd ? resolveInside(resolved, input.cwd, "cwd") : resolved.root;
            return render(await run([input.command, ...(input.args ?? [])], resolved, {
                cwd,
                stdin: input.stdin,
                env: input.env,
                timeoutMs: input.timeout_ms,
            }));
        },
    });

    if (wanted.has("image")) tools.push({
        id: "image",
        description: "Inspect an image (size, format), or resize/convert it — the result is written to the workspace or returned as an image the model can see.",
        inputSchema: Joi.object({
            path: Joi.string().required().description("Source image, relative to the workspace root"),
            width: Joi.number().integer().min(1).max(16384),
            height: Joi.number().integer().min(1).max(16384),
            format: Joi.string().valid("png", "jpeg", "webp"),
            quality: Joi.number().integer().min(1).max(100).default(80),
            output: Joi.string().description("Where to write the result, inside the workspace — omit to return it to the model"),
        }),
        execute: async (input: any) => {
            const abs = resolveInside(resolved, input.path);
            assertFile(abs, input.path);

            const Image = (Bun as any).Image;
            if (typeof Image !== "function") {
                fail("BUILTIN_TOOL_IMAGE_UNAVAILABLE", "Bun.Image is not available in this runtime (Bun 1.4.4+ required)");
            }

            const image = new Image(Bun.file(abs));
            const metadata = await image.metadata();

            if (!input.width && !input.height && !input.format && !input.output) {
                return `${metadata.format} ${metadata.width}x${metadata.height}`;
            }

            const resized = input.width || input.height
                ? image.resize(input.width ?? metadata.width, input.height, { fit: "inside", withoutEnlargement: true })
                : image;

            const format = input.format ?? metadata.format;
            const encoded = format === "jpeg" ? resized.jpeg({ quality: input.quality })
                : format === "webp" ? resized.webp({ quality: input.quality })
                    : resized.png();

            if (input.output) {
                const out = resolveInside(resolved, input.output, "output");
                mkdirSync(dirname(out), { recursive: true });
                const bytes = await encoded.write(out);
                return `Wrote ${bytes} bytes to ${relativeTo(resolved, out)} (${format})`;
            }

            const buffer = await encoded.toBuffer();
            const mime = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
            return {
                content: [
                    { type: "text" as const, text: `${format} ${buffer.length} bytes (from ${metadata.width}x${metadata.height})` },
                    { type: "image" as const, data: buffer.toString("base64"), mimeType: mime },
                ],
            };
        },
    });

    if (wanted.has("browser_control")) tools.push({
        id: "browser_control",
        description: "Drive a real browser (Bun.WebView): open a URL, evaluate JavaScript, click, type, press a key, scroll, take a screenshot.",
        inputSchema: Joi.object({
            action: Joi.string().valid(
                "open", "evaluate", "screenshot", "click", "type", "press", "scroll",
                "reload", "back", "forward", "close",
            ).required(),
            url: Joi.string().description("`open`: the URL (or a data: URL)"),
            script: Joi.string().description("`evaluate`: an expression, awaited page-side"),
            selector: Joi.string().description("`click`: CSS selector (alternative to x/y)"),
            x: Joi.number().description("`click`: viewport x"),
            y: Joi.number().description("`click`: viewport y"),
            text: Joi.string().description("`type`: text to type"),
            key: Joi.string().description("`press`: key name (Enter, Tab, ArrowDown…)"),
            dx: Joi.number().description("`scroll`: horizontal delta"),
            dy: Joi.number().description("`scroll`: vertical delta"),
            path: Joi.string().description("`screenshot`: write the image to the workspace"),
            format: Joi.string().valid("png", "jpeg", "webp").default("png"),
        }),
        execute: async (input: any) => {
            const page = browserView(resolved);
            switch (input.action) {
                case "open": {
                    if (!input.url) fail("BUILTIN_TOOL_BROWSER_URL_REQUIRED", "`open` needs `url`");
                    await page.navigate(input.url);
                    return `${page.url}\n${page.title}`;
                }
                case "evaluate": {
                    if (!input.script) fail("BUILTIN_TOOL_BROWSER_SCRIPT_REQUIRED", "`evaluate` needs `script`");
                    const value = await page.evaluate(input.script);
                    return cap(typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "undefined", resolved.maxOutput);
                }
                case "screenshot": {
                    if (input.path) {
                        const out = resolveInside(resolved, input.path);
                        mkdirSync(dirname(out), { recursive: true });
                        const buffer = await page.screenshot({ encoding: "buffer", format: input.format });
                        writeFileSync(out, buffer);
                        return `Wrote ${buffer.length} bytes to ${relativeTo(resolved, out)}`;
                    }
                    const base64 = await page.screenshot({ encoding: "base64", format: input.format });
                    const mime = input.format === "jpeg" ? "image/jpeg" : input.format === "webp" ? "image/webp" : "image/png";
                    return { content: [{ type: "image" as const, data: base64, mimeType: mime }] };
                }
                case "click": {
                    if (input.selector) await page.click(input.selector);
                    else if (typeof input.x === "number" && typeof input.y === "number") await page.click(input.x, input.y);
                    else fail("BUILTIN_TOOL_BROWSER_TARGET_REQUIRED", "`click` needs `selector` or `x`/`y`");
                    return "clicked";
                }
                case "type": {
                    if (!input.text) fail("BUILTIN_TOOL_BROWSER_TEXT_REQUIRED", "`type` needs `text`");
                    await page.type(input.text);
                    return "typed";
                }
                case "press": {
                    if (!input.key) fail("BUILTIN_TOOL_BROWSER_KEY_REQUIRED", "`press` needs `key`");
                    await page.press(input.key);
                    return "pressed";
                }
                case "scroll":
                    await page.scroll(input.dx ?? 0, input.dy ?? 0);
                    return "scrolled";
                case "reload":
                    await page.reload();
                    return `${page.url}`;
                case "back":
                    await page.goBack();
                    return `${page.url}`;
                case "forward":
                    await page.goForward();
                    return `${page.url}`;
                case "close":
                    try { page.close(); } catch { /* already closed */ }
                    view = null;
                    return "closed";
                default:
                    fail("BUILTIN_TOOL_BROWSER_ACTION", `Unknown action '${input.action}'`);
            }
        },
    });

    if (wanted.has("archive_file")) tools.push({
        id: "archive_file",
        description: "Create, list or extract a tar / tar.gz archive inside the workspace (Bun.Archive; zip is not supported).",
        inputSchema: Joi.object({
            action: Joi.string().valid("create", "list", "extract").required(),
            path: Joi.string().required().description("The archive, relative to the workspace root"),
            files: Joi.array().items(Joi.string()).description("`create`: files to add (relative to the workspace root, or to `base`)"),
            glob: Joi.string().description("`create`: files to add by pattern; `list`/`extract`: entries to keep"),
            base: Joi.string().default(".").description("`create`: directory the file names are relative to"),
            destination: Joi.string().description("`extract`: target directory"),
            compress: Joi.string().valid("gzip").description("`create`: gzip the tar"),
        }),
        execute: async (input: any) => {
            const Archive = (Bun as any).Archive;
            if (typeof Archive !== "function") {
                fail("BUILTIN_TOOL_ARCHIVE_UNAVAILABLE", "Bun.Archive is not available in this runtime (Bun 1.4.4+ required)");
            }
            const archivePath = resolveInside(resolved, input.path);

            if (input.action === "create") {
                const base = resolveInside(resolved, input.base ?? ".");
                const sources: string[] = [];

                if (input.files?.length) {
                    for (const file of input.files) sources.push(resolveInside(resolved, file, "files"));
                }
                if (input.glob) {
                    const glob = new Bun.Glob(input.glob);
                    for (const entry of glob.scanSync({ cwd: base, dot: false, absolute: true, followSymlinks: false })) {
                        if (sources.length >= MAX_ARCHIVE_ENTRIES) break;
                        try { if (statSync(entry).isFile()) sources.push(entry); } catch { /* vanished */ }
                    }
                }
                if (!sources.length) fail("BUILTIN_TOOL_ARCHIVE_EMPTY", "Nothing to archive — pass `files` or `glob`");

                const entries: Record<string, Uint8Array> = {};
                for (const source of sources.slice(0, MAX_ARCHIVE_ENTRIES)) {
                    const key = relative(base, source) || basename(source);
                    entries[key] = readFileSync(source);
                }

                mkdirSync(dirname(archivePath), { recursive: true });
                await Archive.write(archivePath, entries, input.compress === "gzip" ? { compress: "gzip" } : undefined);
                return `Wrote ${Object.keys(entries).length} entries to ${relativeTo(resolved, archivePath)}`;
            }

            assertFile(archivePath, input.path);
            const bytes = readFileSync(archivePath);
            let archive;
            try {
                archive = new Archive(bytes);
            } catch (error: any) {
                fail("BUILTIN_TOOL_ARCHIVE_INVALID", `Cannot read '${input.path}' as a tar archive: ${error?.message ?? error}`);
            }

            if (input.action === "list") {
                const files: Map<string, File> = await archive.files(input.glob);
                if (!files.size) return "(empty)";
                return [...files.values()]
                    .slice(0, MAX_ARCHIVE_ENTRIES)
                    .map((file) => `${file.name} (${file.size} bytes)`)
                    .join("\n");
            }

            // extract — refuse an entry that would escape the destination (zip-slip)
            const files: Map<string, File> = await archive.files();
            for (const name of files.keys()) {
                const normalized = name.replace(/\\/g, "/");
                if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
                    fail("BUILTIN_TOOL_ARCHIVE_UNSAFE", `The archive contains an unsafe entry: '${name}'`);
                }
            }

            const destination = resolveInside(resolved, input.destination ?? ".", "destination");
            mkdirSync(destination, { recursive: true });
            const count = await archive.extract(destination, input.glob ? { glob: input.glob } : undefined);
            return `Extracted ${count} entries to ${relativeTo(resolved, destination)}`;
        },
    });

    return BUILTIN_TOOL_NAMES.filter((name) => wanted.has(name)).flatMap((name) => tools.filter((tool) => tool.id === name));
}
