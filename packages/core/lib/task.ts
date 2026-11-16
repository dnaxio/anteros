import { Glob } from "bun";
import path from "path";
import fs from "fs/promises";
import { MongoClient } from "mongodb";
import { cfg } from "../server/config";
import { logger } from "../utils/logger";
import { useRest } from "../database/rest";
import { createApi } from "./api";
import { createAgents } from "./agents";
import { importDefinition } from "./load";
import { AppError } from "./error";
import type { Tenant } from "../types/tenant";
import type {
    TaskConfig,
    TaskDocument,
    TaskInfo,
    TaskRunContext,
    TaskRunResult,
    TaskTrigger,
    TaskUpdate,
} from "../types/task";

/**
 * Scheduled tasks — `{tenant.dir}/tasks/**\/*.task.ts`, armed with `Bun.cron`.
 *
 * The **code** carries the default schedule and the handler; the durable row in
 * `_tasks_` carries what an operator may change (schedule, timezone, enabled,
 * catch-up) and what the engine reports (`lastRunAt`, `nextRunAt`, errors). A row
 * wins over the code, and a **change stream** on the collection re-arms the job
 * as soon as the row changes — no restart.
 *
 * A run holds a Mongo lock (`lockedUntil`), so several processes may arm the same
 * join without ever executing it twice.
 */

const DEFAULT_COLLECTION = "_tasks_";
const DEFAULT_LOCK_MS = 60_000;
const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

type Entry = { tenant: Tenant; task: TaskConfig };
type Armed = { job: any; schedule: string; timezone?: string };

/** Declared tasks, keyed by `${tenant}:${id}`. */
const registry = new Map<string, Entry>();
/** `Bun.cron` handles of this process. */
const armed = new Map<string, Armed>();
/** One change stream per tenant, when the server supports them. */
const watchers = new Map<string, { stream: any | null }>();
/** Dedicated clients for the change streams — the tenant's own has a `timeoutMS`. */
const watchClients = new Map<string, MongoClient>();
/** Keys running right now in this process (a manual run must not overlap a cron). */
const running = new Set<string>();

let started = false;
let stopped = true;

const keyOf = (tenantId: string, id: string): string => `${tenantId}:${id}`;

function collectionOf(tenant: Tenant): any {
    const db = tenant.database?.db;
    if (!db) throw new AppError(`Tenant '${tenant.id}' has no database`, { status: 500, code: "TASK_NO_DATABASE" });
    return db.collection(tenant.tasks?.collection ?? DEFAULT_COLLECTION);
}

/** The next occurrence of a schedule, or `null` when the expression is invalid. */
function nextRun(schedule: string, timezone?: string | null, from: number = Date.now()): Date | null {
    try {
        return Bun.cron.parse(schedule, from, timezone ? { tz: timezone } : undefined);
    } catch {
        return null;
    }
}

/**
 * Discover `{tenant.dir}/tasks/**\/*.task.ts` for every tenant. A broken file is
 * logged and skipped — it never hides the other tasks.
 */
async function syncTasks(): Promise<void> {
    registry.clear();
    const definitions: TaskConfig[] = [];

    for (const tenant of cfg.tenants ?? []) {
        const dir = path.join(process.cwd(), tenant.dir, "tasks");
        try {
            if (!(await fs.exists(dir)) || !(await fs.stat(dir)).isDirectory()) continue;

            const glob = new Glob(path.join(dir, "**/*.task.ts"));
            for await (const file of glob.scan(".")) {
                try {
                    const module = await importDefinition(file, "Task");
                    const task: TaskConfig | undefined = module?.default;
                    if (!task?._isTask_) continue;

                    const id = String(task.id ?? "");
                    if (!ID_PATTERN.test(id)) {
                        logger.error(`tasks: '${file}' has an invalid id '${id}' — skipped`, { tenant: tenant.id });
                        continue;
                    }
                    if (typeof task.run !== "function") {
                        logger.error(`tasks: '${id}' has no run() — skipped`, { tenant: tenant.id });
                        continue;
                    }
                    if (task.enabled === false) continue;
                    if (!nextRun(task.schedule, task.timezone)) {
                        logger.error(`tasks: '${id}' has an invalid schedule '${task.schedule}' — skipped`, { tenant: tenant.id });
                        continue;
                    }

                    const key = keyOf(tenant.id, id);
                    if (registry.has(key)) {
                        logger.warn(`Duplicate task id '${id}' for tenant '${tenant.id}' — '${file}' replaces the previous definition`);
                    }
                    const definition = { ...task, enabled: task.enabled ?? true, _tenant_: tenant.id };
                    registry.set(key, { tenant, task: definition });
                    definitions.push(definition);
                } catch (err: any) {
                    logger.error(`tasks: failed to load '${file}'`, { tenant: tenant.id, error: err?.message });
                }
            }
        } catch (err: any) {
            logger.error(`tasks: cannot scan '${dir}'`, { tenant: tenant.id, error: err?.message });
        }
    }

    cfg.tasks = definitions;
}

