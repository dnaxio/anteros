import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { syncCollections } from "../database/collection";

const TENANT = "idx-test";
const DIR = "packages/core/tests/fixtures/index-tenant";
const DB = "mongodb://localhost:27017/_DB_IDX_TEST";

// initializeOnDatabase est fire-and-forget dans syncCollections — on attend
// que les index existent réellement en base.
async function waitForIndexes(colName: string): Promise<any[]> {
    const db = cfg.tenants?.[0]?.database?.db as any;
    const col = db.collection(colName);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        try {
            const idxs = await col.listIndexes().toArray();
            if (idxs.length) return idxs;
        } catch {}
        await Bun.sleep(50);
    }
    throw new Error(`indexes not created for ${colName}`);
}

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{ id: TENANT, dir: DIR, database: { uri: DB } }],
    });
    await syncTenants();
    await syncCollections();
});

afterAll(async () => {
    try { await (cfg.tenants?.[0]?.database?.db as any)?.collection("variants").drop(); } catch {}
});

describe("index spec construction", () => {
    it("drops null/undefined options and coerces Mongo-style 1/0 booleans", async () => {
        const idxs = await waitForIndexes("variants");

        // name : indexOptions.sparse = null → ignoré (pas de sparse:null), index créé
        const nameIdx = idxs.find((i) => i.name === "name_1");
        expect(nameIdx).toBeDefined();
        expect(nameIdx!.sparse).not.toBe(null);
        expect(nameIdx!.sparse).not.toBe(true); // false / undefined — jamais null

        // sku : unique: 1 (Mongo-style) → index unique réel
        const skuIdx = idxs.find((i) => i.name === "sku_1");
        expect(skuIdx).toBeDefined();
        expect(skuIdx!.unique).toBe(true);
    });
});
