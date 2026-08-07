import type { Subprocess } from "bun";
import type { MetricsSnapshot } from "./metrics";

// ─── Master/worker cluster over Bun.reusePort + IPC ──────────────────────────
//
// Each worker is a full server bound to the same port (SO_REUSEPORT, round-robin
// by the kernel). The master only supervises workers and aggregates their
// metrics — it never serves the main HTTP port.

export type MasterMetrics = Record<number, MetricsSnapshot>;

export type MasterHandle = {
  /** Currently running worker PIDs */
  workers: { pid: number }[];
  /** Latest metrics snapshot per worker PID (may be empty until first report) */
  metrics(): MasterMetrics;
  /** Kill + respawn a specific worker */
  restart(pid: number): void;
  /** Kill all workers */
  shutdown(): void;
};

export type AggregatedMetrics = {
  workers: number;
  uptime: { min: number; max: number };
  requests: {
    total: number;
    active: number;
    errors: number;
    perSecond: number;
    byMethod: Record<string, number>;
    byStatus: Record<string, number>;
  };
  memory: { rss: number; heapUsed: number };
  cpu: { percent: number; cores: number };
  pids: number[];
};

type WorkerEntry = {
  proc: Subprocess;
  metrics: MetricsSnapshot | null;
  restarts: number;
};

const MAX_RESTARTS = 10;

export function startMaster(options: {
  workers: number;
  argv: string[];
  env: Record<string, string>;
}): MasterHandle {
  const { workers, argv, env } = options;
  const entries = new Map<number, WorkerEntry>();
  let stopping = false;

  const spawn = (): number => {
    const proc = Bun.spawn(argv, {
      env: { ...env, BUN_WORKER: '1' },
      stdout: 'inherit',
      stderr: 'inherit',
      ipc: (message: any) => {
        if (message && typeof message === 'object' && message.type === 'metrics') {
          const entry = entries.get(message.pid as number);
          if (entry && message.metrics) {
            entry.metrics = message.metrics as MetricsSnapshot;
          }
        }
      },
    });

    entries.set(proc.pid, { proc, metrics: null, restarts: 0 });

    proc.exited.then((code) => {
      const entry = entries.get(proc.pid);
      if (!entry) return;
      entries.delete(proc.pid);

      console.log(`[cluster] Worker ${proc.pid} exited (code ${code})`.yellow);
      if (stopping) return;

      if (entry.restarts >= MAX_RESTARTS) {
        console.error(`[cluster] Worker ${proc.pid} exceeded ${MAX_RESTARTS} restarts — giving up`.red.bold);
        return;
      }

      // Auto-respawn
      const newPid = spawn();
      const fresh = entries.get(newPid);
      if (fresh) fresh.restarts = entry.restarts + 1;
      console.log(`[cluster] Respawned worker ${proc.pid} → ${newPid} (attempt ${entry.restarts + 1})`.gray);
    });

    return proc.pid;
  };

  for (let i = 0; i < workers; i++) {
    spawn();
  }

  return {
    get workers() {
      return [...entries.keys()].map((pid) => ({ pid }));
    },

    metrics() {
      const out: MasterMetrics = {};
      for (const [pid, entry] of entries) {
        if (entry.metrics) out[pid] = entry.metrics;
      }
      return out;
    },

    restart(pid: number) {
      const entry = entries.get(pid);
      if (!entry) return;
      entry.proc.kill();
      // respawn happens in the proc.exited handler
    },

    shutdown() {
      stopping = true;
      for (const [, entry] of entries) {
        entry.proc.kill();
      }
      entries.clear();
    },
  };
}

/** Merge per-worker snapshots into a single cluster-wide view. */
export function aggregateMetrics(metrics: MasterMetrics): AggregatedMetrics {
  const snapshots = Object.values(metrics);
  const empty: AggregatedMetrics = {
    workers: 0,
    uptime: { min: 0, max: 0 },
    requests: { total: 0, active: 0, errors: 0, perSecond: 0, byMethod: {}, byStatus: {} },
    memory: { rss: 0, heapUsed: 0 },
    cpu: { percent: 0, cores: 0 },
    pids: [],
  };

  if (!snapshots.length) return empty;

  const workers = snapshots.length;
  const maxUptime = Math.max(...snapshots.map((m) => m.uptime));
  const minUptime = Math.min(...snapshots.map((m) => m.uptime));
  const totalReqs = snapshots.reduce((sum, m) => sum + m.requests.total, 0);

  const byMethod: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const m of snapshots) {
    for (const [k, v] of Object.entries(m.requests.byMethod)) byMethod[k] = (byMethod[k] ?? 0) + v;
    for (const [k, v] of Object.entries(m.requests.byStatus)) byStatus[k] = (byStatus[k] ?? 0) + v;
  }

  return {
    workers,
    uptime: { min: minUptime, max: maxUptime },
    requests: {
      total: totalReqs,
      active: snapshots.reduce((sum, m) => sum + m.pendingRequests, 0),
      errors: snapshots.reduce((sum, m) => sum + m.requests.errors, 0),
      perSecond: maxUptime > 0 ? Math.round(totalReqs / maxUptime) : 0,
      byMethod,
      byStatus,
    },
    memory: {
      rss: snapshots.reduce((sum, m) => sum + m.memory.rss, 0),
      heapUsed: snapshots.reduce((sum, m) => sum + m.memory.heapUsed, 0),
    },
    cpu: {
      percent: Math.round((snapshots.reduce((sum, m) => sum + m.cpu.percent, 0) / workers) * 10) / 10,
      cores: snapshots[0]?.cpu.cores ?? 0,
    },
    pids: snapshots.map((m) => m.pid),
  };
}