/** Whether this tenant's scheduler is enabled (default `true`). */
function tenantEnabled(tenant: Tenant): boolean {
    return tenant.tasks?.enabled ?? true;
}

function tenantEntries(tenant: Tenant): Entry[] {
    return [...registry.values()].filter((entry) => entry.tenant.id === tenant.id);
}

function defaultsFor(task: TaskConfig, now: Date): Omit<TaskDocument, "_id"> {
    return {
        schedule: task.schedule,
        timezone: task.timezone ?? null,
        enabled: task.enabled ?? true,
        catchUp: task.catchUp ?? "none",
        lockMs: task.lockMs ?? DEFAULT_LOCK_MS,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        nextRunAt: nextRun(task.schedule, task.timezone, now.getTime()),
        lockedUntil: null,
        removedAt: null,
        createdAt: now,
    };
}

/**
 * Start the scheduler — every enabled task of every tenant is armed, its row
 * created when missing (existing rows are **never** overwritten), the change
 * stream opened. Called once, after the tenant lifecycles' `beforeBoot`.
 */
async function startTasks(): Promise<void> {
    if (started) return;
    started = true;
    stopped = false;

    for (const tenant of cfg.tenants ?? []) {
        if (!tenantEnabled(tenant)) continue;
        const entries = tenantEntries(tenant);
        if (!entries.length) continue;
        try {
            await startTenant(tenant, entries);
        } catch (err: any) {
            logger.error(`tasks: tenant '${tenant.id}' could not start`, { error: err?.message, code: err?.code });
        }
    }
}

async function startTenant(tenant: Tenant, entries: Entry[]): Promise<void> {
    const coll = collectionOf(tenant);
    const now = new Date();

    // Create the missing rows only: an operator's edits always win over the code
    try {
        await coll.bulkWrite(entries.map(({ task }) => ({
            updateOne: {
                filter: { _id: task.id },
                update: { $setOnInsert: defaultsFor(task, now) },
                upsert: true,
            },
        })), { ordered: false });
    } catch (err: any) {
        // A concurrent boot (two processes) may race on the same upserts — the
        // rows exist either way, which is what matters
        if (err?.code !== 11000) throw err;
    }

    const docs = await coll.find({ _id: { $in: entries.map((entry) => entry.task.id) } }).toArray();
    for (const doc of docs as TaskDocument[]) {
        if (doc.removedAt || doc.enabled === false) continue;
        await arm(tenant, doc);
    }

    await catchUp(tenant, docs as TaskDocument[]);
    if (tenant.tasks?.watch !== false) await watch(tenant);
}

/** Arm a `Bun.cron` for one row — replacing any handle this process already holds. */
async function arm(tenant: Tenant, doc: TaskDocument): Promise<void> {
    const id = String(doc._id);
    const entry = registry.get(keyOf(tenant.id, id));
    if (!entry) return; // a row without code: leave it for the next deploy

    const key = keyOf(tenant.id, id);
    disarm(key);

    const timezone = doc.timezone ?? undefined;
    if (!nextRun(doc.schedule, timezone)) {
        logger.error(`tasks: '${id}' has an invalid schedule '${doc.schedule}' — not armed`, { tenant: tenant.id });
        return;
    }

    let job: any;
    try {
        job = Bun.cron(doc.schedule, () => {
            fire(entry, "cron", new Date());
        }, timezone ? { tz: timezone } : undefined);
    } catch (err: any) {
        logger.error(`tasks: cannot arm '${id}' (${doc.schedule})`, { tenant: tenant.id, error: err?.message });
        return;
    }

    armed.set(key, { job, schedule: doc.schedule, timezone });
    const next = nextRun(doc.schedule, timezone);
    await collectionOf(tenant)
        .updateOne({ _id: id }, { $set: { nextRunAt: next, updatedAt: new Date() } })
        .catch(() => { /* reporting is best-effort */ });
}

