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

/** Poll `check` until it holds — a change stream is asynchronous by nature. */
async function waitFor(check: () => Promise<boolean>, timeout = 8_000, step = 50): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await Bun.sleep(step);
    }
    return false;
}

const onDest = (filter: Record<string, any>) => destClient.db().collection("orders").findOne(filter);
const countOnDest = (filter: Record<string, any> = {}) => destClient.db().collection("orders").countDocuments(filter);

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{
            id: TEST_TENANT,
            dir: "src",
            database: { uri: SRC_DB },
            replication: {
                runOnBoot: false,
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
        expect(await waitFor(async () => Boolean(await onDest({ title: marker })))).toBe(true);

        const dest: any = await onDest({ title: marker });
        expect(dest?.status).toBe("new");
        // The destination keeps the **same `_id`** (the upsert is keyed on it), same BSON type
        expect(dest?._id.toString()).toBe(source._id);
        expect(dest?._id).toBeInstanceOf(ObjectId);
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
        expect(await waitFor(async () => Boolean(await onDest({ title: marker })))).toBe(true);

        const dest: any = await onDest({ title: marker });
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
        expect(await waitFor(async () => Boolean(await onDest({ title: marker })))).toBe(true);

        // …and the destination must hold the same BSON types, not strings
        const dest: any = await onDest({ title: marker });
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

    it("replicates updates in place", async () => {
        const marker = `upd-${crypto.randomUUID()}`;
        const doc: any = await rest.insertOne("orders", { title: marker, status: "draft" });
        expect(await waitFor(async () => Boolean(await onDest({ title: marker })))).toBe(true);

        await rest.updateOne("orders", doc._id, { $set: { status: "paid" } });
        expect(await waitFor(async () => (await onDest({ title: marker }))?.status === "paid")).toBe(true);
        expect(await countOnDest({ title: marker })).toBe(1);
    });

    it("propagates deletes from the oplog", async () => {
        const marker = `del-${crypto.randomUUID()}`;
        const doc: any = await rest.insertOne("orders", { title: marker, status: "x" });
        expect(await waitFor(async () => Boolean(await onDest({ title: marker })))).toBe(true);

        await rest.deleteOne("orders", doc._id);
        expect(await waitFor(async () => (await countOnDest({ title: marker })) === 0)).toBe(true);
    });

    it("leaves a streamed collection alone when a run is triggered", async () => {
        // The stream owns `orders`: a one-shot run takes no lock on it and reports
        // nothing, because a backfill on top of a live stream could overwrite a
        // newer event with a stale read
        const results = await replicateTenant(TEST_TENANT);
        expect(results.find((result) => result.collection === "orders")).toBeUndefined();
    });

    it("stores the stream position in _replication_", async () => {
        const marker = `state-${crypto.randomUUID()}`;
        await rest.insertOne("orders", { title: marker, status: "new" });
        expect(await waitFor(async () => Boolean(await onDest({ title: marker })))).toBe(true);

        const state = await getReplicationState(TEST_TENANT, DEST_ID, "orders");
        expect(state.length).toBe(1);
        expect(state[0]!.status).toBe("watching");
        expect(state[0]!.resumeToken).toBeDefined();
        expect(state[0]!.key).toBe("updatedAt");
    });
});
