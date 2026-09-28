/**
 * Change-stream replication — the **default** mode (`replication.mode` unset).
 *
 * What separates it from the scan engine, and what these cases pin down:
 *  - nothing has to be triggered: a write reaches the destination on its own;
 *  - deletes come from the oplog, so a collection **without hooks** propagates them
 *    too (the scan engine can only see applicative tombstones, which is why an
 *    `_audit_` entry deleted out of band used to survive on the destination);
 *  - the position is a resume token, not a date cursor;
 *  - the stream owns a collection, so a one-shot run leaves it alone;
 *  - `reset()` re-arms the stream, which cold-starts again.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { syncCollections } from "../database/collection";
import { syncVars } from "../database/vars";
import {
    startReplication,
    stopReplication,
    replicateTenant,
    getReplicationState,
    resetReplication,
} from "../database/replication";
import { AUDIT_COLLECTION } from "../database/audit";

const ORDERS_T = "cs-orders";
const ORDERS_DIR = "packages/core/tests/fixtures/replication-meta";
const ORDERS_SRC = "mongodb://localhost:27017/_CS_SRC";
const ORDERS_DST = "mongodb://localhost:27017/_CS_DST";
const DEST_ID = "backup";

const VARS_T = "cs-vars";
const VARS_DIR = "packages/core/tests/fixtures/vars-tenant";
const VARS_SRC = "mongodb://localhost:27017/_CS_VARS_SRC";
const VARS_DST = "mongodb://localhost:27017/_CS_VARS_DST";

let rest: InstanceType<typeof useRest>;
let restVars: InstanceType<typeof useRest>;
let src: MongoClient;
let dest: MongoClient;
let varsDest: MongoClient;

/** Poll `check` until it holds — a change stream is asynchronous by nature. */
async function waitFor(check: () => Promise<boolean>, timeout = 8_000, step = 50): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await Bun.sleep(step);
    }
    return false;
}

const ordersDest = () => dest.db().collection("orders");
const auditDest = () => dest.db().collection(AUDIT_COLLECTION);
const varsOnDest = (ns: string, key: string) => varsDest.db().collection("_vars_").findOne({ ns, key });

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [
            {
                id: ORDERS_T,
                dir: ORDERS_DIR,
                database: { uri: ORDERS_SRC },
                // No `mode`: change streams are the default. No `key`, no `batchSize`,
                // no `schedule` either — the stream is the whole engine.
                replication: { runOnBoot: false, destinations: [{ id: DEST_ID, uri: ORDERS_DST }] },
            },
            {
                id: VARS_T,
                dir: VARS_DIR,
                database: { uri: VARS_SRC },
                replication: { runOnBoot: false, destinations: [{ id: "backup", uri: VARS_DST }] },
            },
        ],
    });

    await syncTenants();
    await syncCollections();
    await syncVars();
    await startReplication();

    rest = new useRest({ tenant_id: ORDERS_T });
    restVars = new useRest({ tenant_id: VARS_T });
    src = new MongoClient(ORDERS_SRC, { serverSelectionTimeoutMS: 3000 });
    dest = new MongoClient(ORDERS_DST, { serverSelectionTimeoutMS: 3000 });
    varsDest = new MongoClient(VARS_DST, { serverSelectionTimeoutMS: 3000 });
    await Promise.all([src.connect(), dest.connect(), varsDest.connect()]);
});

afterAll(async () => {
    await stopReplication();
    for (const uri of [ORDERS_SRC, ORDERS_DST, VARS_SRC, VARS_DST]) {
        try {
            const client = new MongoClient(uri);
            await client.connect();
            await client.db().dropDatabase();
            await client.close();
        } catch (_) {}
    }
    cfg.agents = [];
    cfg.agentMemories = [];
    try { await src.close(); } catch (_) {}
    try { await dest.close(); } catch (_) {}
    try { await varsDest.close(); } catch (_) {}
});

