import type { Db } from "mongodb";
import { parseDuration } from "../utils/func";

export type RetentionResult = 'applied' | 'dropped' | 'unchanged' | 'skipped'

/**
 * Declarative TTL retention for a collection:
 *
 * - a duration string (`'90d'`, `'24h'`) → ensure the TTL index with that expiry
 * - `false`                             → explicitly disabled: drop the TTL index
 * - omitted                             → untouched
 *
 * MongoDB cannot change `expireAfterSeconds` in place through `createIndex`:
 * `collMod` does it instantly, dropping/recreating is the fallback. Never fatal —
 * a failure is logged and `'skipped'` is returned.
 */
async function syncTtlRetention(
    db: Db,
    opts: { collection: string; index: string; field: string; retention?: string | false; label?: string },
): Promise<RetentionResult> {
    const { collection, index, field, retention } = opts;
    const label = opts.label ?? collection;

    if (retention === undefined) return 'skipped';

    const col: any = db.collection(collection);

    try {
        const existing = (await col.listIndexes().toArray())
            .find((entry: any) => entry.name === index);

        if (retention === false) {
            if (!existing) return 'unchanged';
            await col.dropIndex(index);
            console.log(`🧹 ${label} retention disabled — ${index} dropped`);
            return 'dropped';
        }

        const parsed = parseDuration(retention);
        if (parsed === null) {
            console.error(`Invalid ${label} retention '${retention}' — expected a duration like '90d' or '24h'`);
            return 'skipped';
        }
        const expireAfterSeconds = Math.round(parsed / 1000);

        if (!existing) {
            await col.createIndex({ [field]: 1 }, { name: index, expireAfterSeconds, background: true });
            console.log(`🧹 ${label} retention enabled — entries expire after ${retention}`);
            return 'applied';
        }

        if (existing.expireAfterSeconds === expireAfterSeconds) return 'unchanged';

        try {
            await db.command({ collMod: collection, index: { name: index, expireAfterSeconds } });
        } catch {
            await col.dropIndex(index);
            await col.createIndex({ [field]: 1 }, { name: index, expireAfterSeconds, background: true });
        }
        console.log(`🧹 ${label} retention updated — entries expire after ${retention}`);
        return 'applied';
    } catch (err: any) {
        console.error(`${label} retention failed (${retention})`, err?.message);
        return 'skipped';
    }
}

export { syncTtlRetention }
