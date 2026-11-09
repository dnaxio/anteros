import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { startReplication, stopReplication } from "../database/replication";

const TEST_TENANT = "replinit";
const SRC_DB = "mongodb://localhost:27017/_REPL_INIT_SRC";
const DEST_DB = "mongodb://localhost:27017/_REPL_INIT_DEST";
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

const onDest = (title: string) => destClient.db().collection("orders").findOne({ title });

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
            fields: [
                { name: "title", type: "string" },
            ],
            // Start at the latest document — skip everything that already exists.
            replication: { enabled: true, initialSync: "latest" },
        },
    ];

    rest = new useRest({ tenant_id: TEST_TENANT });
    destClient = new MongoClient(DEST_DB, { serverSelectionTimeoutMS: 3000 });
    await destClient.connect();
    await destClient.db().dropDatabase();

    // Written **before** replication starts: they exist on the source when the cold
    // start resolves `initialSync: 'latest'`, and must never be copied.
    await rest.insertOne("orders", { title: `old-1-${crypto.randomUUID()}` });
    await rest.insertOne("orders", { title: `old-2-${crypto.randomUUID()}` });

    await startReplication();
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
        const marker = `new-${crypto.randomUUID()}`;
        await rest.insertOne("orders", { title: marker });

        // The new document arrives…
        expect(await waitFor(async () => Boolean(await onDest(marker)))).toBe(true);

        // …and the two pre-existing ones never did: the backfill started at the
        // latest document and the stream only replays what came after it
        const count = await destClient.db().collection("orders").countDocuments();
        expect(count).toBe(1);
    }, 20_000);
});
