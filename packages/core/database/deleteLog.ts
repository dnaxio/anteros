import type { Db } from "mongodb";
import { cfg } from "../server/config";
import type { ReplicationMetaName } from "../types/replication";

/** Collection holding the replication state (`_replication_`). */
const MARKERS = "_replication_";

/** Meta collection slug → the name `replication.exclude` knows it by. */
const META_BY_SLUG: Record<string, ReplicationMetaName> = {
    [MARKERS]: "replication",
    _audit_: "audit",
    _workflows_: "workflows",
    _locks_: "locks",
    _vars_: "vars",
};

/** Replication is armed: enabled, with at least one usable destination. */
function replicationReady(tenantId: string): boolean {
    const tenant: any = (cfg.tenants ?? []).find((candidate) => candidate.id === tenantId);
    const replication = tenant?.replication;

    if (!replication || replication.enabled === false) return false;
    return (replication.destinations ?? []).some((destination: any) =>
        destination?.enabled !== false && destination?.id && destination?.uri);
}

/** `replication.exclude` names this collection. */
function isExcluded(tenantId: string, name: string): boolean {
    const tenant: any = (cfg.tenants ?? []).find((candidate) => candidate.id === tenantId);
    return (tenant?.replication?.exclude ?? []).includes(name);
}

/**
 * Whether the framework replicates a **meta** collection (`_audit_`, `_vars_`…)
 * for this tenant.
 */
function replicatesMetaCollection(tenantId: string, name: ReplicationMetaName): boolean {
    return replicationReady(tenantId) && !isExcluded(tenantId, name);
}

/**
 * The same question, by **collection slug** — used by the stores that delete on
 * their own instead of going through the collection hooks (agent memory, and the
 * variables / file paths mirror this).
 *
 * It answers exactly what `replicatedCollectionsFor()` would: a meta collection,
 * an agent memory collection (`exclude: ['memory']` covers them all — the tenant
 * names them), or a declared collection that opted in. A collection nobody
 * replicates gets no tombstone: it would never be flushed and would only pile up
 * in `_replication_`.
 */
function replicatesCollection(tenantId: string, slug: string): boolean {
    const asMeta = META_BY_SLUG[slug];
    if (asMeta) return replicatesMetaCollection(tenantId, asMeta);
    if (!replicationReady(tenantId)) return false;

    const isAgentMemory = (cfg.agentMemories ?? [])
        .some((memory) => memory._tenant_ === tenantId && memory.collection === slug);
    if (isAgentMemory) return !isExcluded(tenantId, "memory");

    const declared = [...(cfg.collections ?? []), ...(cfg.fileCollections ?? [])]
        .some((collection: any) =>
            collection._tenant_ === tenantId
            && collection.slug === slug
            && collection.replication?.enabled);

    return declared && !isExcluded(tenantId, slug);
}

/**
 * Upsert delete tombstones consumed by the replication engine.
 *
 * Some collections bypass the collection hooks when deleting (variables,
 * agent memory, file-collection documents) — those paths call this directly so
 * their deletions still propagate to the destinations.
 */
async function writeDeleteMarkers(
    db: Db,
    tenantId: string,
    collection: string,
    docIds: string[],
): Promise<void> {
    if (!docIds.length) return;
    const now = new Date();
    const ops = docIds.map((docId) => ({
        updateOne: {
            filter: { _id: `rep.delete:${tenantId}:${collection}:${docId}` },
            update: {
                $set: { type: "delete", tenant: tenantId, collection, docId, deletedAt: now, updatedAt: now },
                $setOnInsert: { synced: [] },
            },
            upsert: true,
        },
    }));
    await db.collection(MARKERS).bulkWrite(ops as any, { ordered: false }).catch(() => { /* ignore */ });
}

export { writeDeleteMarkers, replicatesMetaCollection, replicatesCollection };
