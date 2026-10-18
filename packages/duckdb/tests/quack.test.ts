import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckdbQuackInstance, DuckdbQuackServer, DuckdbQuackError, DEFAULT_PORT, formatTimestamp } from "../index";
import { freePort } from "./helpers";

/**
 * `@anteros/duckdb`, tested against the real thing.
 *
 * The Quack half is exercised **end to end**: a `DuckdbQuackServer` on one side
 * runs `CALL quack_serve(...)`, a `DuckdbQuackInstance` on the other attaches it —
 * no mock, because the protocol is the feature.
 *
 * The first run downloads the `quack` extension (needs network, ~3 s); DuckDB
 * caches it, so the suite is offline from the second run on.
 */

// ─── A quack server to talk to ────────────────────────────────────────────
//
// The server runs in its **own process** (see `fixtures/quack-server.ts`): the
// remote tests reach it over the protocol, so the engine's native thread never
// runs inside the test runner. `serverDb` is a client that only runs
// server-side statements — the "owner's view" the tests assert against.
//
// The clients are created **once** for the file, not one per test: creating and
// closing many native DuckDB instances inside `bun test` made the runner segfault
// intermittently (a Bun + native finalizer bug, not an assertion failure).

const SERVER_SCRIPT = join(import.meta.dir, "fixtures", "quack-server.ts");
const TOKEN = "test-secret";

let serverProcess: Bun.Subprocess | null = null;
let serverUrl = "";
let serverDb: DuckdbQuackInstance;
/** One client shared by every remote test that needs no special option. */
let defaultDb: DuckdbQuackInstance;

/** Spawn the server process, and wait for its `READY` line. */
async function startServer(): Promise<string> {
    const port = freePort();
    const proc = Bun.spawn(["bun", SERVER_SCRIPT], {
        cwd: import.meta.dir,
        env: { ...process.env, QUACK_TEST_PORT: String(port), QUACK_TEST_TOKEN: TOKEN },
        stdout: "pipe",
        stderr: "pipe",
    });

    const reader = (proc.stdout as ReadableStream).getReader();
    const decoder = new TextDecoder();
    let output = "";

    while (!output.includes("READY")) {
        const chunk = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("the quack server never printed READY")), 60_000),
            ),
        ]);
        if (chunk.done) break;
        output += decoder.decode(chunk.value);
    }

    const match = /READY (quack:\S+)/.exec(output);
    if (!match) throw new Error(`the quack server did not start: ${output}`);
    serverProcess = proc;
    return match[1]!;
}

beforeAll(async () => {
    serverUrl = await startServer();
    serverDb = new DuckdbQuackInstance({ url: serverUrl, token: TOKEN });
    defaultDb = new DuckdbQuackInstance({ url: serverUrl, token: TOKEN });
}, 120_000);

afterAll(async () => {
    await defaultDb?.close().catch(() => {});
    await serverDb?.close().catch(() => {});
    serverProcess?.kill("SIGTERM");
    await serverProcess?.exited.catch(() => {});
});

// ─── Without a remote: the local instance ─────────────────────────────────

