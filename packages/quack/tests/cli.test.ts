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
        expect(out).toContain("--targetBatchBytes");
        expect(out).toContain("--sslCertFile");
        expect(out).toContain("--ftsConfig");
        expect(out).toContain("--vssConfig");
    });

    it("refuses a TLS configuration that cannot be served", async () => {
        const missingKey = await capture(["start", "--token", TOKEN, "--sslCertFile", "/tmp/cert.pem"]);
        expect(missingKey.code).toBe(1);
        expect(missingKey.err).toContain("go together");

        const plain = await capture([
            "start", "--token", TOKEN, "--disableSsl",
            "--sslCertFile", "/tmp/cert.pem", "--sslKeyFile", "/tmp/key.pem",
        ]);
        expect(plain.code).toBe(1);
        expect(plain.err).toContain("exclusive");
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

    it("builds a --fts index before serving, and the client can search it", async () => {
        const directory = await mkdtemp(join(tmpdir(), "antq-fts-"));
        const file = join(directory, "docs.duckdb");

        // Seed the file the server will open — the index needs a table to index.
        const instance = await DuckDBInstance.create(file);
        const connection = await instance.connect();
        await connection.run(`CREATE TABLE docs (id VARCHAR PRIMARY KEY, body VARCHAR)`);
        await connection.run(`INSERT INTO docs VALUES
            ('d1', 'Le chat est un petit mammifère.'),
            ('d2', 'Le canard colvert est un oiseau.')`);
        connection.closeSync();
        instance.closeSync();

        const port = freePort();
        const proc = cli([
            "start", "--port", String(port), "--token", TOKEN, "--dbPath", file,
            "--fts", "docs:id:body", "--ftsStemmer", "french", "--ftsIncremental",
        ]);

        const client = await attach(port);
        const searched = await client.exec(`
            SELECT * FROM quack_query_by_name(
                'r',
                'SELECT id, score FROM (SELECT *, fts_main_docs.match_bm25(id, ''chats'') AS score FROM docs) sq WHERE score IS NOT NULL ORDER BY score DESC'
            )
        `);
        expect(searched.rows).toEqual([{ id: "d1", score: expect.any(Number) }]);

        // `--ftsIncremental`: a row inserted after the start is searchable too.
        await client.exec(`
            SELECT * FROM quack_query_by_name('r', 'INSERT INTO docs VALUES (''d3'', ''Le cygne est un oiseau aquatique.'')')
        `);
        const swan = await client.exec(`
            SELECT * FROM quack_query_by_name(
                'r',
                'SELECT id, score FROM (SELECT *, fts_main_docs.match_bm25(id, ''cygne'') AS score FROM docs) sq WHERE score IS NOT NULL'
            )
        `);
        expect(swan.rows).toEqual([{ id: "d3", score: expect.any(Number) }]);
        await client.close();

        proc.kill("SIGINT");
        expect(await proc.exited).toBe(0);
        await rm(directory, { recursive: true, force: true });
    }, 180_000);

    it("builds several indexes from --ftsConfig and repeated --fts", async () => {
        const directory = await mkdtemp(join(tmpdir(), "antq-fts-config-"));
        const file = join(directory, "docs.duckdb");
        const config = join(directory, "fts.json");

        const instance = await DuckDBInstance.create(file);
        const connection = await instance.connect();
        await connection.run(`CREATE TABLE documents (document_identifier VARCHAR PRIMARY KEY, text_content VARCHAR, author VARCHAR)`);
        await connection.run(`CREATE TABLE docs (id VARCHAR PRIMARY KEY, body VARCHAR)`);
        await connection.run(`CREATE TABLE redactions (redaction_id VARCHAR PRIMARY KEY, text VARCHAR)`);
        await connection.run(`CREATE TABLE notes (note_id VARCHAR PRIMARY KEY, body VARCHAR)`);
        await connection.run(`INSERT INTO documents VALUES ('doc1', 'The mallard is a dabbling duck.', 'Alice')`);
        await connection.run(`INSERT INTO docs VALUES ('d1', 'Le chat est un petit mammifère.')`);
        await connection.run(`INSERT INTO redactions VALUES ('r1', 'Secret project alpha.')`);
        await connection.run(`INSERT INTO notes VALUES ('n1', 'The swan is a bird.')`);
        connection.closeSync();
        instance.closeSync();

        await Bun.write(config, JSON.stringify([
            { table: "documents", id: "document_identifier", fields: ["text_content", "author"], stemmer: "english" },
            { table: "docs", id: "id", fields: "body" },
            { table: "redactions", id: "redaction_id", fields: ["text"], incremental: true },
        ]));

        const port = freePort();
        const proc = cli([
            "start", "--port", String(port), "--token", TOKEN, "--dbPath", file,
            "--ftsConfig", config,
            "--fts", "notes:note_id:body",
        ]);

        const client = await attach(port);
        const search = async (schema: string, table: string, idColumn: string, term: string) =>
            (await client.exec(`
                SELECT * FROM quack_query_by_name(
                    'r',
                    'SELECT ${idColumn} FROM (SELECT *, ${schema}.match_bm25(${idColumn}, ''${term}'') AS score FROM ${table}) sq WHERE score IS NOT NULL'
                )
            `)).rows;

        expect(await search("fts_main_documents", "documents", "document_identifier", "mallard"))
            .toEqual([{ document_identifier: "doc1" }]);
        expect(await search("fts_main_docs", "docs", "id", "chat"))
            .toEqual([{ id: "d1" }]);
        expect(await search("fts_main_redactions", "redactions", "redaction_id", "secret"))
            .toEqual([{ redaction_id: "r1" }]);
        expect(await search("fts_main_notes", "notes", "note_id", "swan"))
            .toEqual([{ note_id: "n1" }]);
        await client.close();

        proc.kill("SIGINT");
        expect(await proc.exited).toBe(0);
        await rm(directory, { recursive: true, force: true });
    }, 180_000);

    it("refuses a missing --ftsConfig file", async () => {
        const { code, err } = await capture(["start", "--token", TOKEN, "--ftsConfig", "/nope/fts.json"]);
        expect(code).toBe(1);
        expect(err).toContain("Cannot read --ftsConfig");
    });

    it("builds a --vss index before serving, and the client can search it", async () => {
        const directory = await mkdtemp(join(tmpdir(), "antq-vss-"));
        const file = join(directory, "vecs.duckdb");

        const instance = await DuckDBInstance.create(file);
        const connection = await instance.connect();
        await connection.run(`CREATE TABLE vecs (id VARCHAR PRIMARY KEY, vec FLOAT[3])`);
        await connection.run(`INSERT INTO vecs VALUES ('v1', [1, 0, 0]), ('v2', [0, 1, 0]), ('v3', [1, 1, 0])`);
        connection.closeSync();
        instance.closeSync();

        const port = freePort();
        const proc = cli([
            "start", "--port", String(port), "--token", TOKEN, "--dbPath", file,
            "--vss", "vecs:vec:cosine", "--vssPersist",
        ]);

        const client = await attach(port);
        const searched = await client.exec(`
            SELECT * FROM quack_query_by_name(
                'r',
                'SELECT id, array_cosine_distance(vec, CAST([1, 0, 0] AS FLOAT[3])) AS distance FROM vecs ORDER BY array_cosine_distance(vec, CAST([1, 0, 0] AS FLOAT[3])) LIMIT 2'
            )
        `);
        expect(searched.rows.map((row: any) => row.id)).toEqual(["v1", "v3"]);
        await client.close();

        proc.kill("SIGINT");
        expect(await proc.exited).toBe(0);
        await rm(directory, { recursive: true, force: true });
    }, 180_000);

    it("builds several vector indexes from --vssConfig", async () => {
        const directory = await mkdtemp(join(tmpdir(), "antq-vss-config-"));
        const file = join(directory, "vecs.duckdb");
        const config = join(directory, "vss.json");

        const instance = await DuckDBInstance.create(file);
        const connection = await instance.connect();
        await connection.run(`CREATE TABLE vecs (id VARCHAR PRIMARY KEY, vec FLOAT[3])`);
        await connection.run(`CREATE TABLE embeddings (id VARCHAR PRIMARY KEY, vec FLOAT[3])`);
        await connection.run(`INSERT INTO vecs VALUES ('a1', [1, 0, 0]), ('a2', [0, 1, 0])`);
        await connection.run(`INSERT INTO embeddings VALUES ('e1', [0, 0, 1]), ('e2', [0, 1, 0])`);
        connection.closeSync();
        instance.closeSync();

        await Bun.write(config, JSON.stringify([
            { table: "vecs", column: "vec", metric: "cosine" },
            { table: "embeddings", column: "vec", metric: "l2sq", efSearch: 32 },
        ]));

        const port = freePort();
        const proc = cli([
            "start", "--port", String(port), "--token", TOKEN, "--dbPath", file,
            "--vssConfig", config, "--vssPersist",
        ]);

        const client = await attach(port);
        const nearest = async (table: string, fn: string, vector: string) =>
            (await client.exec(`
                SELECT * FROM quack_query_by_name(
                    'r',
                    'SELECT id FROM ${table} ORDER BY ${fn}(vec, CAST(${vector} AS FLOAT[3])) LIMIT 1'
                )
            `)).rows;

        expect(await nearest("vecs", "array_cosine_distance", "[1, 0, 0]")).toEqual([{ id: "a1" }]);
        expect(await nearest("embeddings", "array_distance", "[0, 0, 1]")).toEqual([{ id: "e1" }]);
        await client.close();

        proc.kill("SIGINT");
        expect(await proc.exited).toBe(0);
        await rm(directory, { recursive: true, force: true });
    }, 180_000);

    it("refuses a file database without --vssPersist", async () => {
        const directory = await mkdtemp(join(tmpdir(), "antq-vss-nopersist-"));
        const file = join(directory, "vecs.duckdb");

        const { code, err } = await capture([
            "start", "--token", TOKEN, "--dbPath", file, "--vss", "vecs:vec",
        ]);
        expect(code).toBe(1);
        expect(err).toContain("need --vssPersist");

        await rm(directory, { recursive: true, force: true });
    });

    it("refuses a missing --vssConfig file", async () => {
        const { code, err } = await capture(["start", "--token", TOKEN, "--vssConfig", "/nope/vss.json"]);
        expect(code).toBe(1);
        expect(err).toContain("Cannot read --vssConfig");
    });

    it("refuses a malformed --fts spec", async () => {
        const { code, err } = await capture(["start", "--token", TOKEN, "--fts", "nope"]);
        expect(code).toBe(1);
        expect(err).toContain("--fts expects table:id:field1,field2");
    });
});
