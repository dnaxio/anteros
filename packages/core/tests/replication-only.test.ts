import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";
import { parseBootFlags, resolveCapabilities, capabilitiesLabel, conflictingBootFlags, FULL_CAPABILITIES } from "../server/flags";

const FIXTURE = "packages/core/tests/fixtures/repl-only";
const MARKERS = path.join(FIXTURE, "tenant", ".markers");
const SRC = "mongodb://localhost:27017/_RO_SRC";
const DST = "mongodb://localhost:27017/_RO_DST";
const PORT = 5556;

let proc: any;
let src: MongoClient;
let dst: MongoClient;
let output = "";

/** Poll `check` until it returns true (or throw after `timeout`) */
async function waitFor(check: () => Promise<boolean>, timeout = 20_000, step = 250): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await Bun.sleep(step);
    }
    return false;
}

describe("boot capabilities", () => {
    const flags = (over: Partial<ReturnType<typeof parseBootFlags>> = {}) => ({
        replicationOnly: false, noReplication: false, apiOnly: false, noScripts: false, noSockets: false,
        ...over,
    });

    it("reads every flag (and its camelCase spelling)", () => {
        expect(parseBootFlags(["bun", "index.ts", "--replication-only"]).replicationOnly).toBe(true);
        expect(parseBootFlags(["bun", "index.ts", "--replicationOnly"]).replicationOnly).toBe(true);
        expect(parseBootFlags(["bun", "index.ts", "--no-replication"]).noReplication).toBe(true);
        expect(parseBootFlags(["bun", "index.ts", "--api-only"]).apiOnly).toBe(true);
        expect(parseBootFlags(["bun", "index.ts", "--noScripts"]).noScripts).toBe(true);
        expect(parseBootFlags(["bun", "index.ts", "--no-sockets"]).noSockets).toBe(true);

        expect(parseBootFlags(["bun", "index.ts"])).toEqual(flags());
    });

    it("resolves the named modes", () => {
        expect(resolveCapabilities(flags())).toEqual(FULL_CAPABILITIES);

        expect(resolveCapabilities(flags(), "replication-only")).toEqual({
            api: false, replication: true, scripts: false, sockets: false,
        });
        expect(resolveCapabilities(flags(), "api-only")).toEqual({
            api: true, replication: false, scripts: false, sockets: false,
        });
        expect(resolveCapabilities(flags(), "no-replication")).toEqual({
            api: true, replication: false, scripts: true, sockets: true,
        });
    });

    it("lets the flags win over the configured mode", () => {
        expect(resolveCapabilities(flags({ apiOnly: true }), "full")).toEqual({
            api: true, replication: false, scripts: false, sockets: false,
        });
        expect(resolveCapabilities(flags({ replicationOnly: true }), "no-replication")).toEqual({
            api: false, replication: true, scripts: false, sockets: false,
        });
        // the most restrictive flag wins
        expect(resolveCapabilities(flags({ replicationOnly: true, apiOnly: true })).api).toBe(false);
    });

    it("disables one capability at a time", () => {
        expect(resolveCapabilities(flags({ noScripts: true }))).toEqual({
            api: true, replication: true, scripts: false, sockets: true,
        });
        expect(resolveCapabilities(flags({ noSockets: true }))).toEqual({
            api: true, replication: true, scripts: true, sockets: false,
        });
        expect(resolveCapabilities(flags({ noReplication: true }))).toEqual({
            api: true, replication: false, scripts: true, sockets: true,
        });
    });

    it("labels the mode for the banner", () => {
        expect(capabilitiesLabel(FULL_CAPABILITIES)).toBe("full");
        expect(capabilitiesLabel({ api: false, replication: true, scripts: false, sockets: false })).toBe("replication-only");
        expect(capabilitiesLabel({ api: true, replication: false, scripts: false, sockets: false })).toBe("api-only");
        // granular flags stay in `full` — the banner lists what is off
        expect(capabilitiesLabel({ api: true, replication: true, scripts: false, sockets: true })).toBe("full");
    });

    it("reports contradictory flags", () => {
        expect(conflictingBootFlags(flags({ replicationOnly: true, noReplication: true }))).toBe(true);
        expect(conflictingBootFlags(flags({ replicationOnly: true, apiOnly: true }))).toBe(true);
        expect(conflictingBootFlags(flags({ replicationOnly: true }))).toBe(false);
        expect(conflictingBootFlags(flags({ apiOnly: true, noScripts: true }))).toBe(false);
    });
});

