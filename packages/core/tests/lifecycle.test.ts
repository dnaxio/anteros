import { describe, it, expect, beforeEach } from "bun:test";
import { formatConfig } from "../server/config";
import { loadLifecycles, runBeforeBoot, runAfterBoot, runOnDestroy } from "../lib/lifecycle";
import { define } from "../lib/define";

const DIRS: Record<string, string> = {
    normal: "packages/core/tests/fixtures/lc-normal",
    thrower: "packages/core/tests/fixtures/lc-throw",
    hang: "packages/core/tests/fixtures/lc-hang",
    disabled: "packages/core/tests/fixtures/lc-disabled",
};

/** Configure cfg with a single tenant pointing at the given fixture dir. */
function useFixture(id: string) {
    formatConfig({
        server: { port: 4000 },
        tenants: [{ id, dir: DIRS[id]!, database: { uri: "mongodb://localhost:27017/_LC_TEST" } }],
    });
}

const callsOf = (key: string): string[] => ((globalThis as any)[key] ??= []);

beforeEach(() => {
    (globalThis as any).__lcNormal = [];
    (globalThis as any).__lcHang = [];
    (globalThis as any).__lcDisabled = [];
});

describe("define.Lifecycle", () => {
    it("marks the config and defaults enabled to true", () => {
        const lc = define.Lifecycle({ beforeBoot: () => {} });
        expect(lc._isLifecycle_).toBe(true);
        expect(lc.enabled).toBe(true);
    });

    it("keeps an explicit enabled: false", () => {
        const lc = define.Lifecycle({ enabled: false });
        expect(lc.enabled).toBe(false);
    });
});

describe("lifecycle hooks", () => {
    it("runs beforeBoot, afterBoot and onDestroy in order", async () => {
        useFixture("normal");
        await loadLifecycles();

        await runBeforeBoot();
        await runAfterBoot({ port: 4000 } as any, {} as any);
        await runOnDestroy("SIGTERM");

        expect(callsOf("__lcNormal")).toEqual(["beforeBoot", "afterBoot", "onDestroy:SIGTERM"]);
        // `replication` is tenant-bound in the hook context (like `rest`)
        expect((globalThis as any).__lcReplicationApi).toBe(true);
    });

    it("aborts the boot when beforeBoot throws (fail-fast)", async () => {
        useFixture("thrower");
        await loadLifecycles();

        await expect(runBeforeBoot()).rejects.toThrow(/boom/);
    });

    it("bounds onDestroy with destroyTimeout instead of hanging", async () => {
        useFixture("hang");
        await loadLifecycles();

        const started = Date.now();
        await runOnDestroy("SIGINT"); // must resolve despite a hook that never resolves
        const elapsed = Date.now() - started;

        expect(callsOf("__lcHang")).toEqual(["onDestroy:start"]);
        expect(elapsed).toBeGreaterThanOrEqual(100);
        expect(elapsed).toBeLessThan(2000);
    });

    it("skips a disabled lifecycle", async () => {
        useFixture("disabled");
        await loadLifecycles();

        await runBeforeBoot();
        await runAfterBoot({} as any, {} as any);
        await runOnDestroy("SIGINT");

        expect(callsOf("__lcDisabled")).toEqual([]);
    });

    it("tolerates a tenant without a lifecycle.ts file", async () => {
        formatConfig({
            server: { port: 4000 },
            tenants: [{ id: "nofile", dir: "packages/core/tests/fixtures/does-not-exist", database: { uri: "mongodb://localhost:27017/_LC_TEST" } }],
        });
        await loadLifecycles();
        await expect(runBeforeBoot()).resolves.toBeUndefined();
        await expect(runOnDestroy("SIGTERM")).resolves.toBeUndefined();
    });
});
