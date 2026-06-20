import { cfg } from "../server/config";
import { getTenant } from "./tenant";
import { AppError, fn } from "../lib/error";
import * as func from "../utils/func";
import { useRest } from "./rest";
import { getWorkflow } from "../lib/workflow";
import crypto from "crypto";
import type { WorkflowDefinition, WorkflowRun, WorkflowRunStep, WorkflowRunStatus } from "../types/workflow";

class Workflow {
  #tenant_id: string;

  constructor(tenant_id: string) {
    this.#tenant_id = tenant_id;
  }

  private async getCollection() {
    const tenant = getTenant(this.#tenant_id);
    const db = tenant?.database?.db;
    if (!db) throw new AppError('Database not found', { code: 'DB_NOT_FOUND', status: 500 });
    return db.collection('_workflows_');
  }

  /**
   * Run a workflow by its ID with the given data.
   * Executes each step sequentially and tracks progress.
   */
  async run(workflowId: string, data: any, context?: any): Promise<WorkflowRun> {
    const wf = getWorkflow(workflowId, this.#tenant_id);
    if (!wf) throw new AppError(`Workflow '${workflowId}' not found`, { code: 'WORKFLOW_NOT_FOUND', status: 404 });

    const runId = crypto.randomUUID();
    const now = new Date();

    const run: WorkflowRun = {
      _id: runId,
      workflowId,
      workflowVersion: wf.version,
      tenant_id: this.#tenant_id,
      status: 'running',
      progress: 0,
      data,
      context,
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
      createdAt: now,
      updatedAt: now,
    };

    await this.saveRun(run);

    // Execute global exec if present
    try {
      if (wf.exec) {
        await wf.exec({ data, prevOutput: null, rest: this, error: fn.error, jwt: func.jwt, input: undefined });
      }
    } catch (err: any) {
      run.status = 'failed';
      run.error = { message: err.message || 'Workflow execution failed', stepId: '__global__' };
      run.updatedAt = new Date();
      await this.saveRun(run);
      throw err;
    }

    // Execute steps sequentially
    for (let i = 0; i < wf.steps.length; i++) {
      const stepDef = wf.steps[i]!;
      run.currentStep = i;
      const stepRun: WorkflowRunStep = {
        stepId: stepDef.id,
        name: stepDef.name,
        status: 'running',
        input: data,
        startedAt: new Date(),
      };

      run.steps[i] = stepRun;
      run.updatedAt = new Date();
      await this.saveRun(run);

      try {
        const prevOutput = i > 0 ? run.steps[i - 1]?.output ?? null : null;

        // Vérifier la condition du step
        if (stepDef.condition) {
          const shouldRun = await stepDef.condition({ data, prevOutput });
          if (!shouldRun) {
            stepRun.status = 'skipped';
            stepRun.completedAt = new Date();
            run.steps[i] = stepRun;
            run.totalSkipped = run.steps.filter(s => s.status === 'skipped').length;
            run.progress = Math.round(((i + 1) / wf.steps.length) * 100);
            run.updatedAt = new Date();
            await this.saveRun(run);
            continue; // saute ce step
          }
        }

        const result = await stepDef.exec({ data, prevOutput, input: stepDef.input, rest: this, error: fn.error, jwt: func.jwt });
        stepRun.status = 'completed';
        stepRun.output = result;
        stepRun.completedAt = new Date();
        run.steps[i] = stepRun;
        run.totalExecuted = run.steps.filter(s => s.status === 'completed').length;
        run.progress = Math.round(((i + 1) / wf.steps.length) * 100);
      } catch (err: any) {
        stepRun.status = 'failed';
        stepRun.error = { message: err.message || 'Step failed', code: err.code };
        stepRun.completedAt = new Date();
        run.steps[i] = stepRun;
        run.totalExecuted = run.steps.filter(s => s.status === 'completed').length;
        run.status = 'failed';
        run.error = { message: err.message || 'Workflow failed', code: err.code, stepId: stepDef.id };
        run.updatedAt = new Date();
        await this.saveRun(run);

        // Exécuter les compensations (steps réussis en ordre inverse)
        if (wf.compensations?.length) {
          const failedIndex = run.steps.findIndex(s => s.status === 'failed');
          const stepsToCompensate = run.steps.slice(0, failedIndex).filter(s => s.status === 'completed').reverse();
          run.compensations = [];
          for (const completedStep of stepsToCompensate) {
            const compDef = wf.compensations?.find(c => c.depend?.includes(completedStep.stepId) || c.id === completedStep.stepId);
            if (!compDef?.exec) continue;
            try {
              await compDef.exec({
                data: run.data,
                prevOutput: completedStep.output,
                input: undefined,
                rest: this,
                error: fn.error,
                jwt: func.jwt,
              });
              run.compensations.push({
                stepId: compDef.id,
                name: compDef.name,
                status: 'completed',
                output: null,
                startedAt: new Date(),
                completedAt: new Date(),
              });
            } catch (compErr: any) {
              run.compensations.push({
                stepId: compDef.id,
                name: compDef.name,
                status: 'failed',
                error: { message: compErr.message || 'Compensation failed' },
                startedAt: new Date(),
                completedAt: new Date(),
              });
            }
          }
          run.updatedAt = new Date();
          await this.saveRun(run);
        }

        throw err;
      }
    }

    run.status = 'completed';
    run.progress = 100;
    run.completedAt = new Date();
    run.updatedAt = new Date();
    await this.saveRun(run);
    return run;
  }

  /**
   * Resume a paused or failed workflow run from the last failed/pending step.
   */
  async resume(runId: string, data?: any): Promise<WorkflowRun> {
    const run = await this.getRun(runId);
    if (!run) throw new AppError(`Workflow run '${runId}' not found`, { code: 'RUN_NOT_FOUND', status: 404 });
    if (run.status === 'completed') throw new AppError('Workflow already completed', { code: 'RUN_COMPLETED', status: 400 });

    const wf = getWorkflow(run.workflowId, this.#tenant_id);
    if (!wf) throw new AppError(`Workflow '${run.workflowId}' not found`, { code: 'WORKFLOW_NOT_FOUND', status: 404 });

    run.status = 'running';
    run.data = data || run.data;
    run.updatedAt = new Date();

    // Find the first non-completed step
    const startIndex = run.steps.findIndex(s => s.status !== 'completed');
    if (startIndex === -1) {
      run.status = 'completed';
      run.progress = 100;
      run.completedAt = new Date();
      await this.saveRun(run);
      return run;
    }

    for (let i = startIndex; i < wf.steps.length; i++) {
      const stepDef = wf.steps[i]!;
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
      await this.saveRun(run);

      try {
        const prevOutput = i > 0 ? run.steps[i - 1]?.output ?? null : null;

        // Vérifier la condition du step
        if (stepDef.condition) {
          const shouldRun = await stepDef.condition({ data: run.data, prevOutput });
          if (!shouldRun) {
            stepRun.status = 'skipped';
            stepRun.completedAt = new Date();
            run.steps[i] = stepRun;
            run.totalSkipped = run.steps.filter(s => s.status === 'skipped').length;
            run.progress = Math.round(((i + 1) / wf.steps.length) * 100);
            run.updatedAt = new Date();
            await this.saveRun(run);
            continue; // saute ce step
          }
        }

        const result = await stepDef.exec({ data: run.data, prevOutput, input: stepDef.input, rest: this, error: fn.error, jwt: func.jwt });
        stepRun.status = 'completed';
        stepRun.output = result;
        stepRun.completedAt = new Date();
        run.steps[i] = stepRun;
        run.totalExecuted = run.steps.filter(s => s.status === 'completed').length;
        run.progress = Math.round(((i + 1) / wf.steps.length) * 100);
      } catch (err: any) {
        stepRun.status = 'failed';
        stepRun.error = { message: err.message || 'Step failed', code: err.code };
        stepRun.completedAt = new Date();
        run.steps[i] = stepRun;
        run.totalExecuted = run.steps.filter(s => s.status === 'completed').length;
        run.status = 'failed';
        run.error = { message: err.message || 'Workflow failed', code: err.code, stepId: stepDef.id };
        run.updatedAt = new Date();
        await this.saveRun(run);

        // Exécuter les compensations (steps réussis en ordre inverse)
        if (wf.compensations?.length) {
          const failedIndex = run.steps.findIndex(s => s.status === 'failed');
          const stepsToCompensate = run.steps.slice(0, failedIndex).filter(s => s.status === 'completed').reverse();
          run.compensations = [];
          for (const completedStep of stepsToCompensate) {
            const compDef = wf.compensations?.find(c => c.depend?.includes(completedStep.stepId) || c.id === completedStep.stepId);
            if (!compDef?.exec) continue;
            try {
              await compDef.exec({
                data: run.data,
                prevOutput: completedStep.output,
                input: undefined,
                rest: this,
                error: fn.error,
                jwt: func.jwt,
              });
              run.compensations.push({
                stepId: compDef.id,
                name: compDef.name,
                status: 'completed',
                output: null,
                startedAt: new Date(),
                completedAt: new Date(),
              });
            } catch (compErr: any) {
              run.compensations.push({
                stepId: compDef.id,
                name: compDef.name,
                status: 'failed',
                error: { message: compErr.message || 'Compensation failed' },
                startedAt: new Date(),
                completedAt: new Date(),
              });
            }
          }
          run.updatedAt = new Date();
          await this.saveRun(run);
        }

        throw err;
      }
    }

    run.status = 'completed';
    run.progress = 100;
    run.completedAt = new Date();
    run.updatedAt = new Date();
    await this.saveRun(run);
    return run;
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

  /** Pause a running workflow */
  async pause(runId: string): Promise<void> {
    const col = await this.getCollection();
    await col.updateOne(
      { _id: runId as any, status: 'running' },
      { $set: { status: 'paused', updatedAt: new Date() } }
    );
  }

  /** Cancel a workflow run permanently */
  async cancel(runId: string): Promise<void> {
    const col = await this.getCollection();
    await col.updateOne(
      { _id: runId as any },
      { $set: { status: 'cancelled', updatedAt: new Date() } }
    );
  }

  /** Resume all paused or failed workflows */
  async resumeAll(data?: any): Promise<{ resumed: number; failed: number }> {
    const col = await this.getCollection();
    const runs = await col.find({
      status: { $in: ['paused', 'failed'] }
    }).toArray() as unknown as WorkflowRun[];

    let resumed = 0;
    let failed = 0;

    for (const run of runs) {
      try {
        await this.resume(run._id, data);
        resumed++;
      } catch {
        failed++;
      }
    }

    return { resumed, failed };
  }

  private async saveRun(run: WorkflowRun): Promise<void> {
    const col = await this.getCollection();
    await col.replaceOne(
      { _id: run._id as any },
      run as any,
      { upsert: true }
    );
  }
}

export function createWorkflow(tenant_id: string): Workflow {
  return new Workflow(tenant_id);
}
