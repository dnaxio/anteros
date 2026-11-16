import type { useRest } from "../database/rest";
import type { createApi } from "../lib/api";
import type { createAgents } from "../lib/agents";
import type { logger } from "../utils/logger";
import type { Tenant } from "./tenant";

/** What started a run. */
export type TaskTrigger = "cron" | "manual" | "catch-up";

/**
 * What `define.Task({ run })` receives — the tenant's own `rest`, `api` and
 * `agents`, so a task is written like any other server-side code.
 */
export type TaskRunContext = {
    tenant: Tenant;
    rest: InstanceType<typeof useRest>;
    api: ReturnType<typeof createApi>;
    agents: ReturnType<typeof createAgents>;
    logger: typeof logger;
    /** The persisted row — schedule, timezone, counters. */
    task: TaskDocument;
    /** `cron` (the schedule fired), `manual` (`tasks.run`), `catch-up` (boot). */
    trigger: TaskTrigger;
    /** The time the occurrence was meant for (now, for a manual run). */
    scheduledTime: Date;
};

/**
 * A scheduled task — `{tenant.dir}/tasks/**\/*.task.ts`.
 *
 * The **code** carries the default schedule and the handler; the `_tasks_` row
 * carries what an operator may change without a deploy (`schedule`, `timezone`,
 * `enabled`). A row always wins over the code once it exists.
 */
export type TaskConfig = {
    _isTask_?: boolean;
    _tenant_?: string;
    /** Identifier — required, unique per tenant (plain identifier). */
    id: string;
    /** What it does — served by `tasks.list()`. */
    description?: string;
    /** A 5-field cron expression (`'0 10 * * MON'`) or a nickname (`'@daily'`). */
    schedule: string;
    /** IANA time zone (`'Africa/Abidjan'`) — defaults to the server's zone. */
    timezone?: string;
    /** Declared default (a `_tasks_` row overrides it). */
    enabled?: boolean;
    /**
     * A process that was down at the fire time runs the task once at boot
     * (default `'none'`). Only when the row's `nextRunAt` is in the past.
     */
    catchUp?: "none" | "once";
    /** How long one run holds the cross-process lock (default 60 000 ms). */
    lockMs?: number;
    run: (ctx: TaskRunContext) => unknown | Promise<unknown>;
};

/** One row of `_tasks_` — the durable state, editable without a deploy. */
export type TaskDocument = {
    _id: string;
    schedule: string;
    timezone?: string | null;
    enabled: boolean;
    catchUp: "none" | "once";
    lockMs: number;
    lastRunAt?: Date | null;
    lastStatus?: "success" | "error" | null;
    lastError?: string | null;
    lastDurationMs?: number | null;
    nextRunAt?: Date | null;
    lockedUntil?: Date | null;
    /** Set by `tasks.remove()` — the row stays so a boot never resurrects it. */
    removedAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
};

/** What `tasks.list()` / `tasks.get()` return — the code merged with its row. */
export type TaskInfo = {
    id: string;
    description?: string;
    schedule: string;
    timezone?: string;
    enabled: boolean;
    catchUp: "none" | "once";
    lastRunAt?: Date;
    lastStatus?: "success" | "error";
    lastError?: string;
    lastDurationMs?: number;
    nextRunAt?: Date;
    /** Whether this process holds a `Bun.cron` for it. */
    armed: boolean;
    /** Whether a run is in flight in this process. */
    running: boolean;
    /** Removed with `tasks.remove()` — hidden from `list()` unless asked. */
    removed: boolean;
};

/** What `tasks.run()` returns. */
export type TaskRunResult = {
    id: string;
    trigger: TaskTrigger;
    /** `true` when another run held the lock (or the process was already running it). */
    skipped: boolean;
    ok?: boolean;
    durationMs?: number;
    error?: string;
};

/** What `tasks.update()` accepts — the fields an operator may change. */
export type TaskUpdate = {
    schedule?: string;
    timezone?: string | null;
    enabled?: boolean;
    catchUp?: "none" | "once";
    lockMs?: number;
};