describe("replication-only boot", () => {
    beforeAll(async () => {
        fs.rmSync(MARKERS, { recursive: true, force: true });

        src = new MongoClient(SRC);
        dst = new MongoClient(DST);
        await src.connect();
        await dst.connect();
        await src.db().collection("orders").drop().catch(() => {});
        await dst.db().collection("orders").drop().catch(() => {});
        await dst.db().collection("_replication_").drop().catch(() => {});

        proc = Bun.spawn(["bun", `${FIXTURE}/app.ts`, "--replication-only"], {
            cwd: process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, RO_PORT: String(PORT), RO_SRC: SRC, RO_DST: DST },
        });

        // Drain the pipes (a full buffer would block the child)
        for (const stream of [proc.stdout, proc.stderr]) {
            (async () => {
                const reader = (stream as ReadableStream<Uint8Array>).getReader();
                const decoder = new TextDecoder();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    output += decoder.decode(value, { stream: true });
                }
            })().catch(() => {});
        }

        // A document written to the source must reach the destination on its own
        await src.db().collection("orders").insertOne({ ref: "RO-1", total: 42 } as any);
    });

    afterAll(async () => {
        try { proc?.kill(); } catch {}
        try { await src?.close(); } catch {}
        try { await dst?.close(); } catch {}
        fs.rmSync(MARKERS, { recursive: true, force: true });
    });

    it("replicates the tenant data", async () => {
        const replicated = await waitFor(async () =>
            (await dst.db().collection("orders").countDocuments({ ref: "RO-1" })) === 1,
        );
        expect(replicated, `no replication after 20s — app output:\n${output}`).toBe(true);

        const onTarget: any = await dst.db().collection("orders").findOne({ ref: "RO-1" });
        expect(onTarget.total).toBe(42);
    }, 30_000);

    it("exposes no HTTP API", async () => {
        // `/health` is registered by the framework — if anything were listening, it would answer
        const refused = await fetch(`http://localhost:${PORT}/health`)
            .then(() => false)
            .catch(() => true);
        expect(refused, "a server is listening on the configured port").toBe(true);
    });

    it("still runs the lifecycle hooks", async () => {
        const ran = await waitFor(async () => fs.existsSync(path.join(MARKERS, "lifecycle.txt")));
        expect(ran, `beforeBoot did not run — app output:\n${output}`).toBe(true);
    }, 30_000);

    it("does not run the tenant scripts", async () => {
        // give the (skipped) scripts path a chance to fire
        await Bun.sleep(500);
        expect(fs.existsSync(path.join(MARKERS, "script.txt"))).toBe(false);
    });

    it("keeps the process alive (replication timers are unref'd)", async () => {
        await Bun.sleep(300);
        expect(proc.exitCode, `the process exited — output:\n${output}`).toBeNull();
    });

    it("stops replication cleanly on SIGTERM (onDestroy runs)", async () => {
        proc.kill("SIGTERM");

        const exited = await waitFor(async () => proc.exitCode !== null, 10_000, 100);
        expect(exited, `the process did not exit — output:\n${output}`).toBe(true);
        expect(proc.exitCode).toBe(0);

        const destroyed = await waitFor(async () => fs.existsSync(path.join(MARKERS, "onDestroy.txt")));
        expect(destroyed, `onDestroy did not run — output:\n${output}`).toBe(true);
    }, 30_000);
});

