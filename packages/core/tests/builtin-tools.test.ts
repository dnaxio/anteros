import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Agent, BUILTIN_TOOL_NAMES, builtinToolsFor, v } from "../index";
import { fakeProvider, openaiText, request } from "./fixtures/fake-provider";
import type { AgentTool } from "../types/agent";

/**
 * The built-in tools — off by default, confined to a workspace root.
 *
 * `shell`, `bun` and `spawn` are exercised for real (a short command), the file
 * tools against a temporary workspace. `browser_control` is not run here: it opens a
 * real browser (Bun.WebView) and belongs to an interactive environment.
 */

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let root: string;
let outside: string;

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "builtin-tools-"));
    outside = mkdtempSync(join(tmpdir(), "builtin-tools-outside-"));
    writeFileSync(join(root, "notes.txt"), "alpha\nbeta\ngamma\n");
    writeFileSync(join(root, "other.txt"), "beta beta\n");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n// beta\n");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
});

const all = (): AgentTool[] => builtinToolsFor(true, { root });

function tool(tools: AgentTool[], id: string): AgentTool {
    const found = tools.find((entry) => entry.id === id);
    if (!found) throw new Error(`missing tool '${id}'`);
    return found;
}

/** Validate then run, the way the runtime does. */
async function call(tools: AgentTool[], id: string, input: Record<string, unknown>): Promise<any> {
    const entry = tool(tools, id);
    const { value, error } = (entry.inputSchema as any).validate(input, { allowUnknown: false });
    if (error) throw error;
    return entry.execute!(value, {} as any);
}

