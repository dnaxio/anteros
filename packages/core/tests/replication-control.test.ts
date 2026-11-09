import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import {
    startReplication,
    stopReplication,
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

/** Poll `check` until it holds — a change stream is asynchronous by nature. */
async function waitFor(check: () => Promise<boolean>, timeout = 8_000, step = 50): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await Bun.sleep(step);
    }
    return false;
}

const findDest = (title: string) => destClient.db().collection("orders").findOne({ title });
const ordersState = () => getReplicationState(TEST_TENANT, DEST_ID, "orders");

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
    it("clears the state and lets the stream cold-start again", async () => {
        const marker = `reset-${crypto.randomUUID()}`;
        await rest.insertOne("orders", { title: marker });
        expect(await waitFor(async () => Boolean(await findDest(marker)))).toBe(true);

        // Lose the copy, then forget the position: only a fresh backfill brings it back
        await destClient.db().collection("orders").deleteMany({});
        const result = await resetReplication(TEST_TENANT);
        expect(result.state).toBeGreaterThanOrEqual(1);

        expect(await waitFor(async () => Boolean(await findDest(marker)), 20_000)).toBe(true);
    }, 30_000);

    it("writes a new resume token once the re-armed stream applies an event", async () => {
        const marker = `again-${crypto.randomUUID()}`;
        await rest.insertOne("orders", { title: marker });
        expect(await waitFor(async () => Boolean(await findDest(marker)))).toBe(true);

        expect(await waitFor(async () => {
            const [state] = await ordersState();
            return Boolean(state?.resumeToken);
        })).toBe(true);
    }, 30_000);

    it("supports scoping by destination and collection", async () => {
        // Exactly one state document matches, out of the six replicated collections
        const result = await resetReplication(TEST_TENANT, { destination: DEST_ID, collection: "orders" });
        expect(result.state).toBe(1);
    });
});

describe("replication seed", () => {
    it("seeds 'latest' so the backfill skips what already exists", async () => {
        // `seed()` is a `beforeBoot` tool: the stream must be down while the source
        // is prepared, otherwise every write reaches the destination anyway
        await stopReplication();
        await resetReplication(TEST_TENANT);

        const preMarker = `pre-${crypto.randomUUID()}`;
        await rest.insertOne("orders", { title: preMarker }); // carries `updatedAt`

        const res = await seedReplication(TEST_TENANT, "latest", { collection: "orders" });
        expect(res.seeded).toBe(1);

        await startReplication();
        await Bun.sleep(500); // let the cold-start backfill finish

        expect(await findDest(preMarker)).toBeNull(); // nothing copied

        const postMarker = `post-${crypto.randomUUID()}`;
        await rest.insertOne("orders", { title: postMarker });

        expect(await waitFor(async () => Boolean(await findDest(postMarker)))).toBe(true);
        expect(await findDest(preMarker)).toBeNull();
    }, 30_000);

    it("seeds from an explicit date", async () => {
        await stopReplication();

        const res = await seedReplication(TEST_TENANT, "2020-01-01T00:00:00Z", { collection: "orders" });
        expect(res.seeded).toBe(1);

        const state = await ordersState();
        expect(state.length).toBe(1);
        expect((state[0]!.cursor.value as any).toISOString()).toBe("2020-01-01T00:00:00.000Z");

        // A 2020 seed sits *before* the data, so the cold start copies everything
        await startReplication();
        expect(await waitFor(async () =>
            (await destClient.db().collection("orders").countDocuments()) > 0, 20_000)).toBe(true);
    }, 30_000);
});
