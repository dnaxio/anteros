import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import os from "node:os";
import { MongoClient } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { syncCollections } from "../database/collection";
import { syncWorkflows } from "../lib/workflow";
import { startReplication, stopReplication } from "../database/replication";
import { syncAgents } from "../lib/agents";
import { MongoAgentMemory } from "../lib/agentMemory";
import { AGENT_THREADS } from "./fixtures/replication-meta/agents/chat.agent";
import type { ReplicationMetaName } from "../types/replication";

const DIR = "packages/core/tests/fixtures/replication-meta";

/** Everything replicated: declared collection + the six framework collections */
const ALL_T = "rm-default";
const ALL_T_DB = "mongodb://localhost:27017/_RM_DEFAULT_SRC";
const ALL_T_DEST = "mongodb://localhost:27017/_RM_DEFAULT_DEST";

/** Nothing but the declared collection */
const OFF_T = "rm-alloff";
const OFF_T_DB = "mongodb://localhost:27017/_RM_ALLOFF_SRC";
const OFF_T_DEST = "mongodb://localhost:27017/_RM_ALLOFF_DEST";

let rest: InstanceType<typeof useRest>;
let dest: MongoClient;
let destOff: MongoClient;

const target = (slug: string) => dest.db().collection(slug);
const targetOff = (slug: string) => destOff.db().collection(slug);

/** Poll `check` until it holds — a change stream is asynchronous by nature. */
async function waitFor(check: () => Promise<boolean>, timeout = 10_000, step = 50): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await Bun.sleep(step);
    }
    return false;
}

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [
            {
                id: ALL_T,
                dir: DIR,
                database: { uri: ALL_T_DB },
                // Opt-in retention, so the destination's copy is pruned the same way
                audit: { retention: "30d" },
                replication: {
                    runOnBoot: false,
                    destinations: [{ id: "backup", uri: ALL_T_DEST }],
                },
            },
            {
                id: OFF_T,
                dir: DIR,
                database: { uri: OFF_T_DB },
                replication: {
                    runOnBoot: false,
                    exclude: ["audit", "workflows", "locks", "replication", "vars", "memory"],
                    destinations: [{ id: "backup", uri: OFF_T_DEST }],
                },
            },
        ],
    });

    await syncTenants();
    await syncCollections();
    await syncWorkflows();
    await syncAgents(); // publishes the agent memory collections (`cfg.agentMemories`)
    await startReplication();

    rest = new useRest({ tenant_id: ALL_T });
    dest = new MongoClient(ALL_T_DEST, { serverSelectionTimeoutMS: 3000 });
    destOff = new MongoClient(OFF_T_DEST, { serverSelectionTimeoutMS: 3000 });
    await dest.connect();
    await destOff.connect();
});

afterAll(async () => {
    await stopReplication();
    for (const uri of [ALL_T_DB, ALL_T_DEST, OFF_T_DB, OFF_T_DEST]) {
        try {
            const client = new MongoClient(uri);
            await client.connect();
            await client.db().dropDatabase();
            await client.close();
        } catch (_) {}
    }
    cfg.agents = [];
    cfg.agentMemories = [];
    try { await dest.close(); } catch (_) {}
    try { await destOff.close(); } catch (_) {}
});

