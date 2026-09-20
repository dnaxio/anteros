import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { startReplication, stopReplication, replicateTenant } from "../database/replication";

const TEST_TENANT = "replinit";
const SRC_DB = "mongodb://localhost:27017/_REPL_INIT_SRC";
const DEST_DB = "mongodb://localhost:27017/_REPL_INIT_DEST";
const DEST_ID = "backup";

let rest: InstanceType<typeof useRest>;
let sourceClient: MongoClient;
let destClient: MongoClient;

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{
            id: TEST_TENANT,
            dir: "src",
            database: { uri: SRC_DB },
            replication: {
                runOnBoot: false,
                schedule: { interval: "1h" },
                destinations: [{ id: DEST_ID, uri: DEST_DB }],
            },
        }],
    });

    sourceClient = new MongoClient(SRC_DB, { serverSelectionTimeoutMS: 3000 });
    await sourceClient.connect();
    const tenant: any = cfg.tenants?.[0];
    tenant.database.client = sourceClient;
    tenant.database.db = sourceClient.db();

    (cfg as any).collections = [
        {
            _tenant_: TEST_TENANT,
            slug: "orders",
            fields: [
                { name: "title", type: "string" },
            ],
            // Start at the latest document — skip everything that already exists.
            replication: { enabled: true, initialSync: "latest" },
        },
    ];

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

describe("replication initialSync", () => {
    it("skips pre-existing documents with initialSync: 'latest'", async () => {
        await rest.insertOne("orders", { title: `old-1-${crypto.randomUUID()}` });
        await rest.insertOne("orders", { title: `old-2-${crypto.randomUUID()}` });

        await replicateTenant(TEST_TENANT);

        const count = await destClient.db().collection("orders").countDocuments();
        expect(count).toBe(0); // existing docs are NOT backfilled
    });

    it("replicates documents added after the initial sync", async () => {
        await Bun.sleep(5); // ensure the new doc has a strictly newer updatedAt

        const marker = `new-${crypto.randomUUID()}`;
        await rest.insertOne("orders", { title: marker });

        await replicateTenant(TEST_TENANT);

        const dest = await destClient.db().collection("orders").findOne({ title: marker });
        expect(dest).toBeDefined();
    });
});