function disarm(key: string): void {
    const current = armed.get(key);
    if (!current) return;
    try { current.job.stop(); } catch { /* already stopped */ }
    armed.delete(key);
}

/**
 * A row changed: re-arm, disarm, or replace the schedule. Runtime fields
 * (`lastRunAt`, `nextRunAt`, `lockedUntil`…) are ignored — only what the
 * scheduler depends on is compared.
 */
async function handleChange(tenant: Tenant, event: any): Promise<void> {
    const id = String(event?.documentKey?._id ?? "");
    const entry = registry.get(keyOf(tenant.id, id));
    if (!entry) return;

    const key = keyOf(tenant.id, id);
    if (event.operationType === "delete") {
        disarm(key);
        return;
    }

    const doc = event.fullDocument as TaskDocument | undefined;
    if (!doc) return;
    if (doc.removedAt || doc.enabled === false) {
        disarm(key);
        return;
    }

    const current = armed.get(key);
    if (
        !current
        || current.schedule !== doc.schedule
        || (current.timezone ?? undefined) !== (doc.timezone ?? undefined)
    ) {
        await arm(tenant, doc);
    }
}

/**
 * Watch `_tasks_` so an enabled/schedule change takes effect without a restart.
 *
 * The tenant's client is opened with `timeoutMS` (a request timeout): a change
 * stream is a long-lived cursor, which that option aborts. A **dedicated client**
 * — same URI and options, minus the timeouts — keeps the cursor open; a resume
 * token makes a reconnect resume where it stopped instead of starting at now.
 */
async function watch(tenant: Tenant): Promise<void> {
    const collection = tenant.tasks?.collection ?? DEFAULT_COLLECTION;
    let client: MongoClient;
    try {
        const options: any = { ...(tenant.database.options ?? {}) };
        delete options.timeoutMS;
        delete options.socketTimeoutMS;
        client = new MongoClient(tenant.database.uri, options);
        await client.connect();
    } catch (err: any) {
        logger.warn(`tasks: no change stream for '${tenant.id}' — edits apply on the next boot`, { error: err?.message });
        return;
    }

    watchClients.set(tenant.id, client);
    const coll = client.db(tenant.database.db?.databaseName).collection(collection);
    const holder: { stream: any | null } = { stream: null };
    watchers.set(tenant.id, holder);

    void (async () => {
        let token: any = null;
        while (!stopped) {
            let stream: any = null;
            try {
                stream = coll.watch([], {
                    fullDocument: "updateLookup",
                    ...(token ? { resumeAfter: token } : {}),
                } as any);
                holder.stream = stream;

                for await (const event of stream) {
                    if (stopped) break;
                    if (event?._id) token = event._id;
                    await handleChange(tenant, event);
                }
                if (stopped) break;
            } catch (err: any) {
                if (stopped) break;
                // A standalone MongoDB has no change stream at all: say it once and stop
                if (err?.code === 40573 || /replica set/i.test(err?.message ?? "")) {
                    logger.warn(`tasks: no change stream for '${tenant.id}' (a replica set is required) — edits apply on the next boot`);
                    return;
                }
                logger.warn(`tasks: change stream for '${tenant.id}' interrupted — reconnecting`, { error: err?.message ?? String(err) });
                await Bun.sleep(1_000);
            } finally {
                try { await stream?.close(); } catch { /* already closed */ }
                holder.stream = null;
            }
        }
    })();
}

/** `catchUp: 'once'` — a row whose `nextRunAt` is in the past runs at boot. */
async function catchUp(tenant: Tenant, docs: TaskDocument[]): Promise<void> {
    const now = Date.now();
    for (const doc of docs) {
        if (doc.removedAt || doc.enabled === false || doc.catchUp !== "once" || !doc.nextRunAt) continue;
        const due = new Date(doc.nextRunAt).getTime();
        if (!Number.isFinite(due) || due >= now) continue;
        const entry = registry.get(keyOf(tenant.id, String(doc._id)));
        if (entry) fire(entry, "catch-up", new Date(due));
    }
}

