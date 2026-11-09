import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { startReplication, stopReplication } from "../database/replication";

const TEST_TENANT = "files-repl";
const SRC_DB = "mongodb://localhost:27017/_FILES_REPL_SRC";
const DEST_DB = "mongodb://localhost:27017/_FILES_REPL_DEST";
const SLUG = "photos";

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

const destDoc = (label: string) => destClient.db().collection(SLUG).findOne({ label });
const destCount = (label: string) => destClient.db().collection(SLUG).countDocuments({ label });

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{
            id: TEST_TENANT,
            dir: "src",
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

    (cfg as any).fileCollections = [{
        _tenant_: TEST_TENANT,
        _isFileCollection_: true,
        slug: SLUG,
        fields: [{ name: "label", type: "string" }],
        api: { access: { "*": true } },
        // Opt the file collection's documents into the data replication engine.
        replication: { enabled: true },
    }];

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

describe("file collection replication", () => {
    it("replicates file-collection documents", async () => {
        await rest.insertOne(SLUG, { label: "a", _file: { filename: "a.png" } });
        expect(await waitFor(async () => Boolean(await destDoc("a")))).toBe(true);

        const dest: any = await destDoc("a");
        expect(dest._file.filename).toBe("a.png");
    });

    it("propagates deletions from the oplog", async () => {
        const doc: any = await rest.insertOne(SLUG, { label: "del-me" });
        expect(await waitFor(async () => Boolean(await destDoc("del-me")))).toBe(true);

        // The delete bypasses the collection hooks, but the oplog carries it anyway
        await rest.deleteOne(SLUG, doc._id);
        expect(await waitFor(async () => (await destCount("del-me")) === 0)).toBe(true);
    });

    it("does not replicate a file collection that did not opt in", async () => {
        // The watched collection list is fixed when the watcher starts: a file
        // collection added at runtime is only seen by a (re)start
        await stopReplication();
        (cfg as any).fileCollections.push({
            _tenant_: TEST_TENANT,
            _isFileCollection_: true,
            slug: "private-files",
            fields: [],
            api: { access: { "*": true } },
        });
        await startReplication();

        await rest.insertOne("private-files", { label: "secret" });
        await Bun.sleep(500); // long enough for an unexpected copy to land

        expect(await destClient.db().collection("private-files").findOne({ label: "secret" })).toBeNull();
    });
});
