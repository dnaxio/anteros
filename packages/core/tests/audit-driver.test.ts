import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MongoClient } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { stopAuditQuack } from "../lib/auditQuack";

const TENANT = "audit-driver";
const SRC_DB = "mongodb://localhost:27017/_AUDIT_DRIVER_SRC";
const TABLE = "audit_test";

let rest: InstanceType<typeof useRest>;
let sourceClient: MongoClient;
let root: string;
let filesDir: string;
let dbPath: string;

const tenant = () => (cfg.tenants ?? []).find((t) => t.id === TENANT) as any;

/** An activity carrying a marker, so each case can be isolated. */
function activity(marker: string): any {
    return {
        internal: true,
        trace: { id: crypto.randomUUID() },
        meta: {},
        operation: {
            tenant: TENANT, action: marker, collection: "orders",
            status: "success", input: null, result: null, error: null, duration: 0, transaction: false,
        },
        ts: new Date(),
    };
}

const inCollection = (marker: string) =>
    rest.db.collection("_audit_").countDocuments({ "operation.action": marker });

/** Every JSONL line written for this tenant, parsed. */
function fileLines(): any[] {
    const lines: any[] = [];
    for (const entry of readdirSync(filesDir)) {
        if (!entry.endsWith(".jsonl")) continue;
        for (const line of readFileSync(path.join(filesDir, entry), "utf8").split("\n")) {
            if (!line.trim()) continue;
            try { lines.push(JSON.parse(line)); } catch { /* partial line */ }
        }
    }
    return lines;
}

async function duckdbCount(marker: string): Promise<number> {
    await stopAuditQuack(); // drain the engine queue first
    const { DuckdbQuackInstance } = await import("@anteros/duckdb");
    const db = new DuckdbQuackInstance({ dbPath });
    try {
        const result = await db.exec(
            `SELECT count(*) AS n FROM ${TABLE} WHERE json_extract_string(data, '$.operation.action') = '${marker}'`,
        );
        return Number((result.rows[0] as any)?.n ?? 0);
    } finally {
        await db.close().catch(() => {});
    }
}

beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "audit-driver-"));
    filesDir = path.join(root, "audit");
    dbPath = path.join(root, "audit.duckdb");

    formatConfig({
        server: { port: 4000 },
        tenants: [{
            id: TENANT,
            dir: "src",
            database: { uri: SRC_DB },
            audit: {
                driver: "default",
                file: { dir: filesDir },
                quack: { url: dbPath, table: TABLE, ttl: false },
            },
        }],
    });

    sourceClient = new MongoClient(SRC_DB, { serverSelectionTimeoutMS: 3000 });
    await sourceClient.connect();
    const cfgTenant: any = cfg.tenants?.[0];
    cfgTenant.database.client = sourceClient;
    cfgTenant.database.db = sourceClient.db();

    rest = new useRest({ tenant_id: TENANT });
});

afterAll(async () => {
    await stopAuditQuack();
    try { await sourceClient.db().dropDatabase(); } catch (_) {}
    try { await sourceClient.close(); } catch (_) {}
    rmSync(root, { recursive: true, force: true });
});

describe("audit — driver", () => {
    it("'default' writes _audit_, and the configured copies along with it", async () => {
        const marker = `default-${crypto.randomUUID()}`;
        await rest.audit.addActivities([activity(marker)]);

        expect(await inCollection(marker)).toBe(1);
        expect(await duckdbCount(marker)).toBe(1);
        expect(fileLines().some((line) => line.operation?.action === marker)).toBe(true);
    }, 30_000);

    it("'quack' writes the DuckDB table instead of _audit_", async () => {
        const marker = `quack-${crypto.randomUUID()}`;
        tenant().audit.driver = "quack";
        try {
            await rest.audit.addActivities([activity(marker)]);
        } finally {
            tenant().audit.driver = "default";
        }

        expect(await duckdbCount(marker)).toBe(1);
        expect(await inCollection(marker)).toBe(0);
        expect(fileLines().some((line) => line.operation?.action === marker)).toBe(false);
    }, 30_000);

    it("'file' writes the JSONL file instead of _audit_", async () => {
        const marker = `file-${crypto.randomUUID()}`;
        tenant().audit.driver = "file";
        try {
            // Awaited when the file is the only copy: the line is on disk when this resolves
            await rest.audit.addActivities([activity(marker)]);
        } finally {
            tenant().audit.driver = "default";
        }

        expect(fileLines().some((line) => line.operation?.action === marker)).toBe(true);
        expect(await inCollection(marker)).toBe(0);
        expect(await duckdbCount(marker)).toBe(0);
    }, 30_000);

    it("falls back to _audit_ when the selected driver is not configured", async () => {
        const marker = `fallback-${crypto.randomUUID()}`;
        tenant().audit.driver = "file";
        tenant().audit.file = false; // 'file' selected, no file to write to
        try {
            await rest.audit.addActivities([activity(marker)]);
        } finally {
            tenant().audit.driver = "default";
            tenant().audit.file = { dir: filesDir };
        }

        // Never silence: the entry lands in the default store, with one warning
        expect(await inCollection(marker)).toBe(1);
    }, 30_000);
});