/**
 * Background execution — the handler's own errors are recorded by `runEntry`,
 * but a failure **before** it (the database, the lock) must not escape: a
 * rejected promise here would reach `unhandledRejection` and kill the process.
 */
function fire(entry: Entry, trigger: TaskTrigger, scheduledTime: Date): void {
    void runEntry(entry, trigger, scheduledTime).catch((err: any) => {
        logger.error(`tasks: '${entry.task.id}' could not run`, {
            tenant: entry.tenant.id,
            trigger,
            code: err?.code,
            error: err?.message ?? String(err),
        });
    });
}

/**
 * Run one task, under the cross-process lock. Errors are recorded and logged —
 * a failing task never fails the process (a `Bun.cron` rejection would).
 */
async function runEntry(entry: Entry, trigger: TaskTrigger, scheduledTime: Date): Promise<TaskRunResult> {
    const { tenant, task } = entry;
    const key = keyOf(tenant.id, task.id);
    if (running.has(key)) return { id: task.id, trigger, skipped: true };

    const coll = collectionOf(tenant);
    const now = new Date();

    // A manual run may target a tenant whose scheduler never started (tests, a
    // script): the row is created from the declaration, then treated as usual
    await coll.updateOne(
        { _id: task.id },
        { $setOnInsert: defaultsFor(task, now) },
        { upsert: true },
    ).catch(async (err: any) => {
        if (err?.code !== 11000) throw err;
    });

    const row = await coll.findOne({ _id: task.id });
    if (!row || (row as TaskDocument).removedAt) return { id: task.id, trigger, skipped: true };

    const lockMs = Number(row.lockMs ?? task.lockMs ?? DEFAULT_LOCK_MS);
    const locked = await coll.findOneAndUpdate(
        {
            _id: task.id,
            $or: [
                { lockedUntil: null },
                { lockedUntil: { $exists: false } },
                { lockedUntil: { $lt: now } },
            ],
        },
        { $set: { lockedUntil: new Date(now.getTime() + lockMs) } },
        { returnDocument: "after" },
    );
    if (!locked) return { id: task.id, trigger, skipped: true };

    running.add(key);
    const startedAt = Date.now();
    const rest = new useRest({ tenant_id: tenant.id });
    const ctx: TaskRunContext = {
        tenant,
        rest,
        api: createApi(rest),
        agents: createAgents(tenant.id, rest),
        logger,
        task: locked as TaskDocument,
        trigger,
        scheduledTime,
    };

    let ok = true;
    let error: string | undefined;
    try {
        await task.run(ctx);
    } catch (err: any) {
        ok = false;
        error = err?.message ?? String(err);
        logger.error(`tasks: '${task.id}' failed for tenant '${tenant.id}'`, {
            trigger,
            code: err?.code,
            error,
        });
    } finally {
        running.delete(key);
        const next = nextRun(locked.schedule ?? task.schedule, locked.timezone ?? task.timezone);
        const update: any = {
            $set: {
                lastRunAt: new Date(),
                lastStatus: ok ? "success" : "error",
                lastDurationMs: Date.now() - startedAt,
                nextRunAt: next ?? null,
                lockedUntil: null,
                updatedAt: new Date(),
            },
        };
        if (error) update.$set.lastError = error;
        else update.$unset = { lastError: "" };
        await coll.updateOne({ _id: task.id }, update).catch(() => { /* reporting is best-effort */ });
    }

    return {
        id: task.id,
        trigger,
        skipped: false,
        ok,
        durationMs: Date.now() - startedAt,
        ...(error ? { error } : {}),
    };
}

/** Merge a declaration with its row into what the API reports. */
function toInfo(task: TaskConfig, doc?: TaskDocument | null): TaskInfo {
    const key = keyOf(String(task._tenant_), task.id);
    return {
        id: task.id,
        description: task.description,
        schedule: doc?.schedule ?? task.schedule,
        timezone: doc?.timezone ?? task.timezone,
        enabled: doc?.enabled ?? task.enabled ?? true,
        catchUp: doc?.catchUp ?? task.catchUp ?? "none",
        ...(doc?.lastRunAt ? { lastRunAt: new Date(doc.lastRunAt) } : {}),
        ...(doc?.lastStatus ? { lastStatus: doc.lastStatus } : {}),
        ...(doc?.lastError ? { lastError: doc.lastError } : {}),
        ...(doc?.lastDurationMs !== undefined && doc.lastDurationMs !== null ? { lastDurationMs: doc.lastDurationMs } : {}),
        ...(doc?.nextRunAt ? { nextRunAt: new Date(doc.nextRunAt) } : {}),
        armed: armed.has(key),
        running: running.has(key),
        removed: Boolean(doc?.removedAt),
    };
}

