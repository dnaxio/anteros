import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoClient } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { writeAuditQuack, stopAuditQuack } from "../lib/auditQuack";

const TENANT = "audit-quack";
const SRC_DB = "mongodb://localhost:27017/_AUDIT_QUACK_SRC";
const TABLE = "audit_test";

let rest: InstanceType<typeof useRest>;
let sourceClient: MongoClient;
let dir: string;
let dbPath: string;

/** Read the mirror with a fresh instance — `flush`/`close` already ran. */
async function rows(sql: string): Promise<Record<string, any>[]> {
    const { DuckdbQuackInstance } = await import("@anteros/duckdb");
    const db = new DuckdbQuackInstance({ dbPath });
    try {
        const result = await db.exec(sql);
        return result.rows as Record<string, any>[];
    } finally {
        await db.close().catch(() => {});
    }
}

beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "audit-quack-"));
    dbPath = path.join(dir, "audit.duckdb");

    formatConfig({
        server: { port: 4000 },
        tenants: [{
            id: TENANT,
            dir: "src",
            database: { uri: SRC_DB },
            audit: { quack: { url: dbPath, table: TABLE, ttl: false } },
        }],
    });

    sourceClient = new MongoClient(SRC_DB, { serverSelectionTimeoutMS: 3000 });
    await sourceClient.connect();
    const tenant: any = cfg.tenants?.[0];
    tenant.database.client = sourceClient;
    tenant.database.db = sourceClient.db();

    rest = new useRest({ tenant_id: TENANT });
});

afterAll(async () => {
    await stopAuditQuack();
    try { await sourceClient.db().dropDatabase(); } catch (_) {}
    try { await sourceClient.close(); } catch (_) {}
    rmSync(dir, { recursive: true, force: true });
});

describe("audit — DuckDB mirror", () => {
    it("mirrors an activity into the configured table", async () => {
        await rest.audit.addActivities([{
            internal: true,
            trace: { id: crypto.randomUUID() },
            meta: {},
            operation: {
                tenant: TENANT, action: "mirror-me", collection: "orders",
                status: "success", input: null, result: null, error: null, duration: 0, transaction: false,
            },
            ts: new Date(),
        } as any]);

        await stopAuditQuack(); // drains the engine queue and closes the instance

        const found = await rows(
            `SELECT json_extract_string(data, '$.operation.action') AS action,
                    json_extract_string(data, '$.operation.collection') AS collection,
                    ts
             FROM ${TABLE}`,
        );
        expect(found.length).toBe(1);
        expect(found[0]!.action).toBe("mirror-me");
        expect(found[0]!.collection).toBe("orders");
        // `ts` is a real column (what the retention job purges on), set from the entry
        expect(found[0]!.ts).toBeDefined();
    }, 30_000);

    it("mirrors what `_audit_` holds — redacted, never the secret", async () => {
        await rest.audit.addActivities([{
            internal: true,
            trace: { id: crypto.randomUUID() },
            meta: {},
            operation: {
                tenant: TENANT, action: "login", collection: "users",
                status: "success",
                input: { email: "a@b.c", password: "s3cr3t" },
                result: null, error: null, duration: 0, transaction: false,
            },
            ts: new Date(),
        } as any]);

        await stopAuditQuack();

        const found = await rows(
            `SELECT json_extract_string(data, '$.operation.input.password') AS password,
                    json_extract_string(data, '$.operation.input.email') AS email
             FROM ${TABLE} WHERE json_extract_string(data, '$.operation.action') = 'login'`,
        );
        expect(found.length).toBe(1);
        expect(found[0]!.password).toBe("[redacted]");
        expect(found[0]!.email).toBe("a@b.c");

        // The primary store keeps the same redacted value, and both copies agree
        const stored: any = await rest.db.collection("_audit_").findOne({ "operation.action": "login" });
        expect(stored.operation.input.password).toBe("[redacted]");
    }, 30_000);

    it("arms the purge only once the table exists (a fresh mirror logs no error)", async () => {
        const errors: Error[] = [];
        const tenant: any = cfg.tenants?.find((t) => t.id === TENANT);
        const table = "audit_ttl";

        tenant.audit.quack = {
            url: dbPath, table, ttl: "90d", purgeEvery: "1h",
            onError: (error: Error) => errors.push(error),
        };
        try {
            await rest.audit.addActivities([{
                internal: true,
                trace: { id: crypto.randomUUID() },
                meta: {},
                operation: {
                    tenant: TENANT, action: "with-ttl", collection: "orders",
                    status: "success", input: null, result: null, error: null, duration: 0, transaction: false,
                },
                ts: new Date(),
            } as any]);
            await stopAuditQuack();
        } finally {
            tenant.audit.quack = { url: dbPath, table: TABLE, ttl: false };
        }

        // A `retention()` armed before the first `ingest()` would purge a missing table
        expect(errors).toEqual([]);
        const found = await rows(`SELECT count(*) AS n FROM ${table}`);
        expect(Number(found[0]!.n)).toBe(1);
    }, 30_000);
});

describe("audit — DuckDB mirror opt-out", () => {
    it("writes nothing when `quack` is false, and never throws", async () => {
        const tenant: any = cfg.tenants?.find((t) => t.id === TENANT);
        const before = await rows(`SELECT count(*) AS n FROM ${TABLE}`);

        tenant.audit.quack = false;
        try {
            // A mirror that is not configured must be a no-op: no instance, no error
            expect(() => writeAuditQuack(tenant, [{ ts: new Date(), operation: { action: "ignored" } }])).not.toThrow();
            await stopAuditQuack();
        } finally {
            tenant.audit.quack = { url: dbPath, table: TABLE, ttl: false };
        }

        const after = await rows(`SELECT count(*) AS n FROM ${TABLE}`);
        expect(after[0]!.n).toBe(before[0]!.n);
    }, 30_000);
});
