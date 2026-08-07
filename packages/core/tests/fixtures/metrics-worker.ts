// Fixture: minimal worker that reports a fake metrics snapshot over IPC,
// then stays alive so the master can supervise it.
const payload = {
  type: "metrics",
  pid: process.pid,
  metrics: {
    pid: process.pid,
    startedAt: Date.now(),
    uptime: 3,
    env: "test",
    connections: 0,
    pendingRequests: 0,
    pendingWebSockets: 0,
    requests: { total: 7, active: 0, errors: 1, byMethod: { GET: 5, POST: 2 }, byStatus: { "200": 6, "500": 1 } },
    memory: { rss: 1024, heapUsed: 512, heapTotal: 1024, external: 64 },
    cpu: { percent: 12.5, cores: 8, user: 100, system: 50 },
  },
};

process.send?.(payload);
setInterval(() => {}, 1000); // stay alive until killed