describe("@anteros/duckdb — local instance", () => {
    it("opens lazily, runs SQL, and closes", async () => {
        const db = new DuckdbQuackInstance();
        expect(db.isConnected).toBe(false);
        expect(db.isAttached).toBe(false);

        const { rows } = await db.exec("SELECT 42 AS n, 'a' AS s");
        expect(rows).toEqual([{ n: 42, s: "a" }]);
        expect(db.isConnected).toBe(true);

        await db.raw();          // the escape hatch opens it too, and is idempotent
        await db.close();
        await expect(db.exec("SELECT 1")).rejects.toThrow(/closed/i);
    });

    it("reports how long the statement took", async () => {
        const db = new DuckdbQuackInstance();
        const result = await db.exec("SELECT 1 AS n");

        expect(result.rows).toEqual([{ n: 1 }]);
        expect(typeof result.duration_ms).toBe("number");
        expect(result.duration_ms).toBeGreaterThanOrEqual(0);

        await db.close();
    });

    it("binds values instead of interpolating them", async () => {
        const db = new DuckdbQuackInstance();
        const { rows } = await db.exec("SELECT $1 AS v", ["a'b"]);
        expect(rows).toEqual([{ v: "a'b" }]);
        await db.close();
    });

    it("creates the default event-log table, and says so only once", async () => {
        const db = new DuckdbQuackInstance();

        const created = await db.createTable("events");
        expect(created).toEqual({ table: "events", columns: ["id", "ts", "data"], created: true });
        expect((await db.createTable("events")).created).toBe(false);

        await db.close();
    });

    it("creates a table with an explicit schema, and lists it", async () => {
        const db = new DuckdbQuackInstance();
        const info = await db.createTable("metrics", [
            { name: "key", type: "string" },
            { name: "value", type: "double" },
        ]);

        expect(info.columns).toEqual(["key", "value"]);
        expect(await db.listTables()).toContain("metrics");

        await db.close();
    });

    it("drops a table, reporting whether it was there", async () => {
        const db = new DuckdbQuackInstance();
        await db.createTable("gone");

        expect((await db.deleteTable("gone")).dropped).toBe(true);
        expect((await db.deleteTable("gone")).dropped).toBe(false);
        await expect(db.exec(`SELECT * FROM "gone"`)).rejects.toThrow();

        await db.close();
    });

    it("queues rows in the background, into a table it creates on the spot", async () => {
        const db = new DuckdbQuackInstance();

        const result = await db.ingest({ table: "logs", rows: [{ data: { hello: "world" } }] });
        expect(result).toEqual({ table: "logs", queued: 1 });

        await db.flush();
        const { rows } = await db.exec(`SELECT * FROM "logs"`);
        expect(rows).toHaveLength(1);
        expect(String(rows[0]!.id)).toMatch(/^[0-9a-f-]{36}$/);          // default id
        expect(String(rows[0]!.ts).length).toBeGreaterThan(10);           // default timestamp
        expect(JSON.parse(String(rows[0]!.data))).toEqual({ hello: "world" });

        await db.close();
    });

    it("keeps the values a row provides, Date included", async () => {
        const db = new DuckdbQuackInstance();
        await db.ingest({
            table: "explicit",
            rows: [{ id: "e1", ts: new Date(2026, 0, 2, 3, 4, 5), data: { n: 1 } }],
        });
        await db.flush();

        const { rows } = await db.exec(`SELECT * FROM "explicit"`);
        expect(rows[0]!.id).toBe("e1");
        expect(String(rows[0]!.ts)).toContain("2026-01-02 03:04:05");

        await db.close();
    });

    it("batches a large ingest and keeps every row, in order", async () => {
        const db = new DuckdbQuackInstance();

        const rows = Array.from({ length: 1200 }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}`, data: { i } }));
        await db.ingest({ table: "bulk", rows });
        await db.ingest({ table: "bulk", rows: [{ id: "zzz", data: { i: -1 } }] });
        await db.flush();

        const counted = await db.exec(`SELECT count(*) AS n FROM "bulk"`);
        expect(Number(counted.rows[0]!.n)).toBe(1201);

        const { rows: all } = await db.exec(`SELECT id FROM "bulk"`);
        expect(all[all.length - 1]!.id).toBe("zzz"); // the second call landed after the first

        await db.close();
    });

    it("routes a failed background write to `onError` instead of throwing", async () => {
        const failures: Error[] = [];
        const db = new DuckdbQuackInstance({ onError: (error) => failures.push(error) });

        // `must` is NOT NULL and has no default — the row leaves it out, so the
        // INSERT is refused. (`id` and `ts` would have been filled for us.)
        await db.createTable("strict", [{ name: "must", type: "string", required: true }]);
        await expect(db.ingest({ table: "strict", rows: [{ other: 1 }] })).resolves.toEqual({ table: "strict", queued: 1 });
        await db.flush();

        // ...and the caller never hears a word about it.
        expect(failures).toHaveLength(1);
        expect(failures[0]!.message).toContain("strict");
        const { rows } = await db.exec(`SELECT count(*) AS n FROM "strict"`);
        expect(Number(rows[0]!.n)).toBe(0);

        await db.close();
    });

    it("refuses what cannot be interpreted", async () => {
        const db = new DuckdbQuackInstance();
        await expect(db.exec("   ")).rejects.toThrow(/needs a SQL statement/i);
        await expect(db.ingest({ table: "  ", rows: [] })).rejects.toThrow(/name is required/i);
        await expect(db.ingest({ table: "t", rows: null as any })).rejects.toThrow(/array/i);
        await expect(db.createTable("")).rejects.toThrow(/name is required/i);
        await db.close();
    });

    it("queues nothing for an empty array", async () => {
        const db = new DuckdbQuackInstance();
        expect(await db.ingest({ table: "logs", rows: [] })).toEqual({ table: "logs", queued: 0 });
        await db.close();
    });
});

describe("@anteros/duckdb — timestamp helper", () => {
    it("formats a Date as the wall clock DuckDB reads back", () => {
        expect(formatTimestamp(new Date(2026, 0, 5, 3, 7, 9))).toBe("2026-01-05 03:07:09");
    });
});

// ─── With a remote: the Quack protocol ────────────────────────────────────

describe("@anteros/duckdb — Quack remote", () => {
    it("attaches the remote and reads one of its tables", async () => {
        const db = defaultDb;
        expect(db.isAttached).toBe(false);

        const { rows } = await db.exec("SELECT * FROM hello");
        expect(rows).toEqual([{ s: "world" }]);
        expect(db.isAttached).toBe(true);

    }, 60_000);

    it("honours the catalog alias", async () => {
        const db = new DuckdbQuackInstance({ url: serverUrl, token: TOKEN, as: "remote" });
        expect(db.alias).toBe("remote");

        const { connection } = await db.raw();
        const reader = await connection.runAndReadAll("SELECT * FROM remote.hello");
        expect(reader.getRowObjectsJson()).toEqual([{ s: "world" }]);

        await db.close();
    }, 60_000);

    it("writes on the remote, and the server sees it", async () => {
        const db = defaultDb;
        await db.exec("CREATE TABLE from_client AS SELECT 7 AS n");

        const seen = (await serverDb.exec("SELECT n FROM from_client")).rows;
        expect(seen).toEqual([{ n: 7 }]);
    }, 60_000);

    it("creates a table on the remote and ingests into it through SQL", async () => {
        const db = defaultDb;

        // The remote is a catalog like any other: qualify the table and everything
        // goes over the wire.
        await db.exec(`CREATE TABLE events ("id" VARCHAR, "ts" TIMESTAMP, "data" JSON)`);
        await db.exec(`INSERT INTO events VALUES ('evt-1', TIMESTAMP '2026-10-16 12:00:00', CAST('{"ok":true}' AS JSON))`);

        const seen = (await serverDb.exec("SELECT id, data FROM events")).rows;
        expect(seen).toEqual([{ id: "evt-1", data: '{"ok":true}' }]);

    }, 60_000);

    it("makes the remote the default catalog — the local one stays reachable", async () => {
        const db = defaultDb;

        // The client connection attaches the remote and runs `USE` on the alias.
        const { connection } = await db.raw();
        const remote = await connection.runAndReadAll("SELECT * FROM hello");
        expect(remote.getRowObjectsJson()).toEqual([{ s: "world" }]);

        // The client's own in-memory catalog is still reachable, qualified.
        await connection.run("CREATE TABLE memory.local_probe AS SELECT 1 AS n");
        const local = await connection.runAndReadAll("SELECT * FROM memory.local_probe");
        expect(local.getRowObjectsJson()).toEqual([{ n: 1 }]);

    }, 60_000);

    it("declares the fields of a table on the remote, and ingests into it", async () => {
        const db = defaultDb;
        const fields = [
            { name: "prix", type: "DOUBLE" },
            { name: "libelle", type: "string" },
            { name: "date", type: "DATE" },
            { name: "guichet", type: "string" },
            { name: "zone", type: "string" },
        ];

        const info = await db.createTable("tickets", fields);
        expect(info.created).toBe(true);
        expect(info.columns).toEqual(["prix", "libelle", "date", "guichet", "zone"]);
        expect(await db.createTable("tickets", fields)).toMatchObject({ created: false });

        const { queued } = await db.ingest({
            table: "tickets",
            rows: [
                { prix: 500, libelle: "Ticket unitaire", date: "2026-10-01", guichet: "G1", zone: "Zone A" },
                { prix: 1500, libelle: "Pass journée", date: "2026-10-02", guichet: "G2", zone: "Zone B" },
            ],
            columns: fields,
        });
        expect(queued).toBe(2);
        await db.flush();

        // The server — the owner of the data — sees exactly those rows.
        const seen = await serverDb.exec("SELECT libelle, prix FROM tickets ORDER BY prix");
        expect(seen.rows).toEqual([
            { libelle: "Ticket unitaire", prix: 500 },
            { libelle: "Pass journée", prix: 1500 },
        ]);

        expect(await db.listTables()).toContain("tickets");
    }, 60_000);

    it("declares tables at initialization, and creates them in the background", async () => {
        const db = new DuckdbQuackInstance({
            url: serverUrl,
            token: TOKEN,
            tables: [
                {
                    name: "schema_created",
                    fields: [
                        { name: "prix", type: "DOUBLE" },
                        { name: "libelle", type: "string" },
                    ],
                },
            ],
        });

        await db.connect();
        const report = await db.syncSchema();          // waits for the background sync
        expect(report.tables).toEqual([
            { table: "schema_created", created: true, added: [], retyped: [] },
        ]);

        // The owner of the data sees the table, with the declared fields.
        const { rows } = await serverDb.exec(
            `SELECT column_name, data_type FROM information_schema.columns
              WHERE table_name = 'schema_created' ORDER BY ordinal_position`,
        );
        expect(rows).toEqual([
            { column_name: "prix", data_type: "DOUBLE" },
            { column_name: "libelle", data_type: "VARCHAR" },
        ]);

        // Idempotent: a second sync has nothing left to do.
        expect((await db.syncSchema()).tables[0]).toMatchObject({ created: false, added: [], retyped: [] });

        await db.close();
    }, 60_000);

    it("adds missing fields and retypes changed ones — never drops a field", async () => {
        await serverDb.exec("CREATE TABLE schema_migrated (prix VARCHAR, legacy VARCHAR)");
        await serverDb.exec("INSERT INTO schema_migrated VALUES ('42', 'keep-me')");

        const db = new DuckdbQuackInstance({
            url: serverUrl,
            token: TOKEN,
            tables: [
                {
                    name: "schema_migrated",
                    fields: [
                        { name: "prix", type: "DOUBLE" },
                        { name: "libelle", type: "string" },
                    ],
                },
            ],
        });

        const report = await db.syncSchema();
        expect(report.tables[0]).toMatchObject({ created: false, added: ["libelle"], retyped: ["prix"] });

        // prix was cast, libelle added, and `legacy` — not declared — is untouched.
        const { rows } = await serverDb.exec("SELECT prix, libelle, legacy FROM schema_migrated");
        expect(rows).toEqual([{ prix: 42, libelle: null, legacy: "keep-me" }]);

        await db.close();
    }, 60_000);

    it("creates a data table in the background and ingests JSON documents", async () => {
        const db = defaultDb;
        const tickets = await db.table("json_tickets");

        const { queued } = await tickets.ingest([
            { libelle: "Ticket unitaire", prix: 500, guichet: "G1" },
            { libelle: "Pass journée", prix: 1500, guichet: "G2" },
        ]);
        expect(queued).toBe(2);
        await tickets.flush();

        const { rows } = await db.exec(
            `SELECT data->>'libelle' AS libelle, CAST(data->>'prix' AS DOUBLE) AS prix, ts IS NOT NULL AS has_ts
               FROM json_tickets ORDER BY prix`,
        );
        expect(rows).toEqual([
            { libelle: "Ticket unitaire", prix: 500, has_ts: true },
            { libelle: "Pass journée", prix: 1500, has_ts: true },
        ]);

        // The shape is exactly two columns: data (JSON) and ts (TIMESTAMP).
        const { rows: columns } = await serverDb.exec(
            `SELECT column_name, data_type FROM information_schema.columns
              WHERE table_name = 'json_tickets' ORDER BY column_name`,
        );
        expect(columns).toEqual([
            { column_name: "data", data_type: "JSON" },
            { column_name: "ts", data_type: "TIMESTAMP" },
        ]);

    }, 60_000);

    it("maps the ts column to a field of the document", async () => {
        const db = defaultDb;
        const events = await db.table("json_events", { ts: "createdAt" });

        await events.ingest([
            { ref: "A-1", createdAt: "2026-10-01T08:30:00Z" },
            { ref: "A-2", createdAt: "2026-10-02T09:00:00Z" },
        ]);
        await events.flush();

        const { rows } = await db.exec(
            "SELECT data->>'ref' AS ref, CAST(ts AS VARCHAR) AS ts FROM json_events ORDER BY ref",
        );
        expect(String((rows[0] as any).ts).startsWith("2026-10-01")).toBe(true);
        expect(String((rows[1] as any).ts).startsWith("2026-10-02")).toBe(true);

    }, 60_000);

    it("refuses to write into a table that is not a data table", async () => {
        // A fresh attach: the table is created on the server after the shared
        // client's catalog snapshot, so only a new client sees it.
        await serverDb.exec("CREATE TABLE json_bad (prix DOUBLE)");
        const db = new DuckdbQuackInstance({ url: serverUrl, token: TOKEN });
        const bad = await db.table("json_bad");

        await expect(bad.ingest([{ prix: 1 }])).rejects.toThrow(/not a data table/);

        await db.close();
    }, 60_000);

    it("runs every statement on the Quack server by default", async () => {
        const db = defaultDb;

        // No option: on an attached instance, the server is where it runs.
        const aggregate = await db.exec("SELECT COUNT(*) AS n FROM hello");
        expect(aggregate.rows).toEqual([{ n: "1" }]);

        // The remote alias only exists on the client, so the server does not know it.
        await expect(db.exec("SELECT * FROM quack.hello")).rejects.toThrow(/does not exist/i);

        // Bound values are the one client path (the server only receives SQL text).
        const bound = await db.exec("SELECT $1::INT AS v", { values: [42] });
        expect(bound.rows).toEqual([{ v: 42 }]);

    }, 60_000);

    it("updates matching documents with a JSON merge patch", async () => {
        const db = defaultDb;
        const docs = await db.table("docs_update");
        await docs.ingest([
            { ref: "A-1", zone: "A" },
            { ref: "A-2", zone: "B" },
        ]);
        await docs.flush();

        // Through the table handle…
        const { updated } = await docs.update("data->>'ref' = 'A-1'", { zone: "Z", prix: 42 });
        expect(updated).toBe(1);

        // …and through the instance shorthand.
        expect(await db.update("docs_update", "data->>'ref' = 'A-2'", { note: "via instance" })).toEqual({
            table: "docs_update",
            updated: 1,
        });

        const { rows } = await db.exec(
            `SELECT data->>'ref' AS ref, data->>'zone' AS zone, data->>'prix' AS prix, data->>'note' AS note
               FROM docs_update ORDER BY ref`,
        );
        expect(rows).toEqual([
            { ref: "A-1", zone: "Z", prix: "42", note: null },
            { ref: "A-2", zone: "B", prix: null, note: "via instance" },
        ]);

        // A filter is mandatory — without it every document would be patched.
        await expect(docs.update("   ", { zone: "Z" })).rejects.toThrow(/WHERE filter/i);

    }, 60_000);

    it("replaces the whole document of matching rows", async () => {
        const db = defaultDb;
        const docs = await db.table("docs_replace");
        await docs.ingest([
            { ref: "A-1", zone: "A", prix: 10 },
            { ref: "A-2", zone: "B", prix: 20 },
        ]);
        await docs.flush();

        const { replaced } = await docs.replace("data->>'ref' = 'A-2'", { ref: "A-2", zone: "R" });
        expect(replaced).toBe(1);

        // The instance shorthand does the same.
        expect(await db.replace("docs_replace", "data->>'ref' = 'A-1'", { ref: "A-1" })).toEqual({
            table: "docs_replace",
            replaced: 1,
        });

        const { rows } = await db.exec(
            "SELECT data->>'ref' AS ref, data->>'zone' AS zone, data->>'prix' AS prix FROM docs_replace ORDER BY ref",
        );
        // Each replaced document is exactly the object it was given.
        expect(rows).toEqual([
            { ref: "A-1", zone: null, prix: null },
            { ref: "A-2", zone: "R", prix: null },
        ]);

        await expect(docs.replace("", { ref: "X" })).rejects.toThrow(/WHERE filter/i);

    }, 60_000);

    it("deletes matching documents — through the table and the instance", async () => {
        const db = defaultDb;
        const docs = await db.table("docs_delete");
        await docs.ingest([{ ref: "A-1" }, { ref: "A-2" }, { ref: "A-3" }]);
        await docs.flush();

        expect(await docs.delete("data->>'ref' = 'A-2'")).toEqual({ table: "docs_delete", deleted: 1 });
        expect(await db.delete("docs_delete", "data->>'ref' = 'A-3'")).toEqual({ table: "docs_delete", deleted: 1 });

        const { rows } = await db.exec("SELECT data->>'ref' AS ref FROM docs_delete ORDER BY ref");
        expect(rows).toEqual([{ ref: "A-1" }]);

        // The filter is mandatory here too.
        await expect(docs.delete(" ")).rejects.toThrow(/WHERE filter/i);
        await expect(db.delete("docs_delete", "")).rejects.toThrow(/WHERE filter/i);

    }, 60_000);

    it("refuses a write when the remote is attached read-only", async () => {
        const db = new DuckdbQuackInstance({ url: serverUrl, token: TOKEN, readOnly: true });

        // `readOnly` constrains the attach — the mode SQL runs on that connection.
        const { connection } = await db.raw();
        const reader = await connection.runAndReadAll("SELECT * FROM hello");
        expect(reader.getRowObjectsJson()).toEqual([{ s: "world" }]);
        await expect(connection.run(`CREATE TABLE ${db.alias}.nope AS SELECT 1 AS n`)).rejects.toThrow(/read-only/i);

        await db.close();
    }, 60_000);

    it("fails loudly — and fast — on an unreachable server", async () => {
        const db = new DuckdbQuackInstance({ url: "quack:127.0.0.1:1", token: TOKEN });
        await expect(db.connect()).rejects.toThrow(/cannot attach the quack remote/i);
    }, 60_000);

    it("refuses a remote with no token", async () => {
        const previous = process.env.DUCKDB_QUACK_TOKEN;
        delete process.env.DUCKDB_QUACK_TOKEN;

        const db = new DuckdbQuackInstance({ url: serverUrl });
        await expect(db.connect()).rejects.toThrow(/no token/i);

        if (previous !== undefined) process.env.DUCKDB_QUACK_TOKEN = previous;
    }, 60_000);

    it("takes the token from DUCKDB_QUACK_TOKEN when none is passed", async () => {
        const previous = process.env.DUCKDB_QUACK_TOKEN;
        process.env.DUCKDB_QUACK_TOKEN = TOKEN;

        const db = new DuckdbQuackInstance({ url: serverUrl });
        const { rows } = await db.exec("SELECT * FROM hello");
        expect(rows).toEqual([{ s: "world" }]);
        await db.close();

        if (previous === undefined) delete process.env.DUCKDB_QUACK_TOKEN;
        else process.env.DUCKDB_QUACK_TOKEN = previous;
    }, 60_000);

    it("reports the error class it throws", async () => {
        const db = new DuckdbQuackInstance();
        try {
            await db.exec("SELECT * FROM nowhere");
            throw new Error("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(DuckdbQuackError);
            expect((err as DuckdbQuackError).code).toBe("DUCKDB_ERROR");
        }
        await db.close();
    });
});

// ─── The other side: starting a server ────────────────────────────────────

describe("@anteros/duckdb — Quack server", () => {
    it("defaults to Quack's own port, bound to localhost", () => {
        const own = new DuckdbQuackServer({ token: "secret" });

        expect(own.port).toBe(DEFAULT_PORT);
        expect(own.host).toBe("127.0.0.1");
        expect(own.url).toBe(`quack:127.0.0.1:${DEFAULT_PORT}`);
        expect(own.token).toBe("secret");
        expect(own.dbPath).toBeUndefined();          // nothing is persisted
        expect(own.isRunning).toBe(false);
    });

    it("takes a host and a port", () => {
        const own = new DuckdbQuackServer({ token: "secret", host: "0.0.0.0", port: 9999 });
        expect(own.url).toBe("quack:0.0.0.0:9999");
    });

    it("refuses a server without a token", () => {
        expect(() => new DuckdbQuackServer({ token: "   " })).toThrow(/needs a token/i);
        expect(() => new DuckdbQuackServer({} as any)).toThrow(/needs a token/i);
    });

    it("refuses a token shorter than 4 characters — Quack's own rule", () => {
        expect(() => new DuckdbQuackServer({ token: "abc" })).toThrow(/at least 4 characters/i);
        expect(new DuckdbQuackServer({ token: "abcd" }).token).toBe("abcd");
    });

    it("serves its own tables to a client, and cuts it off when stopped", async () => {
        const own = new DuckdbQuackServer({ port: freePort(), token: "own-token" });
        await own.start();
        expect(own.isRunning).toBe(true);

        // The server owns the data: it builds it with the very same methods.
        await own.db.createTable("orders");
        await own.db.ingest({ table: "orders", rows: [{ id: "o-1", data: { total: 42 } }] });
        await own.db.flush();

        const client = new DuckdbQuackInstance({ url: own.url, token: "own-token" });
        const { connection } = await client.raw();
        const reader = await connection.runAndReadAll("SELECT id FROM quack.orders");
        expect(reader.getRowObjectsJson()).toEqual([{ id: "o-1" }]);
        await client.close();

        await own.stop();
        expect(own.isRunning).toBe(false);

        // The listening socket went with the instance: nobody attaches any more.
        const late = new DuckdbQuackInstance({ url: own.url, token: "own-token" });
        await expect(late.connect()).rejects.toThrow(/cannot attach the quack remote/i);
    }, 90_000);

    it("starts twice without serving twice", async () => {
        const own = new DuckdbQuackServer({ port: freePort(), token: "twice" });
        await own.start();
        await expect(own.start()).resolves.toBe(own);
        await expect(own.stop()).resolves.toBeUndefined();
        await expect(own.stop()).resolves.toBeUndefined();
    }, 60_000);
});

describe("@anteros/duckdb — Quack server: options", () => {
    it("keeps the data in a file when it is given a dbPath", async () => {
        const directory = await mkdtemp(join(tmpdir(), "quack-"));
        const file = join(directory, "analytics.duckdb");

        // A server with no `dbPath` keeps nothing; this is what a `dbPath` buys.
        const first = new DuckdbQuackServer({ port: freePort(), token: "own-token", dbPath: file });
        expect(first.dbPath).toBe(file);
        await first.start();
        await first.db.createTable("orders");
        await first.db.ingest({ table: "orders", rows: [{ id: "o-1", data: { total: 42 } }] });
        await first.db.flush();
        await first.stop();

        // A brand new server, on the same file — the table is still there.
        const second = new DuckdbQuackServer({ port: freePort(), token: "own-token", dbPath: file });
        await second.start();
        const { rows } = await second.db.exec(`SELECT id, data FROM "orders"`);
        expect(rows).toEqual([{ id: "o-1", data: '{"total":42}' }]);
        await second.stop();

        await rm(directory, { recursive: true, force: true });
    }, 120_000);

    it("applies the settings it was given, readable back", async () => {
        const own = new DuckdbQuackServer({
            port: freePort(),
            token: "own-token",
            fetchBatchChunks: 32,
            identity: { name: "analytics-1", region: "eu-west-3" },
        });
        await own.start();

        const batch = (await own.db.exec("SELECT current_setting('quack_fetch_batch_chunks') AS v")).rows;
        expect(Number(batch[0]!.v)).toBe(32);

        const me = (await own.db.exec("SELECT * FROM whoami()")).rows;
        expect(me[0]!.name).toBe("analytics-1");
        expect(me[0]!.region).toBe("eu-west-3");

        await own.stop();
    }, 60_000);

    it("accepts what a client from outside the machine needs", async () => {
        // A non-loopback bind is not enough: `allow_other_hostname` lifts the
        // Host-header check, `disable_ssl` serves plain HTTP when the client asks
        // for it. The point here is that both are accepted and served.
        const own = new DuckdbQuackServer({
            port: freePort(),
            token: "own-token",
            host: "0.0.0.0",
            allowOtherHostname: true,
            disableSsl: true,
        });
        await own.start();

        // A remote client would use the server's real address; from here, loopback.
        const client = new DuckdbQuackInstance({ url: `quack:127.0.0.1:${own.port}`, token: "own-token", disableSsl: true });
        const { rows } = await client.exec("SELECT 1 AS ok");
        expect(rows).toEqual([{ ok: 1 }]);

        await client.close();
        await own.stop();
    }, 60_000);
});
