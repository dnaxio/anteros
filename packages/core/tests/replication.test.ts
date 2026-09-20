import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient, ObjectId } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import {
    startReplication,
    stopReplication,
    replicateTenant,
    getReplicationState,
} from "../database/replication";

const TEST_TENANT = "repl";
const SRC_DB = "mongodb://localhost:27017/_REPL_TEST_SRC";
const DEST_DB = "mongodb://localhost:27017/_REPL_TEST_DEST";
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

    // Connect the source DB manually with a short timeout so a missing MongoDB
    // fails fast and clearly (instead of hanging or process.exit(1)).
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
                { name: "status", type: "string" },
                { name: "customer", type: "relationship", relation: { to: "customers" } },
                { name: "paidAt", type: "date" },
            ],
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

describe("replication", () => {
    it("replicates inserted documents", async () => {
        const marker = `ins-${crypto.randomUUID()}`;
        const source: any = await rest.insertOne("orders", { title: marker, status: "new" });
        await replicateTenant(TEST_TENANT);

        const dest = await destClient.db().collection("orders").findOne({ title: marker });
        expect(dest).toBeDefined();
        expect((dest as any)?.status).toBe("new");
        // The destination keeps the **same `_id`** (the upsert is keyed on it), same BSON type
        expect((dest as any)?._id.toString()).toBe(source._id);
        expect((dest as any)?._id).toBeInstanceOf(ObjectId);
    });

    it("keeps a custom `_id` type (string) as-is", async () => {
        const marker = `custom-${crypto.randomUUID()}`;
        const customId = `order-${crypto.randomUUID()}`; // not a 24-hex string
        await sourceClient.db().collection("orders").insertOne({
            _id: customId as any,
            title: marker,
            status: "new",
            updatedAt: new Date(),
        });
        await replicateTenant(TEST_TENANT);

        const dest: any = await destClient.db().collection("orders").findOne({ title: marker });
        expect(dest).toBeDefined();
        expect(dest._id).toBe(customId);
        expect(typeof dest._id).toBe("string");
    });

    it("writes BSON types on the destination — ObjectId relations and Dates stay typed", async () => {
        const marker = `bson-${crypto.randomUUID()}`;
        const customerId = new ObjectId();
        const paidAt = new Date("2026-03-04T05:06:07.000Z");

        // Through the framework: the relation string and the ISO date are converted
        // to BSON by `toBson` before hitting MongoDB.
        const source: any = await rest.insertOne("orders", {
            title: marker,
            status: "paid",
            customer: customerId.toHexString(),
            paidAt: paidAt.toISOString(),
        });
        await replicateTenant(TEST_TENANT);

        // …and the destination must hold the same BSON types, not strings
        const dest: any = await destClient.db().collection("orders").findOne({ title: marker });
        expect(dest).toBeDefined();
        expect(dest._id).toBeInstanceOf(ObjectId);
        expect(dest._id.toString()).toBe(source._id);
        expect(dest.customer).toBeInstanceOf(ObjectId);
        expect(dest.customer.toString()).toBe(customerId.toHexString());
        expect(dest.paidAt).toBeInstanceOf(Date);
        expect(dest.paidAt.getTime()).toBe(paidAt.getTime());
        expect(dest.createdAt).toBeInstanceOf(Date);
        expect(dest.updatedAt).toBeInstanceOf(Date);

        // The source itself stores the very same types (the copy is faithful)
        const raw: any = await sourceClient.db().collection("orders").findOne({ title: marker });
        expect(raw.customer).toBeInstanceOf(ObjectId);
        expect(raw.paidAt).toBeInstanceOf(Date);
        expect(typeof raw.customer).toBe(typeof dest.customer);
    });

    it("replicates updates", async () => {
        const marker = `upd-${crypto.randomUUID()}`;
        const doc: any = await rest.insertOne("orders", { title: marker, status: "draft" });
        await replicateTenant(TEST_TENANT);

        await rest.updateOne("orders", doc._id, { $set: { status: "paid" } });
        await replicateTenant(TEST_TENANT);

        const dest = await destClient.db().collection("orders").findOne({ title: marker });
        expect((dest as any)?.status).toBe("paid");
    });

    it("replicates deletes via tombstone", async () => {
        const marker = `del-${crypto.randomUUID()}`;
        const doc: any = await rest.insertOne("orders", { title: marker, status: "x" });
        await replicateTenant(TEST_TENANT);

        const before = await destClient.db().collection("orders").findOne({ title: marker });
        expect(before).toBeDefined();

        await rest.deleteOne("orders", doc._id);
        await replicateTenant(TEST_TENANT);

        const after = await destClient.db().collection("orders").findOne({ title: marker });
        expect(after).toBeNull();
    });

    it("does not re-copy unchanged documents (cursor is persisted)", async () => {
        const marker = `resume-${crypto.randomUUID()}`;
        await rest.insertOne("orders", { title: marker, status: "new" });

        const first = await replicateTenant(TEST_TENANT);
        const second = await replicateTenant(TEST_TENANT);

        const r1 = first.find((r) => r.collection === "orders" && r.destination === DEST_ID);
        const r2 = second.find((r) => r.collection === "orders" && r.destination === DEST_ID);
        expect(r1?.inserted).toBeGreaterThanOrEqual(1);
        expect(r2?.inserted).toBe(0);
        expect(r2?.updated).toBe(0);
    });

    it("stores state in _replication_", async () => {
        await rest.insertOne("orders", { title: `state-${crypto.randomUUID()}`, status: "new" });
        await replicateTenant(TEST_TENANT);

        const state = await getReplicationState(TEST_TENANT, DEST_ID, "orders");
        expect(state.length).toBe(1);
        expect(state[0]!.status).toBe("success");
        expect(state[0]!.cursor).toBeDefined();
    });
});
