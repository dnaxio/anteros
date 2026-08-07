import type { Server } from "bun";
import os from "node:os";

// ─── Zero-dependency runtime metrics (memory, CPU, requests) ─────────────────

export type MetricsSnapshot = {
  pid: number;
  startedAt: number;
  uptime: number;
  env: string;
  connections: number;
  pendingRequests: number;
  pendingWebSockets: number;
  requests: {
    total: number;
    active: number;
    errors: number;
    byMethod: Record<string, number>;
    byStatus: Record<string, number>;
  };
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  cpu: {
    /** % of a single core over the last sample window (0..100*cores) */
    percent: number;
    cores: number;
    user: number;
    system: number;
  };
};

let serverRef: Server<any> | null = null;

const startedAt = Date.now();
let totalRequests = 0;
let totalErrors = 0;
const byMethod = new Map<string, number>();
const byStatus = new Map<string, number>();

let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

/** Attach the running Bun server (used for connection / pending request counts). */
export function registerMetrics(server: Server<any>) {
  serverRef = server;
}

/** Count a finished request (call once the response is resolved). */
export function trackRequest(req: Request, res: Response) {
  totalRequests++;
  const method = req.method || 'UNKNOWN';
  byMethod.set(method, (byMethod.get(method) ?? 0) + 1);
  const status = String(res.status);
  byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  if (res.status >= 500) totalErrors++;
}

/** Count an error that did not produce a response. */
export function trackError() {
  totalErrors++;
}

/** Build a serializable metrics snapshot for the current process. */
export function getMetrics(): MetricsSnapshot {
  const mem = process.memoryUsage();
  const now = Date.now();
  const cpu = process.cpuUsage();

  const user = cpu.user - lastCpu.user;
  const system = cpu.system - lastCpu.system;
  const elapsedMs = Math.max(1, now - lastCpuAt);
  const cores = Math.max(1, os.availableParallelism());
  lastCpu = cpu;
  lastCpuAt = now;

  const cpuPercent = Math.min(100 * cores, ((user + system) / 1000 / elapsedMs) * 100);

  return {
    pid: process.pid,
    startedAt,
    uptime: Math.floor((now - startedAt) / 1000),
    env: process.env.NODE_ENV || Bun.env.NODE_ENV || 'dev',
    connections: serverRef?.pendingWebSockets ?? 0,
    pendingRequests: serverRef?.pendingRequests ?? 0,
    pendingWebSockets: serverRef?.pendingWebSockets ?? 0,
    requests: {
      total: totalRequests,
      active: serverRef?.pendingRequests ?? 0,
      errors: totalErrors,
      byMethod: Object.fromEntries(byMethod),
      byStatus: Object.fromEntries(byStatus),
    },
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    },
    cpu: {
      percent: Math.round(cpuPercent * 10) / 10,
      cores,
      user,
      system,
    },
  };
}
