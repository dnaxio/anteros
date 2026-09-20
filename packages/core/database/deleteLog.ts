import type { Db } from "mongodb";

/** Collection holding the replication state (`_replication_`). */
const MARKERS = "_replication_";

/**
 * Upsert delete tombstones consumed by the replication engine.
 *
 * Some collections bypass the collection hooks when deleting (variables,
 * file-collection documents) — those paths call this directly so their
 * deletions still propagate to the destinations.
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

export { writeDeleteMarkers };
