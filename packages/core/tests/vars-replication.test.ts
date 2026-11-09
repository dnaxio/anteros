import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { syncVars } from "../database/vars";
import { startReplication, stopReplication } from "../database/replication";

const TEST_TENANT = "vars-repl";
const SRC_DB = "mongodb://localhost:27017/_VARS_REPL_SRC";
const DEST_DB = "mongodb://localhost:27017/_VARS_REPL_DEST";

let rest: InstanceType<typeof useRest>;
let sourceClient: MongoClient;
let destClient: MongoClient;

/** Poll `check` until it holds — a change stream is asynchronous by nature. */
async function waitFor(check: () => Promise<boolean>, timeout = 8_000, step = 50): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await Bun.sleep(step);
    }
    return false;
}

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{
            id: TEST_TENANT,
            dir: "packages/core/tests/fixtures/vars-tenant",
            database: { uri: SRC_DB },
            replication: {
                runOnBoot: false,
                destinations: [{ id: "backup", uri: DEST_DB }],
            },
        }],
    });

    sourceClient = new MongoClient(SRC_DB, { serverSelectionTimeoutMS: 3000 });
    await sourceClient.connect();
    const tenant: any = cfg.tenants?.[0];
    tenant.database.client = sourceClient;
    tenant.database.db = sourceClient.db();

    await syncVars();
    await startReplication();

    rest = new useRest({ tenant_id: TEST_TENANT });
    destClient = new MongoClient(DEST_DB, { serverSelectionTimeoutMS: 3000 });
    await destClient.connect();
});

afterAll(async () => {
    await stopReplication();
    try { await sourceClient.db().dropDatabase(); } catch (_) {}
    try { await destClient.db().dropDatabase(); } catch (_) {}
    try { await destClient.close(); } catch (_) {}
    try { await sourceClient.close(); } catch (_) {}
});

const destVar = (key: string, ns = "config") =>
    destClient.db().collection("_vars_").findOne({ ns, key });

describe("vars replication", () => {
    it("replicates the `_vars_` collection (all namespaces)", async () => {
        await rest.vars.set("config", "licence", "REPL-1");
        expect(await waitFor(async () => Boolean(await destVar("licence")))).toBe(true);
        expect((await destVar("licence"))?.value).toBe("REPL-1");

        // Seeded defaults existed before the stream started: the cold-start backfill
        // copies them
        expect(await waitFor(async () => Boolean(await destVar("maxUsers")))).toBe(true);
        expect((await destVar("maxUsers"))?.value).toBe(100);
    });

    it("propagates variable deletion", async () => {
        await rest.vars.set("config", "tmp", "x", { ttl: "1h" });
        expect(await waitFor(async () => Boolean(await destVar("tmp")))).toBe(true);

        await rest.vars.del("config", "tmp");
        expect(await waitFor(async () => (await destVar("tmp")) === null)).toBe(true);
    });

    it("propagates scoped variables", async () => {
        const mine = "aabbccddeeff001122334455";
        await rest.vars.scope(mine).set("config", "licence", "SCOPED-1");

        expect(await waitFor(async () => {
            const dest = await destClient.db().collection("_vars_").findOne({
                ns: "config", key: "licence", scope: { $ne: null },
            });
            return dest?.value === "SCOPED-1";
        })).toBe(true);
    });

    it("does NOT replicate namespaces that opt out (`enabled: false`)", async () => {
        // `private.var.ts` declares `replication: { enabled: false }` — the stream's
        // post-image filter drops it, so it must never reach the destination.
        await rest.vars.set("private", "secret", "top-secret");
        await Bun.sleep(500); // long enough for an unfiltered event to land

        expect(await destClient.db().collection("_vars_").findOne({ ns: "private" })).toBeNull();
    });
});
