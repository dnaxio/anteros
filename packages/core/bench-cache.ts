// Scratch benchmark — `bun run bench-cache.ts` (depuis packages/core)
// Vérifie que useCache fonctionne vraiment et mesure les ms (miss vs hit vs sans cache).
import { useRest } from "./database/rest";
import { formatConfig, cfg } from "./server/config";
import { syncTenants } from "./database/tenant";
import { syncCollections } from "./database/collection";

const TENANT = "bench";
const DB = "mongodb://localhost:27017/_DB_BENCH";
const N = 10000; // docs seedés

async function main() {
    formatConfig({
        server: { port: 4000, cache: { enabled: true, driver: "memory" } },
        tenants: [{ id: TENANT, dir: "bench-tenant", database: { uri: DB } }],
    });
    await syncTenants();
    await syncCollections();

    (cfg as any).collections = [
        { _tenant_: TENANT, slug: "items", fields: [{ name: "title", type: "string" }, { name: "count", type: "number" }], api: { access: { "*": true } } },
    ];
    const rest = new useRest({ internal: false, tenant_id: TENANT });
    const col = rest.db.collection("items");

    // Seed
    console.log(`Seeding ${N} docs…`);
    const batch = [];
    for (let i = 0; i < N; i++) batch.push({ title: `item-${i % 100}`, count: i });
    for (let i = 0; i < batch.length; i += 1000) await col.insertMany(batch.slice(i, i + 1000));
    console.log("Seeded ✓");

    const params = { $match: { count: { $gte: 1000, $lte: 9000 } }, $sort: { count: -1 }, $limit: 50 };

    // 1. Sans cache — moyenne sur 100 requêtes
    const t0 = performance.now();
    const ITERS = 100;
    for (let i = 0; i < ITERS; i++) await rest.find("items", params);
    const noCacheAvg = (performance.now() - t0) / ITERS;

    // 2. Avec cache — 1er appel (MISS → requête DB) puis hits
    const tMiss = performance.now();
    const r1 = await rest.find("items", params, { useCache: true });
    const missMs = performance.now() - tMiss;
    console.log(`MISS: ${r1.length} docs retournés (requête DB réelle)`);

    const tHits = performance.now();
    for (let i = 0; i < ITERS; i++) await rest.find("items", params, { useCache: true });
    const hitAvg = (performance.now() - tHits) / ITERS;

    // 3. Preuve que le hit sert BIEN depuis le cache (pas la DB) :
    //    on mute DIRECTEMENT en DB (bypass framework) un doc présent dans le résultat.
    await col.updateMany({ count: 9000 }, { $set: { title: "MUTATED-DIRECT-DB" } });
    const cached = await rest.find("items", params, { useCache: true });
    const dbFresh = await rest.find("items", params);
    const stale = cached.some((d: any) => d.title === "MUTATED-DIRECT-DB");
    const fresh = dbFresh.some((d: any) => d.title === "MUTATED-DIRECT-DB");

    console.log("\n─── RÉSULTATS (driver memory, Mongo local) ───");
    console.log(`Sans cache  : ${noCacheAvg.toFixed(3)} ms/requête  (${ITERS} requêtes)`);
    console.log(`MISS (cache): ${missMs.toFixed(3)} ms  (1er appel → requête DB, résultat mis en cache)`);
    console.log(`HIT (cache) : ${hitAvg.toFixed(3)} ms/requête  (${ITERS} requêtes)`);
    console.log(`Gain        : ${(noCacheAvg / hitAvg).toFixed(0)}× plus rapide`);
    console.log(`Preuve cache: cache sert ${stale ? "la VALEUR MUTÉE (bug! cache pas servi)" : "l'ANCIENNE valeur (cache servi ✓)"}, requête fraîche = ${fresh ? "nouvelle valeur (DB bien mutée ✓)" : "?"}`);

    await col.drop();
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