describe("no-replication boot", () => {
    const PORT = 5557;
    const SRC = "mongodb://localhost:27017/_NOREP_SRC";
    const DST = "mongodb://localhost:27017/_NOREP_DST";

    let procNo: any;
    let srcNo: MongoClient;
    let dstNo: MongoClient;
    let outputNo = "";

    beforeAll(async () => {
        fs.rmSync(MARKERS, { recursive: true, force: true });

        srcNo = new MongoClient(SRC);
        dstNo = new MongoClient(DST);
        await srcNo.connect();
        await dstNo.connect();
        await srcNo.db().collection("orders").drop().catch(() => {});
        await dstNo.db().collection("orders").drop().catch(() => {});

        procNo = Bun.spawn(["bun", `${FIXTURE}/app.ts`, "--no-replication"], {
            cwd: process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, RO_PORT: String(PORT), RO_SRC: SRC, RO_DST: DST },
        });

        for (const stream of [procNo.stdout, procNo.stderr]) {
            (async () => {
                const reader = (stream as ReadableStream<Uint8Array>).getReader();
                const decoder = new TextDecoder();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    outputNo += decoder.decode(value, { stream: true });
                }
            })().catch(() => {});
        }

        // Wait for the server to listen before writing to the source
        await waitFor(async () => {
            try {
                await fetch(`http://localhost:${PORT}/health`);
                return true;
            } catch {
                return false;
            }
        }, 20_000);

        await srcNo.db().collection("orders").insertOne({ ref: "NOREP-1", total: 7 } as any);
    });

    afterAll(async () => {
        try { procNo?.kill(); } catch {}
        try { await srcNo?.close(); } catch {}
        try { await dstNo?.close(); } catch {}
        fs.rmSync(MARKERS, { recursive: true, force: true });
    });

    it("serves the HTTP API", async () => {
        const res = await fetch(`http://localhost:${PORT}/health`);
        expect(res.status).toBe(200);
        expect(await res.json()).toBeDefined();
    });

    it("never starts the replication engine", async () => {
        // give it more than enough time to replicate, if it were going to
        await Bun.sleep(2_000);

        expect(await dstNo.db().collection("orders").countDocuments({})).toBe(0);
        // …and no replication state was created either
        const state = await srcNo.db().listCollections({ name: "_replication_" }).toArray();
        expect(state.length).toBe(0);
    }, 15_000);

    it("still serves the Socket.IO endpoint", async () => {
        const res = await fetch(`http://localhost:${PORT}/socket.io/?EIO=4&transport=polling`);
        expect(res.status).toBe(200);
    }, 15_000);

    it("is otherwise a full server (scripts run, lifecycle hooks run)", async () => {
        const scripted = await waitFor(async () => fs.existsSync(path.join(MARKERS, "script.txt")));
        const lifecycle = await waitFor(async () => fs.existsSync(path.join(MARKERS, "lifecycle.txt")));

        expect(lifecycle, `beforeBoot did not run — output:\n${outputNo}`).toBe(true);
        expect(scripted, `scripts did not run — output:\n${outputNo}`).toBe(true);
    }, 20_000);
});

describe("api-only boot", () => {
    const PORT = 5558;
    const SRC = "mongodb://localhost:27017/_APIONLY_SRC";
    const DST = "mongodb://localhost:27017/_APIONLY_DST";

    let procApi: any;
    let srcApi: MongoClient;
    let dstApi: MongoClient;
    let outputApi = "";

    beforeAll(async () => {
        fs.rmSync(MARKERS, { recursive: true, force: true });

        srcApi = new MongoClient(SRC);
        dstApi = new MongoClient(DST);
        await srcApi.connect();
        await dstApi.connect();
        await srcApi.db().collection("orders").drop().catch(() => {});
        await dstApi.db().collection("orders").drop().catch(() => {});

        procApi = Bun.spawn(["bun", `${FIXTURE}/app.ts`, "--api-only"], {
            cwd: process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, RO_PORT: String(PORT), RO_SRC: SRC, RO_DST: DST },
        });

        for (const stream of [procApi.stdout, procApi.stderr]) {
            (async () => {
                const reader = (stream as ReadableStream<Uint8Array>).getReader();
                const decoder = new TextDecoder();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    outputApi += decoder.decode(value, { stream: true });
                }
            })().catch(() => {});
        }

        await waitFor(async () => {
            try {
                await fetch(`http://localhost:${PORT}/health`);
                return true;
            } catch {
                return false;
            }
        }, 20_000);

        await srcApi.db().collection("orders").insertOne({ ref: "APIONLY-1", total: 3 } as any);
    });

    afterAll(async () => {
        try { procApi?.kill(); } catch {}
        try { await srcApi?.close(); } catch {}
        try { await dstApi?.close(); } catch {}
        fs.rmSync(MARKERS, { recursive: true, force: true });
    });

    it("serves the HTTP API", async () => {
        const res = await fetch(`http://localhost:${PORT}/health`);
        expect(res.status).toBe(200);
    });

    it("does not serve the Socket.IO endpoint", async () => {
        const res = await fetch(`http://localhost:${PORT}/socket.io/?EIO=4&transport=polling`);
        expect(res.status, `the socket endpoint answered — output:\n${outputApi}`).not.toBe(200);
    }, 15_000);

    it("does not run the tenant scripts", async () => {
        // the scripts path would have fired ~150ms after boot — give it more
        await Bun.sleep(1_500);
        expect(fs.existsSync(path.join(MARKERS, "script.txt"))).toBe(false);
        // …while the lifecycle still runs (it is part of a normal boot)
        expect(fs.existsSync(path.join(MARKERS, "lifecycle.txt"))).toBe(true);
    }, 15_000);

    it("never starts the replication engine", async () => {
        await Bun.sleep(1_500);
        expect(await dstApi.db().collection("orders").countDocuments({})).toBe(0);
        const state = await srcApi.db().listCollections({ name: "_replication_" }).toArray();
        expect(state.length).toBe(0);
    }, 15_000);
});