async function listTasks(tenantId: string, options: { includeRemoved?: boolean } = {}): Promise<TaskInfo[]> {
    const tenant = (cfg.tenants ?? []).find((t) => t.id === tenantId);
    if (!tenant) return [];
    const entries = tenantEntries(tenant);
    if (!entries.length) return [];

    let docs: TaskDocument[] = [];
    try {
        docs = await collectionOf(tenant).find({ _id: { $in: entries.map((e) => e.task.id) } }).toArray();
    } catch { /* no row yet — the declaration is still worth reporting */ }

    const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
    return entries
        .map(({ task }) => toInfo(task, byId.get(task.id)))
        .filter((task) => options.includeRemoved || !task.removed)
        .sort((a, b) => a.id.localeCompare(b.id));
}

async function getTask(tenantId: string, id: string): Promise<TaskInfo | undefined> {
    return (await listTasks(tenantId, { includeRemoved: true })).find((task) => task.id === id);
}

/**
 * Change what an operator is allowed to change. The change stream re-arms the
 * job in every process; this one does it immediately, so the caller's next
 * `get()` is already accurate.
 */
async function updateTask(tenantId: string, id: string, patch: TaskUpdate): Promise<TaskInfo> {
    const entry = registry.get(keyOf(tenantId, id));
    if (!entry) {
        throw new AppError(`Task '${id}' is not declared for tenant '${tenantId}'`, { status: 404, code: "TASK_NOT_FOUND" });
    }

    const tenant = entry.tenant;
    const coll = collectionOf(tenant);
    const current = await coll.findOne({ _id: id });
    if (!current) await coll.updateOne({ _id: id }, { $setOnInsert: defaultsFor(entry.task, new Date()) }, { upsert: true });
    if (current?.removedAt) {
        throw new AppError(`Task '${id}' was removed — call \`tasks.restore()\` first`, {
            status: 409,
            code: "TASK_REMOVED",
        });
    }

    const schedule = patch.schedule ?? current?.schedule ?? entry.task.schedule;
    const timezone = patch.timezone !== undefined
        ? patch.timezone
        : (current?.timezone ?? entry.task.timezone ?? null);
    if (patch.schedule !== undefined || patch.timezone !== undefined) {
        if (!nextRun(schedule, timezone)) {
            throw new AppError(`Invalid schedule '${schedule}'${timezone ? ` (${timezone})` : ""}`, {
                status: 400,
                code: "TASK_SCHEDULE_INVALID",
            });
        }
    }
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
        throw new AppError("`enabled` must be a boolean", { status: 400, code: "TASK_UPDATE_INVALID" });
    }
    if (patch.catchUp !== undefined && patch.catchUp !== "none" && patch.catchUp !== "once") {
        throw new AppError("`catchUp` must be 'none' or 'once'", { status: 400, code: "TASK_UPDATE_INVALID" });
    }
    if (patch.lockMs !== undefined && !(Number.isFinite(patch.lockMs) && patch.lockMs > 0)) {
        throw new AppError("`lockMs` must be a positive number", { status: 400, code: "TASK_UPDATE_INVALID" });
    }

    const next = patch.enabled === false ? null : nextRun(schedule, timezone);
    await coll.updateOne({ _id: id }, {
        $set: {
            ...patch,
            schedule,
            timezone,
            nextRunAt: next,
            updatedAt: new Date(),
        },
    });

    const doc = await coll.findOne({ _id: id });
    if (doc) {
        if (doc.enabled === false) disarm(keyOf(tenantId, id));
        else await arm(tenant, doc as TaskDocument);
    }

    return (await getTask(tenantId, id))!;
}

