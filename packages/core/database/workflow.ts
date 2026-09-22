import { cfg } from "../server/config";
import { getTenant } from "./tenant";
import { AppError, fn } from "../lib/error";
import * as func from "../utils/func";
import { useRest } from "./rest";
import { getWorkflow, validateWorkflowContext } from "../lib/workflow";
import { logger } from "../utils/logger";
import crypto from "crypto";
import os from "node:os";
import type { WorkflowDefinition, WorkflowRun, WorkflowRunStep, WorkflowRunStatus, WorkflowStep } from "../types/workflow";

/** Distributed lock TTL — refreshed before every step, released on the way out */
const LOCK_TTL = 15 * 60_000;
/** Default delay before a retry, doubled on each attempt */
const DEFAULT_BACKOFF = 250;
const MAX_BACKOFF = 5_000;

/** Statuses a run can no longer be moved out of */
const TERMINAL: WorkflowRunStatus[] = ['completed', 'compensated', 'cancelled'];

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class Workflow {
  #tenant_id: string;
  // The client handed to step handlers: a real `rest`, so a step can read and
  // write with the whole public API (`rest.find`, `rest.insertOne`,
  // `rest.workflow.run` for a sub-workflow, `rest.vars`, …)
  #rest: InstanceType<typeof useRest>;

  constructor(tenant_id: string) {
    this.#tenant_id = tenant_id;
    this.#rest = new useRest({ tenant_id, internal: true });
  }

  private async getCollection() {
    const tenant = getTenant(this.#tenant_id);
    const db = tenant?.database?.db;
    if (!db) throw new AppError('Database not found', { code: 'DB_NOT_FOUND', status: 500 });
    return db.collection('_workflows_');
  }

  /** Resolve a definition, refusing to replay a run started by another version */
  private definition(workflowId: string, runVersion?: number, force = false): WorkflowDefinition {
    const wf = getWorkflow(workflowId, this.#tenant_id);
    if (!wf) throw new AppError(`Workflow '${workflowId}' not found`, { code: 'WORKFLOW_NOT_FOUND', status: 404 });

    if (!force && runVersion !== undefined && wf.version !== undefined && wf.version !== runVersion) {
      throw new AppError(
        `Workflow '${workflowId}' is now in version ${wf.version}, this run started in version ${runVersion} — resume with { force: true } to continue anyway`,
        { code: 'WORKFLOW_VERSION_MISMATCH', status: 409 },
      );
    }
    return wf;
  }

  /**
   * Distributed lock: only one node may advance a given run. A node that dies
   * releases it automatically when the TTL expires.
   */
  private async acquireLock(runId: string): Promise<void> {
    try {
      await this.#rest.lock(`workflow:${runId}`, LOCK_TTL);
    } catch {
      throw new AppError(`Workflow run '${runId}' is already being processed by another node`, {
        code: 'RUN_LOCKED',
        status: 409,
      });
    }
  }

  /** Keep the lock alive while the run progresses — fails if we lost ownership */
  private async touchLock(runId: string): Promise<boolean> {
    try {
      const res = await this.#rest.db.collection('_locks_').updateOne(
        { _id: `${this.#tenant_id}:workflow:${runId}` as any, pid: process.pid },
        { $set: { expiresAt: Date.now() + LOCK_TTL } },
      );
      return (res.matchedCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  private async releaseLock(runId: string): Promise<void> {
    try {
      await this.#rest.unlock(`workflow:${runId}`);
    } catch { /* best effort */ }
  }

  /**
   * Persist the run.
   *
   * `guard: true` (used for every progress write) refuses to overwrite a run
   * that was **paused or cancelled** while a step was running — a compare-and-set
   * that makes `pause()` / `cancel()` effective on an in-flight run. Returns
   * `false` when the write was refused, so the caller stops instead of
   * resurrecting the status.
   */
  private async saveRun(run: WorkflowRun, opts: { guard?: boolean } = {}): Promise<boolean> {
    const col = await this.getCollection();
    if (!opts.guard) {
      await col.replaceOne({ _id: run._id as any }, run as any, { upsert: true });
      return true;
    }
    const res: any = await col.replaceOne(
      { _id: run._id as any, status: { $nin: ['paused', 'cancelled'] } },
      run as any,
    );
    return (res?.matchedCount ?? 0) > 0;
  }

  /** The current DB status, when the run was paused/cancelled from outside */
  private async interruption(run: WorkflowRun): Promise<WorkflowRun | null> {
    const current: any = await this.getCollection().then((col) => col.findOne({ _id: run._id as any }));
    if (!current) return run;
    if (current.status === 'paused' || current.status === 'cancelled') {
      run.status = current.status;
      run.progress = current.progress ?? run.progress;
      return run;
    }
    return null;
  }

  /**
   * Persist a **step outcome** without touching the run status: a pause or a
   * cancel requested while the step was running must survive it. The step's
   * side effects happened — recording it is what prevents a later resume from
   * replaying them.
   */
  private async recordStep(run: WorkflowRun, index: number, opts: { status?: WorkflowRunStatus } = {}): Promise<void> {
    const col = await this.getCollection();
    await col.updateOne(
      { _id: run._id as any },
      {
        $set: {
          [`steps.${index}`]: run.steps[index],
          totalExecuted: run.totalExecuted,
          totalSkipped: run.totalSkipped,
          progress: run.progress,
          currentStep: run.currentStep,
          updatedAt: new Date(),
          ...(opts.status ? { status: opts.status } : {}),
          ...(opts.status === 'failed' ? { error: run.error } : {}),
        },
      },
    );
  }

  /**
   * Take ownership of the run: mark it `running` in the database **before** the
   * step loop starts, so the pause/cancel checks don't see the previous `paused`
   * status as an interruption. A compare-and-set — a cancel that arrives first wins.
   */
  private async claimRun(runId: string): Promise<boolean> {
    const res = await this.getCollection().then((col) => col.updateOne(
      { _id: runId as any, status: { $nin: TERMINAL } },
      { $set: { status: 'running', pid: process.pid, hostname: os.hostname(), updatedAt: new Date() } },
    ));
    return (res.matchedCount ?? 0) > 0;
  }

  /** Abort a promise after `ms`, so a hanging step can never block a run forever */
  private async withTimeout<T>(promise: Promise<T>, ms: number, stepId: string, abort?: AbortController): Promise<T> {
    let timer: any;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            abort?.abort();
            reject(new AppError(`Step '${stepId}' timed out after ${ms}ms`, { code: 'WORKFLOW_STEP_TIMEOUT', status: 408 }));
          }, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run one step (or the global `exec`) with its `retries` / `backoffMs` /
   * `timeout`. Only the last error is thrown, so a transient failure never rolls
   * the saga back when a retry succeeds.
   */
  private async invoke<T>(handler: (ctx: any) => Promise<T>, ctx: Record<string, any>, stepId: string): Promise<T> {
    const attempts = 1 + Math.max(0, ctx.__retries ?? 0);
    const backoff = ctx.__backoffMs ?? DEFAULT_BACKOFF;
    const timeout = ctx.__timeout ?? null;
    let lastError: any;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const abort = timeout ? new AbortController() : undefined;
      try {
        const call = () => handler({ ...ctx, signal: abort?.signal });
        if (!timeout) return await call();
        return await this.withTimeout(call(), timeout, stepId, abort);
      } catch (err: any) {
        lastError = err;
        if (attempt < attempts) await sleep(Math.min(backoff * 2 ** (attempt - 1), MAX_BACKOFF));
      }
    }
    throw lastError;
  }

  /** Ctx of a step handler — `rest` is the tenant client, not the engine */
  private stepCtx(data: any, prevOutput: any, step: WorkflowStep): Record<string, any> {
    return {
      data,
      prevOutput,
      input: step.input,
      rest: this.#rest,
      error: fn.error,
      jwt: func.jwt,
      __retries: step.retries,
      __backoffMs: step.backoffMs,
      __timeout: step.timeout === undefined ? null : func.parseDuration(step.timeout),
    };
  }

  /** Advance the run from `startIndex`, one step at a time */
  private async executeSteps(run: WorkflowRun, wf: WorkflowDefinition, startIndex: number): Promise<WorkflowRun> {
    for (let i = startIndex; i < wf.steps.length; i++) {
      const stepDef = wf.steps[i]!;

      // Paused or cancelled while the previous step was running?
      const interrupted = await this.interruption(run);
      if (interrupted) return interrupted;

      // Another node took the run over (our process was considered gone): stop
      // without writing anything, it owns the run now
      if (!(await this.touchLock(run._id))) {
        logger.file('warn', 'workflow: lost the run lock', { tenant: this.#tenant_id, run: run._id, pid: process.pid });
        return (await this.getRun(run._id)) ?? run;
      }
      run.currentStep = i;

      const stepRun: WorkflowRunStep = {
        stepId: stepDef.id,
        name: stepDef.name,
        status: 'running',
        input: run.data,
        startedAt: new Date(),
      };
      run.steps[i] = stepRun;
      run.updatedAt = new Date();
      if (!(await this.saveRun(run, { guard: true }))) return (await this.interruption(run)) ?? run;

      try {
        const prevOutput = i > 0 ? run.steps[i - 1]?.output ?? null : null;

        if (stepDef.condition && !(await stepDef.condition({ data: run.data, prevOutput }))) {
          stepRun.status = 'skipped';
          stepRun.completedAt = new Date();
          run.steps[i] = stepRun;
          run.totalSkipped = run.steps.filter(s => s.status === 'skipped').length;
          run.progress = Math.round(((i + 1) / wf.steps.length) * 100);
          await this.recordStep(run, i);
          const stopped = await this.interruption(run);
          if (stopped) return stopped;
          continue;
        }

        const result = await this.invoke(
          (ctx) => stepDef.exec(ctx as any),
          this.stepCtx(run.data, prevOutput, stepDef),
          stepDef.id,
        );
        stepRun.status = 'completed';
        stepRun.output = result;
        stepRun.completedAt = new Date();
        run.steps[i] = stepRun;
        run.totalExecuted = run.steps.filter(s => s.status === 'completed').length;
        run.progress = Math.round(((i + 1) / wf.steps.length) * 100);
        // Recorded immediately (without the run status): a pause/cancel/crash after
        // this step must find it `completed`, never replay its side effects
        await this.recordStep(run, i);
        const stopped = await this.interruption(run);
        if (stopped) return stopped;
      } catch (err: any) {
        stepRun.status = 'failed';
        stepRun.error = { message: err.message || 'Step failed', code: err.code };
        stepRun.completedAt = new Date();
        run.steps[i] = stepRun;
        run.totalExecuted = run.steps.filter(s => s.status === 'completed').length;
        run.error = { message: err.message || 'Workflow failed', code: err.code, stepId: stepDef.id };

        const stopped = await this.interruption(run);

        // A **cancel** wins over the failure: the operator asked to stop and to
        // leave the data alone, so nothing is compensated.
        if (stopped?.status === 'cancelled') {
          await this.recordStep(run, i);
          return stopped;
        }

        // A failure is authoritative (a pause requested during the failing step is
        // superseded): the saga is rolled back.
        run.status = 'failed';
        run.updatedAt = new Date();
        await this.recordStep(run, i, { status: 'failed' });
        await this.compensate(run, wf);
        throw err;
      }
    }

    run.status = 'completed';
    run.progress = 100;
    run.completedAt = new Date();
    run.updatedAt = new Date();
    if (!(await this.saveRun(run, { guard: true }))) return (await this.interruption(run)) ?? run;
    return run;
  }

  /**
   * Roll the saga back: compensate the completed steps **before the failure**,
   * in reverse order.
   *
   * Two rules keep it safe to re-run:
   * - a compensation that already succeeded is **never replayed**;
   * - a compensation requested when the process dies is simply resumed later
   *   (`resume()` finishes the rollback instead of continuing forward), and a
   *   partially rolled back run stays `failed`.
   */
  private async compensate(run: WorkflowRun, wf: WorkflowDefinition): Promise<void> {
    const failedIndex = run.steps.findIndex(s => s.status === 'failed');
    const completed = (failedIndex < 0 ? run.steps : run.steps.slice(0, failedIndex))
      .filter(s => s.status === 'completed')
      .reverse();

    const done = new Set((run.compensations ?? []).filter(c => c.status === 'completed').map(c => c.stepId));
    run.compensations = run.compensations ?? [];

    for (const step of completed) {
      const def = wf.compensations?.find(c => c.depend?.includes(step.stepId) || c.id === step.stepId);
      if (!def?.exec || done.has(def.id)) continue;

      const record: WorkflowRunStep = {
        stepId: def.id,
        name: def.name,
        status: 'running',
        input: undefined,
        startedAt: new Date(),
      };
      try {
        await this.invoke(
          (ctx) => def.exec!(ctx as any) as Promise<any>,
          {
            data: run.data,
            stepOutput: step.output,
            stepError: run.error ?? { message: 'Workflow failed' },
            rest: this.#rest,
            error: fn.error,
            jwt: func.jwt,
            __retries: def.retries,
            __backoffMs: def.backoffMs,
            __timeout: def.timeout === undefined ? null : func.parseDuration(def.timeout),
          },
          def.id,
        );
        record.status = 'completed';
        record.completedAt = new Date();
        done.add(def.id);
      } catch (compErr: any) {
        record.status = 'failed';
        record.error = { message: compErr.message || 'Compensation failed', code: compErr.code };
        record.completedAt = new Date();
      }
      run.compensations.push(record);
      run.updatedAt = new Date();
      await this.saveRun(run, { guard: true });
    }

    // Fully rolled back? Every step that needed a compensation succeeded.
    const needed = completed
      .map(s => wf.compensations?.find(c => c.depend?.includes(s.stepId) || c.id === s.stepId))
      .filter(def => !!def?.exec);
    const allDone = needed.length > 0 && needed.every(def => done.has(def!.id));

    if (allDone) run.status = 'compensated';
    run.updatedAt = new Date();
    await this.saveRun(run, { guard: true });
  }

  /**
   * Execute a workflow: creates the run, takes the lock, runs the steps.
   * Throws when a step fails (after the rollback attempt).
   */
  async run(workflowId: string, data: any, context?: any): Promise<WorkflowRun> {
    const wf = this.definition(workflowId);

    const runId = crypto.randomUUID();
    const now = new Date();
    // Validated (and coerced) against the workflow's `context` declaration
    const safeContext = validateWorkflowContext(wf, context);

    const run: WorkflowRun = {
      _id: runId,
      workflowId,
      workflowVersion: wf.version,
      tenant_id: this.#tenant_id,
      status: 'running',
      progress: 0,
      data,
      context: safeContext,
      currentStep: 0,
      totalExecuted: 0,
      totalSkipped: 0,
      steps: wf.steps.map(s => ({
        stepId: s.id,
        name: s.name,
        status: 'pending' as WorkflowRunStatus,
        startedAt: now,
      })),
      compensations: [],
      // Which process executes this run — with Bun `reusePort` / forked workers,
      // the run document says who owns it (the lock holds the same information)
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: now,
      updatedAt: now,
    };

    await this.saveRun(run);

    await this.acquireLock(runId);
    try {
      await this.touchLock(runId);

      // Execute global exec if present (never compensated: nothing has run yet)
      if (wf.exec) {
        try {
          await this.invoke(
            (ctx) => wf.exec!(ctx as any),
            { data, prevOutput: null, input: undefined, rest: this.#rest, error: fn.error, jwt: func.jwt },
            '__global__',
          );
        } catch (err: any) {
          run.status = 'failed';
          run.error = { message: err.message || 'Workflow execution failed', code: err.code, stepId: '__global__' };
          run.updatedAt = new Date();
          await this.saveRun(run, { guard: true });
          throw err;
        }
      }

      return await this.executeSteps(run, wf, 0);
    } finally {
      await this.releaseLock(runId);
    }
  }

  /**
   * Resume a paused or failed run.
   *
   * - `completed` / `cancelled` / `compensated` → refused: those are terminal.
   * - a run that was (partially) **rolled back** → the rollback is finished, the
   *   steps are never replayed (their effects were compensated).
   * - otherwise → continues from the first non-completed step.
   *
   * A run started by another `version` of the workflow is refused unless
   * `{ force: true }` — the step list may have changed underneath.
   */
  async resume(runId: string, data?: any, opts?: { force?: boolean }): Promise<WorkflowRun> {
    const run = await this.getRun(runId);
    if (!run) throw new AppError(`Workflow run '${runId}' not found`, { code: 'RUN_NOT_FOUND', status: 404 });

    if (run.status === 'compensated') {
      throw new AppError(`Workflow run '${runId}' was compensated (rolled back) — nothing to resume`, { code: 'RUN_COMPENSATED', status: 409 });
    }
    if (TERMINAL.includes(run.status)) {
      throw new AppError(`Workflow run '${runId}' is ${run.status} — resume is not applicable`, { code: 'RUN_TERMINAL', status: 400 });
    }

    const wf = this.definition(run.workflowId, run.workflowVersion, opts?.force);

    await this.acquireLock(runId);
    try {
      run.status = 'running';
      run.data = data || run.data;
      run.updatedAt = new Date();

      if (!(await this.claimRun(runId))) {
        throw new AppError(`Workflow run '${runId}' is ${run.status} — resume is not applicable`, { code: 'RUN_TERMINAL', status: 400 });
      }

      // A rollback was started: finish it, never continue forward
      if (run.compensations?.length) {
        await this.compensate(run, wf);
        return run;
      }

      const startIndex = run.steps.findIndex(s => s.status !== 'completed');
      if (startIndex === -1) {
        run.status = 'completed';
        run.progress = 100;
        run.completedAt = new Date();
        await this.saveRun(run, { guard: true });
        return run;
      }

      return await this.executeSteps(run, wf, startIndex);
    } finally {
      await this.releaseLock(runId);
    }
  }

  /** Get a workflow run by ID */
  async getRun(runId: string): Promise<WorkflowRun | null> {
    const col = await this.getCollection();
    const doc = await col.findOne({ _id: runId as any });
    return doc as unknown as WorkflowRun | null;
  }

  /** List all runs for a workflow */
  async listRuns(workflowId: string, limit = 20): Promise<WorkflowRun[]> {
    const col = await this.getCollection();
    const docs = await col.find({ workflowId }).sort({ createdAt: -1 }).limit(limit).toArray();
    return docs as unknown as WorkflowRun[];
  }

  /** Get progress of a run (0-100) */
  async getProgress(runId: string): Promise<{ progress: number; status: WorkflowRunStatus; currentStep: number; totalSteps: number; totalExecuted: number; totalSkipped: number } | null> {
    const run = await this.getRun(runId);
    if (!run) return null;
    return {
      progress: run.progress,
      status: run.status,
      currentStep: run.currentStep,
      totalSteps: run.steps.length,
      totalExecuted: run.totalExecuted,
      totalSkipped: run.totalSkipped,
    };
  }

  /**
   * Ask a running run to pause at the next step boundary.
   * Returns `false` when the run is not running (nothing to pause).
   */
  async pause(runId: string): Promise<boolean> {
    const col = await this.getCollection();
    const res = await col.updateOne(
      { _id: runId as any, status: 'running' },
      { $set: { status: 'paused', updatedAt: new Date() } }
    );
    return (res.matchedCount ?? 0) > 0;
  }

  /**
   * Cancel a run permanently — it stops at the next step boundary and can no
   * longer be resumed. Terminal runs are left untouched (`false`).
   */
  async cancel(runId: string): Promise<boolean> {
    const col = await this.getCollection();
    const res = await col.updateOne(
      { _id: runId as any, status: { $nin: TERMINAL } },
      { $set: { status: 'cancelled', updatedAt: new Date() } }
    );
    return (res.matchedCount ?? 0) > 0;
  }

  /**
   * Resume every paused or failed run, in `_id` order and by batches — a large
   * backlog is never loaded in memory at once.
   */
  async resumeAll(data?: any, opts?: { batchSize?: number }): Promise<{ resumed: number; failed: number }> {
    const col = await this.getCollection();
    const batchSize = Math.max(1, opts?.batchSize ?? 100);

    let cursor: any = null;
    let resumed = 0;
    let failed = 0;

    while (true) {
      const filter: any = { status: { $in: ['paused', 'failed'] } };
      if (cursor) filter._id = { $gt: cursor };

      const runs = await col.find(filter).sort({ _id: 1 }).limit(batchSize).toArray() as unknown as WorkflowRun[];
      if (!runs.length) break;

      for (const run of runs) {
        try {
          await this.resume(run._id, data);
          resumed++;
        } catch {
          failed++;
        }
      }

      cursor = runs[runs.length - 1]?._id;
      if (runs.length < batchSize) break;
    }

    return { resumed, failed };
  }
}

export function createWorkflow(tenant_id: string): Workflow {
  return new Workflow(tenant_id);
}

export { Workflow }