describe("built-in tools — opt-in", () => {
    it("is off unless the agent asks for it", () => {
        expect(builtinToolsFor(undefined)).toEqual([]);
        expect(builtinToolsFor([])).toEqual([]);
    });

    it("enables all of them with `true`, and a subset with an array", () => {
        expect(builtinToolsFor(true).map((entry) => entry.id).sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
        expect(builtinToolsFor(["read_file", "ls"]).map((entry) => entry.id).sort()).toEqual(["ls", "read_file"]);
    });
});

describe("built-in tools — files", () => {
    it("writes and reads a file, a slice at a time", async () => {
        const tools = all();
        await call(tools, "write_file", { path: "sub/new.txt", content: "one\ntwo\nthree" });
        expect(readFileSync(join(root, "sub/new.txt"), "utf8")).toBe("one\ntwo\nthree");

        expect(await call(tools, "read_file", { path: "sub/new.txt" })).toBe("one\ntwo\nthree");
        expect(await call(tools, "read_file", { path: "sub/new.txt", offset: 1, limit: 1 })).toContain("two");
    });

    it("edits an exact string, and refuses an absent or ambiguous one", async () => {
        const tools = all();
        await call(tools, "edit_file", { path: "notes.txt", old_string: "beta", new_string: "BETA" });
        expect(readFileSync(join(root, "notes.txt"), "utf8")).toContain("BETA");

        await expect(call(tools, "edit_file", { path: "other.txt", old_string: "beta", new_string: "x" }))
            .rejects.toMatchObject({ code: "BUILTIN_TOOL_EDIT_AMBIGUOUS" });
        await expect(call(tools, "edit_file", { path: "notes.txt", old_string: "zzz", new_string: "x" }))
            .rejects.toMatchObject({ code: "BUILTIN_TOOL_EDIT_NOT_FOUND" });

        await call(tools, "edit_file", { path: "other.txt", old_string: "beta", new_string: "x", replace_all: true });
        expect(readFileSync(join(root, "other.txt"), "utf8")).toBe("x x\n");
    });

    it("lists a directory and walks it recursively", async () => {
        const tools = all();
        expect(await call(tools, "ls", {})).toContain("notes.txt");
        expect(await call(tools, "ls", { recursive: true })).toContain("src/a.ts");
        expect(await call(tools, "ls", { glob: "src/**/*.ts" })).toContain("src/a.ts");
    });

    it("greps for a pattern, with `file:line: text`", async () => {
        const tools = all();
        const found = await call(tools, "grep", { pattern: "export const a" });
        expect(found).toContain("src/a.ts:1: export const a = 1;");

        const fixed = await call(tools, "grep", { pattern: "export const a", fixed: true, glob: "src/**" });
        expect(fixed).toContain("src/a.ts:1");
        expect(await call(tools, "grep", { pattern: "no-such-pattern-anywhere" })).toBe("No match");
    });

    it("refuses a path outside the workspace — including through a symlink", async () => {
        const tools = all();
        await expect(call(tools, "read_file", { path: relative(root, join(outside, "secret.txt")) }))
            .rejects.toMatchObject({ code: "BUILTIN_TOOL_PATH_ESCAPE" });
        await expect(call(tools, "read_file", { path: join(outside, "secret.txt") }))
            .rejects.toMatchObject({ code: "BUILTIN_TOOL_PATH_ESCAPE" });

        symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
        await expect(call(tools, "read_file", { path: "link.txt" }))
            .rejects.toMatchObject({ code: "BUILTIN_TOOL_PATH_ESCAPE" });
    });
});

describe("built-in tools — processes", () => {
    it("runs a shell command and reports its exit code", async () => {
        const tools = all();
        expect(await call(tools, "shell", { command: "echo hello" })).toContain("hello");
        expect(await call(tools, "shell", { command: "exit 3" })).toContain("exit code: 3");
    });

    it("kills a command that outlives its timeout", async () => {
        const tools = all();
        const out = await call(tools, "shell", { command: "sleep 5", timeout_ms: 100 });
        expect(out).toContain("timed out");
    }, 10_000);

    it("runs a Bun snippet", async () => {
        const tools = all();
        expect(await call(tools, "bun", { code: "console.log(6 * 7)" })).toContain("42");
    });

    it("runs a program with an argument array, no shell", async () => {
        const tools = all();
        expect(await call(tools, "spawn", { command: "/bin/echo", args: ["spawned"] })).toContain("spawned");
        // A metacharacter is an argument, not an instruction
        expect(await call(tools, "spawn", { command: "/bin/echo", args: ["$(whoami)"] })).toContain("$(whoami)");
    });
});

describe("built-in tools — image and archive", () => {
    it("reads an image's metadata and writes a converted copy", async () => {
        const tools = all();
        writeFileSync(join(root, "tiny.png"), Buffer.from(PNG_1X1, "base64"));

        expect(await call(tools, "image", { path: "tiny.png" })).toBe("png 1x1");
        const written = await call(tools, "image", { path: "tiny.png", width: 2, height: 2, format: "png", output: "scaled.png" });
        expect(written).toContain("Wrote");
        expect(readFileSync(join(root, "scaled.png")).length).toBeGreaterThan(0);
    });

    it("creates, lists and extracts a tar.gz", async () => {
        const tools = all();
        const created = await call(tools, "archive_file", {
            action: "create",
            path: "bundle.tar.gz",
            files: ["notes.txt", "src/a.ts"],
            compress: "gzip",
        });
        expect(created).toContain("2 entries");

        const listed = await call(tools, "archive_file", { action: "list", path: "bundle.tar.gz" });
        expect(listed).toContain("notes.txt");
        expect(listed).toContain("src/a.ts");

        await call(tools, "archive_file", { action: "extract", path: "bundle.tar.gz", destination: "out" });
        expect(readFileSync(join(root, "out", "notes.txt"), "utf8")).toContain("alpha");
        expect(readFileSync(join(root, "out", "src", "a.ts"), "utf8")).toContain("export const a");
    });
});

describe("built-in tools — wired into an agent", () => {
    const provider = fakeProvider(() => openaiText("ok"));
    const agentWith = (extra: Record<string, any> = {}) =>
        new Agent({
            id: "builtin-tools",
            description: "A test agent.",
            instructions: "You are a test agent.",
            provider: { model: "test-model", apiKey: "test-key", protocol: "openai", baseUrl: provider.url, options: { retries: 0 } },
            ...extra,
        } as any);

    const offered = (hit: number): string[] =>
        (request(provider, hit).body.tools ?? []).map((entry: any) => entry.function.name);

    it("offers nothing by default", async () => {
        await agentWith().generate("hi");
        const names = offered(0);
        expect(names).not.toContain("read_file");
        expect(names).not.toContain("shell");
    });

    it("offers the requested subset", async () => {
        await agentWith({ builtinTools: ["read_file"], builtinToolsOptions: { root } }).generate("hi");
        const names = offered(1);
        expect(names).toContain("read_file");
        expect(names).not.toContain("write_file");
        expect(names).not.toContain("shell");
    });

    it("lets `tools: false` remove them, like any other tool", async () => {
        await agentWith({ builtinTools: true }).generate("hi", { tools: false });
        expect(offered(2)).toEqual([]);
    });

    it("lets a declared tool win over the built-in of the same id", async () => {
        const own = {
            id: "read_file",
            description: "my own reader",
            inputSchema: v.object({ path: v.string() }),
            execute: () => "mine",
        };
        await agentWith({ builtinTools: ["read_file"], tools: { read_file: own } }).generate("hi");
        const spec = request(provider, 3).body.tools.find((entry: any) => entry.function.name === "read_file");
        expect(spec.function.description).toBe("my own reader");
    });
});
