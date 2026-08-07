import { describe, it, expect } from "bun:test";
import path from "node:path";
import { getMetrics, registerMetrics, trackRequest } from "../server/metrics";
import { startMaster, aggregateMetrics, type MasterMetrics } from "../server/cluster";

// ─── metrics ────────────────────────────────────────────────────────────

describe("metrics", () => {
    it("returns a snapshot with pid, memory and cpu", () => {
        const m = getMetrics();
        expect(m.pid).toBe(process.pid);
        expect(m.uptime).toBeGreaterThanOrEqual(0);
        expect(typeof m.memory.rss).toBe("number");
        expect(typeof m.cpu.percent).toBe("number");
        expect(m.cpu.cores).toBeGreaterThanOrEqual(1);
        expect(typeof m.requests.total).toBe("number");
    });

    it("trackRequest counts requests by method and status", () => {
        const before = getMetrics().requests.total;
        trackRequest(new Request("http://localhost/", { method: "POST" }), new Response("ok", { status: 201 }));
        const after = getMetrics().requests.total;
        expect(after).toBe(before + 1);
        expect(getMetrics().requests.byMethod.POST).toBeGreaterThanOrEqual(1);
        expect(getMetrics().requests.byStatus["201"]).toBeGreaterThanOrEqual(1);
    });

    it("trackRequest counts 5xx as errors", () => {
        const before = getMetrics().requests.errors;
        trackRequest(new Request("http://localhost/x"), new Response("boom", { status: 500 }));
        expect(getMetrics().requests.errors).toBe(before + 1);
    });

    it("registerMetrics exposes pendingRequests", () => {
        const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
        registerMetrics(server as any);
        expect(typeof getMetrics().pendingRequests).toBe("number");
        server.stop(true);
    });
});

// ─── aggregateMetrics ───────────────────────────────────────────────────

function fakeSnapshot(pid: number, total: number, rss: number): MasterMetrics[number] {
    return {
        pid,
        startedAt: Date.now(),
        uptime: 10,
        env: "test",
        connections: 0,
        pendingRequests: 0,
        pendingWebSockets: 0,
        requests: { total, active: 0, errors: total > 10 ? 1 : 0, byMethod: { GET: total }, byStatus: { "200": total } },
        memory: { rss, heapUsed: rss / 2, heapTotal: rss, external: 0 },
        cpu: { percent: 10, cores: 8, user: 100, system: 50 },
    };
}

describe("aggregateMetrics", () => {
    it("returns an empty aggregate without workers", () => {
        const agg = aggregateMetrics({});
        expect(agg.workers).toBe(0);
        expect(agg.requests.total).toBe(0);
        expect(agg.pids).toEqual([]);
    });

    it("sums worker snapshots", () => {
        const agg = aggregateMetrics({ 1: fakeSnapshot(1, 5, 1000), 2: fakeSnapshot(2, 5, 1000) });
        expect(agg.workers).toBe(2);
        expect(agg.requests.total).toBe(10);
        expect(agg.memory.rss).toBe(2000);
        expect(agg.cpu.percent).toBe(10);
        expect(agg.pids).toHaveLength(2);
        expect(agg.requests.perSecond).toBe(1);
    });
});

// ─── startMaster (real subprocess + IPC) ────────────────────────────────

describe("startMaster", () => {
    it("spawns workers, collects IPC metrics and shutdown kills them", async () => {
        const workerPath = path.join(import.meta.dir, "fixtures", "metrics-worker.ts");
        const master = startMaster({
            workers: 1,
            argv: [process.execPath, workerPath],
            env: { ...(process.env as Record<string, string>) },
        });

        // Wait for the worker to start and report its metrics
        await new Promise((r) => setTimeout(r, 1500));

        expect(master.workers.length).toBe(1);

        const metrics = master.metrics();
        const pids = Object.keys(metrics);
        expect(pids.length).toBe(1);
        expect(metrics[Number(pids[0])]!.requests.total).toBe(7);

        master.shutdown();
        await new Promise((r) => setTimeout(r, 300));
        expect(master.workers.length).toBe(0);
    }, 10_000);
});
