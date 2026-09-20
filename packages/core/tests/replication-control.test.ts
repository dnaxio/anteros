import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import {
    startReplication,
    stopReplication,
    replicateTenant,
    getReplicationState,
    resetReplication,
    seedReplication,
} from "../database/replication";

const TEST_TENANT = "replreset";
const SRC_DB = "mongodb://localhost:27017/_REPL_RESET_SRC";
const DEST_DB = "mongodb://localhost:27017/_REPL_RESET_DEST";
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
            fields: [{ name: "title", type: "string" }],
            replication: { enabled: true },
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

describe("replication reset", () => {
    it("clears state and re-runs from scratch", async () => {
        await rest.insertOne("orders", { title: `reset-${crypto.randomUUID()}` });
        await replicateTenant(TEST_TENANT);

        const before = await getReplicationState(TEST_TENANT, DEST_ID, "orders");
        expect(before.length).toBe(1);
        expect(before[0]!.status).toBe("success");

        const result = await resetReplication(TEST_TENANT);
        expect(result.state).toBeGreaterThanOrEqual(1);

        const after = await getReplicationState(TEST_TENANT, DEST_ID, "orders");
        expect(after.length).toBe(0);

        // Next run re-creates the state (fresh cursor)
        await replicateTenant(TEST_TENANT);
        const recreated = await getReplicationState(TEST_TENANT, DEST_ID, "orders");
        expect(recreated.length).toBe(1);
        expect(recreated[0]!.cursor.value).not.toBeNull();
    });

    it("supports scoping by destination", async () => {
        await resetReplication(TEST_TENANT, { destination: DEST_ID });
        const state = await getReplicationState(TEST_TENANT, DEST_ID);
        expect(state.length).toBe(0);
    });
});

describe("replication seed", () => {
    const findDest = (title: string) => destClient.db().collection("orders").findOne({ title });

    it("seeds 'latest' so pre-existing documents are skipped", async () => {
        await resetReplication(TEST_TENANT);
        const preMarker = `pre-${crypto.randomUUID()}`;
        await rest.insertOne("orders", { title: preMarker });

        const res = await seedReplication(TEST_TENANT, "latest");
        expect(res.seeded).toBe(1);

        await replicateTenant(TEST_TENANT);
        expect(await findDest(preMarker)).toBeNull(); // nothing backfilled

        await Bun.sleep(5);
        const postMarker = `post-${crypto.randomUUID()}`;
        await rest.insertOne("orders", { title: postMarker });
        await replicateTenant(TEST_TENANT);

        expect(await findDest(postMarker)).toBeDefined(); // only the new document
    });

    it("seeds from an explicit date", async () => {
        await resetReplication(TEST_TENANT);
        const res = await seedReplication(TEST_TENANT, "2020-01-01T00:00:00Z");
        expect(res.seeded).toBe(1);

        const state = await getReplicationState(TEST_TENANT, DEST_ID, "orders");
        expect(state.length).toBe(1);
        expect((state[0]!.cursor.value as any).toISOString()).toBe("2020-01-01T00:00:00.000Z");
    });
});