describe("replication — changeStream mode", () => {
    it("replicates a write on its own, with no run to trigger", async () => {
        const marker = `cs-insert-${crypto.randomUUID()}`;
        await rest.insertOne("orders", { title: marker });

        // No `replicateTenant()` call anywhere: the stream is the engine
        expect(await waitFor(async () => Boolean(await ordersDest().findOne({ title: marker })))).toBe(true);
    });

    it("replicates an update in place", async () => {
        const marker = `cs-update-${crypto.randomUUID()}`;
        const doc: any = await rest.insertOne("orders", { title: marker });
        expect(await waitFor(async () => Boolean(await ordersDest().findOne({ title: marker })))).toBe(true);

        await rest.updateOne("orders", doc._id, { $set: { title: `${marker}-paid` } });
        expect(await waitFor(async () => (await ordersDest().countDocuments({ title: `${marker}-paid` })) === 1)).toBe(true);
    });

    it("propagates a delete without writing a tombstone", async () => {
        const marker = `cs-delete-${crypto.randomUUID()}`;
        const doc: any = await rest.insertOne("orders", { title: marker });
        expect(await waitFor(async () => Boolean(await ordersDest().findOne({ title: marker })))).toBe(true);

        await rest.deleteOne("orders", doc._id);
        expect(await waitFor(async () => (await ordersDest().countDocuments({ title: marker })) === 0)).toBe(true);

        // The oplog carried it: the hook + tombstone path is not even installed here
        const tombstones = await src.db().collection("_replication_").countDocuments({ type: "delete", collection: "orders" });
        expect(tombstones).toBe(0);
    });

    it("propagates a delete on a framework collection no hook can see", async () => {
        const marker = `cs-audit-${crypto.randomUUID()}`;
        await rest.audit.addActivities([{
            internal: true,
            trace: { id: crypto.randomUUID() },
            meta: {},
            operation: {
                tenant: ORDERS_T, action: marker, collection: "orders",
                status: "success", input: null, result: null, error: null, duration: 0, transaction: false,
            },
            ts: new Date(),
        } as any]);
        expect(await waitFor(async () => Boolean(await auditDest().findOne({ "operation.action": marker })))).toBe(true);

        // Out of band: no applicative hook runs, no tombstone is written — the scan
        // engine would leave this entry on the destination forever
        await src.db().collection(AUDIT_COLLECTION).deleteOne({ "operation.action": marker } as any);

        expect(await waitFor(async () => (await auditDest().countDocuments({ "operation.action": marker })) === 0)).toBe(true);
    }, 20_000);

    it("stores a resume token in `_replication_`, tagged with the mode", async () => {
        const [state] = await getReplicationState(ORDERS_T, DEST_ID, "orders");
        expect(state?.mode).toBe("changeStream");
        expect(state?.resumeToken).toBeDefined();
        expect(state?.status).toBe("watching");
    });

    it("leaves a streamed collection alone when a run is triggered", async () => {
        const results = await replicateTenant(ORDERS_T);

        // The stream owns it: a scan on top would let a stale read overwrite a fresh
        // event, so the run reports nothing for that collection
        expect(results.find((result) => result.collection === "orders")).toBeUndefined();
    });

    it("cold-starts again after `reset()` — the position is really cleared", async () => {
        const marker = `cs-reset-${crypto.randomUUID()}`;
        await rest.insertOne("orders", { title: marker });
        expect(await waitFor(async () => Boolean(await ordersDest().findOne({ title: marker })))).toBe(true);

        // Lose the copy, then forget the position: only a backfill can bring it back
        await ordersDest().deleteMany({});
        const reset = await resetReplication(ORDERS_T, { destination: DEST_ID, collection: "orders" });
        expect(reset.state).toBeGreaterThanOrEqual(1);

        expect(await waitFor(async () => (await ordersDest().countDocuments({ title: marker })) === 1, 20_000)).toBe(true);
    }, 30_000);

    it("applies the collection's document filter to the stream (`_vars_` namespaces)", async () => {
        const marker = `cs-vars-${crypto.randomUUID()}`;
        await restVars.vars.set("config", marker, "REPLICATED");
        await restVars.vars.set("private", "secret", marker);

        expect(await waitFor(async () => Boolean(await varsOnDest("config", marker)))).toBe(true);
        // `private.var.ts` opts out: the filter is on the post-image, so the stream
        // never even writes it
        expect(await varsOnDest("private", "secret")).toBeNull();
    });
});

describe("replication — changeStream shutdown", () => {
    it("stops writing once replication is stopped", async () => {
        await stopReplication();

        const marker = `cs-after-stop-${crypto.randomUUID()}`;
        await rest.insertOne("orders", { title: marker });
        await Bun.sleep(1_500); // long enough for a stream that is still alive

        expect(await ordersDest().countDocuments({ title: marker })).toBe(0);
    });

    it("does not wait forever on a collection another writer owns", async () => {
        // A stream elsewhere already owns `orders`; this boot must not block on it
        await rest.lock(`replication:${DEST_ID}:orders`, 60_000);

        const startedAt = Date.now();
        await startReplication();
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThan(25_000);

        // …and the collections it *could* take are still watched: an entry written
        // with no run reaches the destination while `orders` is skipped
        const marker = `cs-partial-${crypto.randomUUID()}`;
        await rest.audit.addActivities([{
            internal: true,
            trace: { id: crypto.randomUUID() },
            meta: {},
            operation: {
                tenant: ORDERS_T, action: marker, collection: "orders",
                status: "success", input: null, result: null, error: null, duration: 0, transaction: false,
            },
            ts: new Date(),
        } as any]);

        expect(await waitFor(async () => (await auditDest().countDocuments({ "operation.action": marker })) === 1)).toBe(true);
    }, 60_000);
});
