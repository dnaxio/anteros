import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { syncVars } from "../database/vars";
import { startReplication, stopReplication, replicateTenant } from "../database/replication";

const TEST_TENANT = "vars-repl";
const SRC_DB = "mongodb://localhost:27017/_VARS_REPL_SRC";
const DEST_DB = "mongodb://localhost:27017/_VARS_REPL_DEST";

let rest: InstanceType<typeof useRest>;
let sourceClient: MongoClient;
let destClient: MongoClient;

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{
            id: TEST_TENANT,
            dir: "packages/core/tests/fixtures/vars-tenant",
            database: { uri: SRC_DB },
            replication: {
                runOnBoot: false,
                schedule: { interval: "1h" },
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
        await replicateTenant(TEST_TENANT);

        expect((await destVar("licence"))?.value).toBe("REPL-1");

        // Seeded defaults are replicated too
        expect((await destVar("maxUsers"))?.value).toBe(100);
    });

    it("propagates variable deletion", async () => {
        await rest.vars.set("config", "tmp", "x", { ttl: "1h" });
        await replicateTenant(TEST_TENANT);
        expect(await destVar("tmp")).toBeDefined();

        await rest.vars.del("config", "tmp");
        await replicateTenant(TEST_TENANT);
        expect(await destVar("tmp")).toBeNull();
    });

    it("propagates scoped variables", async () => {
        const mine = "aabbccddeeff001122334455";
        await rest.vars.scope(mine).set("config", "licence", "SCOPED-1");
        await replicateTenant(TEST_TENANT);

        const dest = await destClient.db().collection("_vars_").findOne({
            ns: "config", key: "licence", scope: { $ne: null },
        });
        expect(dest?.value).toBe("SCOPED-1");
    });

    it("does NOT replicate namespaces that did not opt in", async () => {
        // `private.var.ts` has no `replication` — it must never reach the destination.
        await rest.vars.set("private", "secret", "top-secret");
        await replicateTenant(TEST_TENANT);

        expect(await destClient.db().collection("_vars_").findOne({ ns: "private" })).toBeNull();
    });
});
