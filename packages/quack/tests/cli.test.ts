import { describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { freePort, sleep } from "./helpers";

/**
 * The CLI, spawned as a real process — `antq start …`.
 *
 * Nothing here is mocked: the process must actually serve, actually stay alive
 * (the Quack listener is a native thread, invisible to Bun's event loop) and
 * actually persist to `--dbPath` across a restart.
 */

const CLI = join(import.meta.dir, "..", "bin", "cli.ts");
const TOKEN = "cli-secret";

function cli(args: string[], env: Record<string, string> = {}) {
    return Bun.spawn(["bun", CLI, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        // Cleared so "no token" is really no token.
        env: { ...process.env, QUACK_TOKEN: "", DUCKDB_QUACK_TOKEN: "", ...env },
    });
}

async function capture(args: string[]) {
    const proc = cli(args);
    const [out, err] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
    ]);
    return { code: await proc.exited, out, err };
}

/** Read the banner the process prints before it settles into serving. */
async function banner(proc: Bun.Subprocess, timeoutMs = 15_000): Promise<string> {
    const reader = (proc.stdout as ReadableStream).getReader();
    const decoder = new TextDecoder();
    let text = "";

    while (!text.includes("Ctrl-C")) {
        const chunk = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no banner printed")), timeoutMs)),
        ]);
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
    }
    return text;
}

/** A string literal for the SQL the test sends. */
function literal(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/** A client attached to the CLI's server, through Quack's own ATTACH. */
class Remote {
    readonly alias = "r";

    #instance: DuckDBInstance;
    #connection: DuckDBConnection;

    constructor(instance: DuckDBInstance, connection: DuckDBConnection) {
        this.#instance = instance;
        this.#connection = connection;
    }

    async exec(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
        const reader = await this.#connection.runAndReadAll(sql);
        return { rows: reader.getRowObjectsJson() as Record<string, unknown>[] };
    }

    close(): void {
        this.#connection.closeSync();
        this.#instance.closeSync();
    }
}

/** Attach until the server answers — a poll, not a fixed sleep. */
async function attach(port: number, token = TOKEN, timeoutMs = 40_000): Promise<Remote> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;

    while (Date.now() < deadline) {
        const instance = await DuckDBInstance.create();
        const connection = await instance.connect();
        try {
            // The secret first: the ATTACH resolves it by type.
            await connection.run(`CREATE OR REPLACE SECRET cli (TYPE quack, TOKEN ${literal(token)})`);
            await connection.run(`ATTACH ${literal(`quack:127.0.0.1:${port}`)} AS r`);
            await connection.run("SELECT 1");
            return new Remote(instance, connection);
        } catch (err) {
            last = err;
            connection.closeSync();
            instance.closeSync();
            await sleep(150);
        }
    }
    throw new Error(`the CLI never came up on port ${port}: ${last}`);
}

