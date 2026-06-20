export type WorkflowStepHandler<TData = any> = (ctx: {
  data: TData;
  prevOutput: any;
  input?: any;
  rest: any;
  error: any;
  jwt: any;
}) => Promise<any>;

export type WorkflowCompensationHandler<TData = any> = (ctx: {
  data: TData;
  /** The output of the failed step (if any) */
  stepOutput: any;
  /** The error that caused the failure */
  stepError: { message: string; code?: string };
  rest: any;
  error: any;
  jwt: any;
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

export type WorkflowDefinition<TData = any> = {
  id: string;
  name: string;
  description?: string;
  version?: number;
  context?: WorkflowContextFields;
  exec?: WorkflowStepHandler<TData>;
  steps: WorkflowStep<TData>[];
  /** Global compensation handlers executed when any step fails (reverse order) */
  compensations?: WorkflowStep<TData>[];
  _tenant_?: string;
  _isWorkflow_?: boolean;
};

export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled' | 'skipped';

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
  error?: { message: string; code?: string; stepId?: string };
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
};
