import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { formatConfig, cfg } from "../server/config";
import { syncTenants, getTenant } from "../database/tenant";
import { AUDIT_COLLECTION, AUDIT_TTL_INDEX, resolveAuditRetention } from "../database/audit";

const SERVER_RETENTION = "30d";

const INHERIT = "ret-inherit";
const OVERRIDE = "ret-override";
const OFF = "ret-off";

const DBS = {
    [INHERIT]: "mongodb://localhost:27017/_AUDIT_RET_INHERIT",
    [OVERRIDE]: "mongodb://localhost:27017/_AUDIT_RET_OVERRIDE",
    [OFF]: "mongodb://localhost:27017/_AUDIT_RET_OFF",
} as const;

/** TTL index of a tenant's `_audit_` collection, or undefined. */
async function ttlIndex(tenantId: string): Promise<any> {
    const db = getTenant(tenantId)!.database!.db!;
    return (await db.collection(AUDIT_COLLECTION).listIndexes().toArray())
        .find((i: any) => i.name === AUDIT_TTL_INDEX);
}

beforeAll(async () => {
    formatConfig({
        server: {
            port: 4000,
            // Server-wide default — every tenant inherits it unless it declares its own
            audit: { retention: SERVER_RETENTION },
        },
        tenants: [
            { id: INHERIT, dir: "src", database: { uri: DBS[INHERIT] } },
            { id: OVERRIDE, dir: "src", database: { uri: DBS[OVERRIDE] }, audit: { retention: "1h" } },
            { id: OFF, dir: "src", database: { uri: DBS[OFF] }, audit: { retention: false } },
        ],
    });

    await syncTenants();
});

afterAll(async () => {
    for (const id of Object.keys(DBS)) {
        try { await getTenant(id)?.database?.db?.collection(AUDIT_COLLECTION).drop(); } catch (_) {}
    }
    // `cfg.server` is shared by every test file in the same process: the server-wide
    // retention would otherwise leak into the other suites
    delete (cfg.server as any).audit;
});

describe("audit retention precedence", () => {
    it("resolves: the tenant wins, the server default is the fallback", () => {
        const base = { dir: "src", database: { uri: "" } };

        expect(resolveAuditRetention({ id: INHERIT, ...base } as any)).toBe(SERVER_RETENTION);
        expect(resolveAuditRetention({ id: OVERRIDE, ...base, audit: { retention: "1h" } } as any)).toBe("1h");
        // `false` is a value, not an absence — it must override the server default
        expect(resolveAuditRetention({ id: OFF, ...base, audit: { retention: false } } as any)).toBe(false);
    });

    it("applies the server default to a tenant without its own config", async () => {
        const ttl = await ttlIndex(INHERIT);
        expect(ttl).toBeDefined();
        expect(ttl.expireAfterSeconds).toBe(30 * 86400);
    });

    it("lets the tenant override the server default", async () => {
        const ttl = await ttlIndex(OVERRIDE);
        expect(ttl).toBeDefined();
        expect(ttl.expireAfterSeconds).toBe(3600);
    });

    it("lets the tenant opt out of the server default with `false`", async () => {
        expect(await ttlIndex(OFF)).toBeUndefined();
    });
});