/** Run a task now, whatever its schedule (still under the lock). */
async function runTask(tenantId: string, id: string): Promise<TaskRunResult> {
    const entry = registry.get(keyOf(tenantId, id));
    if (!entry) {
        throw new AppError(`Task '${id}' is not declared for tenant '${tenantId}'`, { status: 404, code: "TASK_NOT_FOUND" });
    }
    const row = await collectionOf(entry.tenant).findOne({ _id: id });
    if (row?.removedAt) {
        throw new AppError(`Task '${id}' was removed — call \`tasks.restore()\` first`, {
            status: 409,
            code: "TASK_REMOVED",
        });
    }
    return runEntry(entry, "manual", new Date());
}

/**
 * Remove a task without deleting its row — the row keeps `removedAt`, so:
 * - the change stream disarms it in every process;
 * - `list()` hides it (pass `{ includeRemoved: true }` to see it);
 * - the next boot **does not resurrect it** (`$setOnInsert` finds the row).
 *
 * Delete the file as well to stop declaring it, or the row with the marker to
 * forget the removal entirely.
 */
async function removeTask(tenantId: string, id: string): Promise<TaskInfo> {
    const entry = registry.get(keyOf(tenantId, id));
    if (!entry) {
        throw new AppError(`Task '${id}' is not declared for tenant '${tenantId}'`, { status: 404, code: "TASK_NOT_FOUND" });
    }

    const tenant = entry.tenant;
    const coll = collectionOf(tenant);
    await coll.updateOne({ _id: id }, { $setOnInsert: defaultsFor(entry.task, new Date()) }, { upsert: true });
    await coll.updateOne({ _id: id }, {
        $set: {
            removedAt: new Date(),
            enabled: false,
            nextRunAt: null,
            lockedUntil: null,
            updatedAt: new Date(),
        },
    });

    disarm(keyOf(tenantId, id));
    return (await getTask(tenantId, id))!;
}

/** Undo `tasks.remove()` — clears the marker and arms the task again. */
async function restoreTask(tenantId: string, id: string): Promise<TaskInfo> {
    const entry = registry.get(keyOf(tenantId, id));
    if (!entry) {
        throw new AppError(`Task '${id}' is not declared for tenant '${tenantId}'`, { status: 404, code: "TASK_NOT_FOUND" });
    }

    const tenant = entry.tenant;
    const coll = collectionOf(tenant);
    await coll.updateOne({ _id: id }, { $setOnInsert: defaultsFor(entry.task, new Date()) }, { upsert: true });

    const row = await coll.findOne({ _id: id });
    const schedule = row?.schedule ?? entry.task.schedule;
    const timezone = row?.timezone ?? entry.task.timezone ?? null;
    if (!nextRun(schedule, timezone)) {
        throw new AppError(`Invalid schedule '${schedule}'`, { status: 400, code: "TASK_SCHEDULE_INVALID" });
    }

    await coll.updateOne({ _id: id }, {
        $set: {
            removedAt: null,
            enabled: true,
            nextRunAt: nextRun(schedule, timezone),
            updatedAt: new Date(),
        },
    });

    const doc = await coll.findOne({ _id: id });
    if (doc) await arm(tenant, doc as TaskDocument);
    return (await getTask(tenantId, id))!;
}

/** Stop every job and close every change stream. */
async function stopTasks(): Promise<void> {
    stopped = true;
    started = false;
    for (const key of [...armed.keys()]) disarm(key);
    for (const holder of watchers.values()) {
        try { await holder.stream?.close(); } catch { /* already closed */ }
    }
    watchers.clear();
    for (const client of watchClients.values()) {
        try { await client.close(); } catch { /* already closed */ }
    }
    watchClients.clear();
    running.clear();
}

/** The public, importable registry — `tasks.list(tenantId)`, `tasks.run(…)`. */
const tasks = {
    sync: syncTasks,
    start: startTasks,
    stop: stopTasks,
    list: listTasks,
    get: getTask,
    run: runTask,
    update: updateTask,
    remove: removeTask,
    restore: restoreTask,
    ids: (tenantId: string): string[] =>
        [...registry.values()].filter((entry) => entry.tenant.id === tenantId).map((entry) => entry.task.id).sort(),
    has: (tenantId: string, id: string): boolean => registry.has(keyOf(tenantId, id)),
    stats: () => ({
        tenants: new Set([...registry.values()].map((entry) => entry.tenant.id)).size,
        tasks: registry.size,
        armed: armed.size,
        running: running.size,
        started,
    }),
};

export { syncTasks, startTasks, stopTasks, tasks };
