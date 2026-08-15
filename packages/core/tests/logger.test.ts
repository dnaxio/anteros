import { describe, it, expect, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger";

const DIR = path.join(import.meta.dir, ".tmp-logger");

/** Read the log file and parse every line as JSONL */
function readLogLines(rel: string): any[] {
    return fs.readFileSync(path.join(DIR, rel), "utf-8")
        .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function flush() {
    await logger.flush(); // wait for all pending writes
    await Bun.sleep(10);
}

afterAll(() => {
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
    logger.configure({ console: false, file: false });
});

describe("logger", () => {
    it("writes JSONL lines with the Caddy envelope", async () => {
        logger.configure({ dir: path.join(DIR, "basic"), file: true, console: false, level: "debug" });
        logger.debug("dbg", { a: 1 });
        logger.info("hello", { port: 4000 });
        logger.warn("careful", { code: "X" });
        logger.error("boom");
        await flush();
        const lines = readLogLines("basic/anteros.log");
        expect(lines.length).toBe(4);
        const hello = lines.find((l) => l.msg === "hello")!;
        expect(hello.level).toBe("info");
        expect(hello.port).toBe(4000);
        expect(typeof hello.ts).toBe("number");
        expect(lines.find((l) => l.msg === "boom")!.level).toBe("error");
        expect(lines.find((l) => l.msg === "dbg")!.level).toBe("debug");
    });

    it("respects the level filter", async () => {
        logger.configure({ dir: path.join(DIR, "filter"), file: true, console: false, level: "warn" });
        logger.info("hidden-info");
        logger.debug("hidden-debug");
        logger.warn("shown-warn");
        logger.error("shown-error");
        await flush();
        const lines = readLogLines("filter/anteros.log");
        expect(lines.some((l) => l.msg === "hidden-info")).toBe(false);
        expect(lines.some((l) => l.msg === "hidden-debug")).toBe(false);
        expect(lines.some((l) => l.msg === "shown-warn")).toBe(true);
        expect(lines.some((l) => l.msg === "shown-error")).toBe(true);
    });

    it("supports a custom file path", async () => {
        const custom = path.join(DIR, "custom", "my-app.log");
        logger.configure({ file: custom, console: false });
        logger.info("custom path", { ok: true });
        await flush();
        const lines = fs.readFileSync(custom, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
        expect(lines[0]!.msg).toBe("custom path");
        expect(lines[0]!.ok).toBe(true);
    });

    it("rotates the file when maxSize is exceeded", async () => {
        const dir = path.join(DIR, "rotate");
        logger.configure({ dir, file: true, console: false, maxSize: 200, maxFiles: 3 });
        for (let i = 0; i < 20; i++) logger.info(`line ${i} with some padding ${'x'.repeat(30)}`);
        await flush();
        const rotated = fs.readdirSync(dir).filter((f) => f !== "anteros.log");
        // Dated naming: anteros-YYYY-MM-DD-N.log
        const dated = /^anteros-\d{4}-\d{2}-\d{2}-\d+\.log$/;
        expect(rotated.length).toBeGreaterThan(0);
        expect(rotated.every((f) => dated.test(f))).toBe(true);
        // maxFiles: 3 → never more than 3 rotated files kept
        expect(rotated.length).toBeLessThanOrEqual(3);
        // the live file is never removed
        expect(fs.existsSync(path.join(dir, "anteros.log"))).toBe(true);
    });

    it("handles circular / non-JSON meta safely", async () => {
        logger.configure({ dir: path.join(DIR, "safe"), file: true, console: false });
        const circular: any = { name: "x" };
        circular.self = circular;
        logger.info("circular meta", circular);
        logger.info("bigint meta", { n: 123n });
        await flush();
        const lines = readLogLines("safe/anteros.log");
        expect(lines.some((l) => l.msg === "circular meta")).toBe(true);
        const raw = fs.readFileSync(path.join(DIR, "safe", "anteros.log"), "utf-8");
        expect(raw).toContain("[Circular]");
        expect(lines.find((l) => l.msg === "bigint meta")!.n).toBe("123");
    });

    it("keeps user-provided envelope keys", async () => {
        logger.configure({ dir: path.join(DIR, "ts"), file: true, console: false });
        logger.info("custom ts", { ts: 123.5, customField: 1 });
        await flush();
        const lines = readLogLines("ts/anteros.log");
        expect(lines[0]!.ts).toBe(123.5);
        expect(lines[0]!.customField).toBe(1);
        expect(lines[0]!.msg).toBe("custom ts");
    });

    it("logger.file writes to the file but never to the console", async () => {
        const out: string[] = [];
        const orig = console.log;
        console.log = (...a: any[]) => { out.push(a.join(" ")); };

        logger.configure({ dir: path.join(DIR, "fileonly"), file: true, console: true });
        logger.file("Server started", { pid: 1 });
        logger.info("visible info", { a: 1 });
        await flush();
        console.log = orig;

        const lines = readLogLines("fileonly/anteros.log");
        expect(lines.some((l) => l.msg === "Server started")).toBe(true);
        expect(lines.some((l) => l.msg === "visible info")).toBe(true);
        expect(out.some((l) => l.includes("visible info"))).toBe(true);
        expect(out.some((l) => l.includes("Server started"))).toBe(false);
    });
});