describe("replication — framework collections", () => {
    it("replicates them by default (audit, workflows, locks, replication, vars, memory)", async () => {
        const marker = `meta-${crypto.randomUUID()}`;

        await rest.audit.addActivities([{
            internal: true,
            trace: { id: crypto.randomUUID() },
            meta: {},
            operation: {
                tenant: ALL_T, action: marker, collection: "orders",
                status: "success", input: null, result: null, error: null, duration: 0, transaction: false,
            },
            ts: new Date(),
        } as any]);
        await rest.workflow.run("run", { marker });
        await rest.vars.set("config", marker, "META-1");
        await rest.lock(`meta-${marker}`);
        await rest.insertOne("orders", { title: marker });
        // An agent conversation — the collection this tenant named for its memory
        await new MongoAgentMemory({ collection: AGENT_THREADS }).save(
            "chat-1",
            [{ role: "user", content: marker }] as any,
            { rest, tenant: ALL_T, resourceId: "u1" },
        );

        // Every write is carried by its own stream: no run to trigger
        expect(await waitFor(async () => Boolean(await target("_audit_").findOne({ "operation.action": marker })))).toBe(true);
        expect(await waitFor(async () => Boolean(await target("_workflows_").findOne({ workflowId: "run" })))).toBe(true);
        expect(await waitFor(async () => Boolean(await target("_vars_").findOne({ ns: "config", key: marker })))).toBe(true);
        expect(await waitFor(async () => Boolean(await target("_locks_").findOne({ name: `meta-${marker}` })))).toBe(true);
        expect(await waitFor(async () => Boolean(await target("_replication_").findOne({ type: "state", tenant: ALL_T })))).toBe(true);
        expect(await waitFor(async () => Boolean(await target(AGENT_THREADS).findOne({ _id: "u1:chat-1" as any })))).toBe(true);
        expect(await waitFor(async () => Boolean(await target("orders").findOne({ title: marker })))).toBe(true);

        await rest.unlock(`meta-${marker}`);
    }, 60_000);

    it("propagates a cleared thread to the destination", async () => {
        // A deletion needs no tombstone any more: the oplog carries it, so the
        // store's plain `deleteOne` is enough
        await new MongoAgentMemory({ collection: AGENT_THREADS }).clear("chat-1", { rest, tenant: ALL_T, resourceId: "u1" });

        expect(await waitFor(async () => (await target(AGENT_THREADS).countDocuments({ _id: "u1:chat-1" as any })) === 0)).toBe(true);
        expect(await rest.db.collection("_replication_").countDocuments({ type: "delete", collection: AGENT_THREADS })).toBe(0);
    }, 30_000);

    it("uses each collection's own date key (audit is read on `ts` on backfill)", async () => {
        const state: any = await rest.db.collection("_replication_")
            .findOne({ type: "state", tenant: ALL_T, collection: "_audit_" });
        expect(state).toBeDefined();
        expect(state.key).toBe("ts");
        // The state says which process is doing the work (`reusePort` / forked workers)
        expect(state.pid).toBe(process.pid);
        expect(state.hostname).toBe(os.hostname());
    });

    it("mirrors the audit retention on the destination", async () => {
        const hasTtl = () => target("_audit_").listIndexes().toArray()
            .then((indexes: any[]) => indexes.some((index) => index.name === "_audit_ttl_"))
            .catch(() => false);
        expect(await waitFor(hasTtl, 20_000)).toBe(true);

        const ttl: any = (await target("_audit_").listIndexes().toArray())
            .find((index: any) => index.name === "_audit_ttl_");
        expect(ttl.expireAfterSeconds).toBe(30 * 86400);
    }, 30_000);

    it("leaves out only what `exclude` names", async () => {
        const tenant: any = cfg.tenants?.find((t) => t.id === ALL_T);
        tenant.replication.exclude = ["audit", "memory"];

        // The watched collection list is fixed when the watcher starts: re-arm it
        await stopReplication();
        await startReplication();

        const marker = `noaudit-${crypto.randomUUID()}`;
        await rest.audit.addActivities([{
            internal: true, trace: { id: crypto.randomUUID() }, meta: {},
            operation: {
                tenant: ALL_T, action: marker, collection: "orders",
                status: "success", input: null, result: null, error: null, duration: 0, transaction: false,
            },
            ts: new Date(),
        } as any]);
        await rest.vars.set("config", marker, "still-replicated");
        await new MongoAgentMemory({ collection: AGENT_THREADS }).save(
            "chat-2",
            [{ role: "user", content: marker }] as any,
            { rest, tenant: ALL_T, resourceId: "u1" },
        );

        expect(await waitFor(async () => Boolean(await target("_vars_").findOne({ ns: "config", key: marker })))).toBe(true);
        await Bun.sleep(500); // the same time for the excluded ones to (not) arrive

        expect(await target("_audit_").findOne({ "operation.action": marker })).toBeNull();   // excluded
        expect(await target(AGENT_THREADS).findOne({ _id: "u1:chat-2" as any })).toBeNull();  // excluded

        delete tenant.replication.exclude;
        await stopReplication();
        await startReplication();
    }, 60_000);

    it("replicates nothing from the framework when every name is excluded", async () => {
        const offRest = new useRest({ tenant_id: OFF_T });
        const marker = `alloff-${crypto.randomUUID()}`;

        await offRest.audit.addActivities([{
            internal: true, trace: { id: crypto.randomUUID() }, meta: {},
            operation: {
                tenant: OFF_T, action: marker, collection: "orders",
                status: "success", input: null, result: null, error: null, duration: 0, transaction: false,
            },
            ts: new Date(),
        } as any]);
        await offRest.vars.set("config", marker, "not-replicated");
        await offRest.insertOne("orders", { title: marker });
        await new MongoAgentMemory({ collection: AGENT_THREADS }).save(
            "chat-3",
            [{ role: "user", content: marker }] as any,
            { rest: offRest, tenant: OFF_T, resourceId: "u1" },
        );

        // The declared collection still replicates…
        expect(await waitFor(async () => Boolean(await targetOff("orders").findOne({ title: marker })))).toBe(true);
        await Bun.sleep(500);

        // …but the framework collections do not exist on that destination
        expect(await targetOff("_audit_").countDocuments({})).toBe(0);
        expect(await targetOff("_vars_").countDocuments({})).toBe(0);
        expect(await targetOff("_workflows_").countDocuments({})).toBe(0);
        expect(await targetOff(AGENT_THREADS).countDocuments({})).toBe(0);
    }, 60_000);

    it("keeps the `exclude` list typed", () => {
        const names: ReplicationMetaName[] = ["audit", "workflows", "locks", "replication", "vars", "memory"];
        expect(names.length).toBe(6);

        // @ts-expect-error — a declared collection slug is not a framework collection
        const wrong: ReplicationMetaName[] = ["orders"];
        expect(wrong.length).toBe(1);
    });
});
