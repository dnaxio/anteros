import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { startReplication, stopReplication, replicateTenant } from "../database/replication";

const TEST_TENANT = "files-repl";
const SRC_DB = "mongodb://localhost:27017/_FILES_REPL_SRC";
const DEST_DB = "mongodb://localhost:27017/_FILES_REPL_DEST";
const SLUG = "photos";

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

const destDoc = (label: string) => destClient.db().collection(SLUG).findOne({ label });

describe("file collection replication", () => {
    it("replicates file-collection documents", async () => {
        await rest.insertOne(SLUG, { label: "a", _file: { filename: "a.png" } });
        await replicateTenant(TEST_TENANT);

        const dest = await destDoc("a");
        expect(dest).toBeDefined();
        expect((dest as any)._file.filename).toBe("a.png");
    });

    it("propagates deletions via tombstones", async () => {
        const doc: any = await rest.insertOne(SLUG, { label: "del-me" });
        await replicateTenant(TEST_TENANT);
        expect(await destDoc("del-me")).toBeDefined();

        await rest.deleteOne(SLUG, doc._id);
        await replicateTenant(TEST_TENANT);
        expect(await destDoc("del-me")).toBeNull();
    });

    it("does not replicate a file collection that did not opt in", async () => {
        (cfg as any).fileCollections.push({
            _tenant_: TEST_TENANT,
            _isFileCollection_: true,
            slug: "private-files",
            fields: [],
            api: { access: { "*": true } },
        });

        await rest.insertOne("private-files", { label: "secret" });
        await replicateTenant(TEST_TENANT);

        expect(await destClient.db().collection("private-files").findOne({ label: "secret" })).toBeNull();
    });
});
