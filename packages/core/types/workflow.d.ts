import type { useRest } from "../database/rest";

export type WorkflowStepHandler<TData = any> = (ctx: {
  data: TData;
  prevOutput: any;
  input?: any;
  /** Tenant-scoped client — `rest.find`, `rest.insertOne`, `rest.workflow`, `rest.vars`… */
  rest: InstanceType<typeof useRest>;
  error: any;
  jwt: any;
  /** Aborted when the step exceeds its `timeout` — forward it to your own IO */
  signal?: AbortSignal;
}) => Promise<any>;

export type WorkflowCompensationHandler<TData = any> = (ctx: {
  data: TData;
  /** The output of the failed step (if any) */
  stepOutput: any;
  /** The error that caused the failure */
  stepError: { message: string; code?: string };
  rest: InstanceType<typeof useRest>;
  error: any;
  jwt: any;
  signal?: AbortSignal;
}) => Promise<void>;

export type WorkflowStep<TData = any> = {
  id: string;
  name?: string;
  description?: string;
  exec: WorkflowStepHandler<TData>;
  /** Compensation handler called when this step fails (executed in reverse order) */
  compensate?: WorkflowCompensationHandler<TData>;
  /** List of step IDs this compensation depends on / targets */
  depend?: string[];
  /** Attempts after the first failure (default: 0 — no retry) */
  retries?: number;
  /** Base delay before a retry, doubled on each attempt (default: 250ms, capped at 5s) */
  backoffMs?: number;
  /** Abort the step after this duration (`'5s'`, `'2m'`, or ms) — the ctx receives an aborted `signal` */
  timeout?: string | number;
  condition?: (ctx: {
    data: TData;
    prevOutput: any;
  }) => boolean | Promise<boolean>;
  input?: any;
  output?: any;
};

export type WorkflowContextField = {
  type: 'string' | 'number' | 'date';
  index?: boolean | 1 | -1;
};

export type WorkflowContextFields = Record<string, WorkflowContextField>;

/**
 * Index created on `_workflows_` for this workflow. Dotted paths are allowed
 * (`context.companyId`, `status`, …), so compound indexes can be declared:
 *
 * ```ts
 * indexes: [{ key: { 'context.companyId': 1, status: 1 } }]
 * ```
 */
export type WorkflowIndex = {
  key: Record<string, 1 | -1>;
  /** Explicit index name — defaults to MongoDB's `field_1_field_-1` */
  name?: string;
  unique?: boolean;
  sparse?: boolean;
};

export type WorkflowDefinition<TData = any> = {
  id: string;
  name: string;
  description?: string;
  version?: number;
  /** Set to `false` to keep the definition in the codebase without registering it. Default: `true`. */
  enabled?: boolean;
  context?: WorkflowContextFields;
  /** Indexes to create on `_workflows_` (compound, unique, sparse — beyond `context.index`) */
  indexes?: WorkflowIndex[];
  exec?: WorkflowStepHandler<TData>;
  steps: WorkflowStep<TData>[];
  /** Global compensation handlers executed when any step fails (reverse order) */
  compensations?: WorkflowStep<TData>[];
  _tenant_?: string;
  _isWorkflow_?: boolean;
};

export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'compensated' | 'paused' | 'cancelled' | 'skipped';

export type WorkflowRunStep = {
  stepId: string;
  name?: string;
  status: WorkflowRunStatus;
  input?: any;
  output?: any;
  error?: { message: string; code?: string };
  startedAt: Date;
  completedAt?: Date;
};

export type WorkflowRun = {
  _id: string;
  workflowId: string;
  workflowVersion?: number;
  tenant_id: string;
  status: WorkflowRunStatus;
  progress: number;
  data: any;
  context?: any;
  currentStep: number;
  totalExecuted: number;
  totalSkipped: number;
  steps: WorkflowRunStep[];
  /** Compensation steps that were executed */
  compensations?: WorkflowRunStep[];
  /** PID of the process executing this run (`reusePort` / forked deployments) */
  pid?: number;
  /** Hostname of that process — a PID is only meaningful on its own host */
  hostname?: string;
  /** The store this run was last claimed by (distributed lock holder) */
  lockedAt?: Date;
  error?: { message: string; code?: string; stepId?: string };
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
};
