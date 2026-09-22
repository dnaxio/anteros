import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import os from "node:os";
import { useRest } from "../database/rest";
import { formatConfig } from "../server/config";
import { syncTenants } from "../database/tenant";

const TENANT = "locks-test";
const DB = "mongodb://localhost:27017/_LOCKS_TEST";

let rest: InstanceType<typeof useRest>;

/** Write a lock document as if another process had taken it */
async function seedLock(name: string, opts: { pid?: number; hostname?: string; expiresAt: number }) {
    await rest.db.collection("_locks_").insertOne({
        _id: `${TENANT}:${name}` as any,
        tid: TENANT,
        name,
        acquiredAt: Date.now() - 1000,
        expiresAt: opts.expiresAt,
        ...(opts.pid !== undefined ? { pid: opts.pid } : {}),
        ...(opts.hostname !== undefined ? { hostname: opts.hostname } : {}),
    } as any);
}

const lockDoc = (name: string) => rest.db.collection("_locks_").findOne({ _id: `${TENANT}:${name}` as any });

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{ id: TENANT, dir: "src", database: { uri: DB } }],
    });
    await syncTenants();
    rest = new useRest({ tenant_id: TENANT, internal: true });
});

afterAll(async () => {
    try { await rest.db.collection("_locks_").drop(); } catch (_) {}
    try { await rest.db.collection("_workflows_").drop(); } catch (_) {}
    try { await rest.db.collection("_replication_").drop(); } catch (_) {}
});

describe("distributed lock", () => {
    it("records the owning pid and hostname", async () => {
        await rest.lock("l-pid");
        const doc: any = await lockDoc("l-pid");
        expect(doc.pid).toBe(process.pid);
        expect(doc.hostname).toBe(os.hostname());
        await rest.unlock("l-pid");
    });

    it("refuses a second acquisition from the same process (its own pid is not stale)", async () => {
        await rest.lock("l-self");
        await expect(rest.lock("l-self")).rejects.toThrow(/already held/);
        await rest.unlock("l-self");
    });

    it("takes over a lock whose local process is gone, without waiting for the TTL", async () => {
        // A process that has exited: its pid no longer exists
        const dead = Bun.spawn(["true"]);
        const deadPid = dead.pid;
        await dead.exited;

        await seedLock("l-dead", { pid: deadPid, hostname: os.hostname(), expiresAt: Date.now() + 60_000 });

        await rest.lock("l-dead");
        const doc: any = await lockDoc("l-dead");
        expect(doc.pid).toBe(process.pid);
        await rest.unlock("l-dead");
    });

    it("waits for a lock whose local process is still alive", async () => {
        const alive = Bun.spawn(["sleep", "5"]);
        try {
            await seedLock("l-alive", { pid: alive.pid, hostname: os.hostname(), expiresAt: Date.now() + 60_000 });

            await expect(rest.lock("l-alive")).rejects.toThrow(/already held/);

            // …and the lock is taken over as soon as that process is gone
            alive.kill();
            await alive.exited;

            await rest.lock("l-alive");
            const doc: any = await lockDoc("l-alive");
            expect(doc.pid).toBe(process.pid);
            await rest.unlock("l-alive");
        } finally {
            try { alive.kill(); } catch (_) {}
        }
    }, 20_000);

    it("takes over an expired lock", async () => {
        await seedLock("l-expired", { pid: 999_999, hostname: "another-host", expiresAt: Date.now() - 1000 });

        await rest.lock("l-expired");
        const doc: any = await lockDoc("l-expired");
        expect(doc.pid).toBe(process.pid);
        await rest.unlock("l-expired");
    });

    it("never releases a lock owned by another process", async () => {
        await seedLock("l-other", { pid: 4242, hostname: "another-host", expiresAt: Date.now() + 60_000 });

        await rest.unlock("l-other"); // not ours
        expect(await lockDoc("l-other")).not.toBeNull();

        // Ours is released
        await rest.lock("l-ours");
        await rest.unlock("l-ours");
        expect(await lockDoc("l-ours")).toBeNull();

        await rest.db.collection("_locks_").deleteOne({ name: "l-other" });
    });

    it("only takes over a remote lock when it expired (a foreign pid cannot be probed)", async () => {
        await seedLock("l-remote", { pid: 1, hostname: "some-other-host", expiresAt: Date.now() + 60_000 });

        await expect(rest.lock("l-remote")).rejects.toThrow(/already held/);
        await rest.db.collection("_locks_").deleteOne({ name: "l-remote" });
    });
});