describe("antq — the CLI", () => {
    it("declares a bin that exists and runs", async () => {
        // A typo in `bin` is silent until publish, and the name is the command
        // users type: pin both.
        const manifest = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as { bin?: Record<string, string> };
        expect(manifest.bin).toEqual({ "antq": "./bin/cli.ts" });

        const [name, path] = Object.entries(manifest.bin ?? {})[0]!;
        expect(name).toBe("antq");

        const file = join(import.meta.dir, "..", path!);
        expect(await Bun.file(file).exists()).toBe(true);
        expect((await Bun.file(file).text()).startsWith("#!/usr/bin/env bun")).toBe(true);

        const proc = Bun.spawn(["bun", file, "--version"], { stdout: "pipe", stderr: "pipe" });
        const out = await new Response(proc.stdout as ReadableStream).text();
        expect(await proc.exited).toBe(0);
        expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("prints its usage", async () => {
        const { code, out } = await capture(["--help"]);
        expect(code).toBe(0);
        expect(out).toContain("start [options]");
        expect(out).toContain("--dbPath");
    });

    it("prints its version", async () => {
        const manifest = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as { version: string };
        const { code, out } = await capture(["--version"]);
        expect(code).toBe(0);
        expect(out.trim()).toBe(manifest.version);
    });

    it("refuses to start without a token", async () => {
        const { code, err } = await capture(["start"]);
        expect(code).toBe(1);
        expect(err).toContain("token is required");
    });

    it("refuses an unknown option, and a value of the wrong type", async () => {
        expect((await capture(["start", "--nope"])).err).toContain("Unknown option");
        expect((await capture(["start", "--token", TOKEN, "--port", "abc"])).err).toContain("expects a number");
    });

    it("refuses an unknown command", async () => {
        const { code, err } = await capture(["serve"]);
        expect(code).toBe(1);
        expect(err).toContain("Unknown command 'serve'");
    });

    it("accepts the spelling of an option, dashed or cased", async () => {
        // `--db-path` and `--DBPATH` reach the same option as `--dbPath`.
        const { code, err } = await capture(["start", "--db-path", "/nope/never.duckdb", "--token", TOKEN, "--port", "abc"]);
        // The point is that the option *was* recognised: the failure is the port.
        expect(code).toBe(1);
        expect(err).toContain("expects a number");
    });
});

describe("antq — the CLI serving", () => {
    it("starts in quack mode, and says so", async () => {
        const port = freePort();
        const proc = cli(["start", "--quack", "--port", String(port), "--token", TOKEN]);

        const out = await banner(proc);
        expect(out).toContain("mode     quack");
        expect(out).toContain(`quack:127.0.0.1:${port}`);
        // The token is masked unless `--printToken` asks for it.
        expect(out).not.toContain(TOKEN);
        expect(out).toContain(`${TOKEN.length} characters`);

        const client = await attach(port);
        await client.close();

        proc.kill("SIGINT");
        expect(await proc.exited).toBe(0);
    }, 120_000);

    it("refuses to start with no mode", async () => {
        const { code, err } = await capture(["start", "--quack=false", "--token", TOKEN]);
        expect(code).toBe(1);
        expect(err).toContain("only serving mode");
    });

    it("serves on --port and keeps the data in --dbPath across a restart", async () => {
        const directory = await mkdtemp(join(tmpdir(), "antq-cli-"));
        const file = join(directory, "cli.duckdb");
        const port = freePort();

        const first = cli(["start", "--port", String(port), "--token", TOKEN, "--dbPath", file]);
        const client = await attach(port);

        // The alias is what makes it a write *on the server*: an unqualified
        // `CREATE TABLE` would land in the client's own local database.
        const alias = client.alias;
        await client.exec(`CREATE TABLE ${alias}.t AS SELECT 1 AS n`);
        const seen = await client.exec(`SELECT n FROM ${alias}.t`);
        expect(seen.rows).toEqual([{ n: 1 }]);
        await client.close();

        // SIGINT must stop the server and let the process exit quietly.
        first.kill("SIGINT");
        expect(await first.exited).toBe(0);

        // A brand new process, the same file: the table is still there.
        const second = cli(["start", "--port", String(port), "--token", TOKEN, "--dbPath", file]);
        const again = await attach(port);
        expect((await again.exec(`SELECT n FROM ${again.alias}.t`)).rows).toEqual([{ n: 1 }]);
        await again.close();

        second.kill("SIGINT");
        expect(await second.exited).toBe(0);

        await rm(directory, { recursive: true, force: true });
    }, 180_000);

    it("takes the token from the environment", async () => {
        const port = freePort();
        const proc = cli(["start", "--port", String(port)], { QUACK_TOKEN: "from-env-secret" });

        const client = await attach(port, "from-env-secret");
        expect((await client.exec("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
        await client.close();

        proc.kill("SIGINT");
        await proc.exited;
    }, 120_000);
});
