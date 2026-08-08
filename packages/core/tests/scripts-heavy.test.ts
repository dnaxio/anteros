import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient } from "mongodb";
import { cfg } from "../server/config";
import { runScripts } from "../lib/scripts";

const DB_URI = "mongodb://localhost:27017/anteros_heavy_test";
const TENANT_DIR = "packages/core/tests/fixtures/heavy";

let mongoAvailable = false;
let client: MongoClient;

beforeAll(async () => {
    // Gracefully skip when MongoDB is not reachable
    try {
        client = new MongoClient(DB_URI, { serverSelectionTimeoutMS: 1500 });
        await client.connect();
        mongoAvailable = true;
    } catch {
        mongoAvailable = false;
    }
});

afterAll(async () => {
    if (mongoAvailable && client) {
        try { await client.db().dropDatabase(); } catch {}
        await client.close();
    }
});

describe("heavy scripts (subprocess)", () => {
    it("runs a heavy:true script in a worker process and persists data", async () => {
        if (!mongoAvailable) {
            console.warn("Skipping: MongoDB unavailable");
            return;
        }

        cfg.tenants = [{ id: "heavy-test", dir: TENANT_DIR, database: { uri: DB_URI } }];

        await runScripts();

        const count = await client.db().collection("items").countDocuments();
        expect(count).toBe(20);

        const sample: any = await client.db().collection("items").findOne();
        expect(sample.name).toBeString();
        expect(sample.createdAt).toBeInstanceOf(Date);
        expect(sample.updatedAt).toBeInstanceOf(Date);
    }, 30_000);
});
