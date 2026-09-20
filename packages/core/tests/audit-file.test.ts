import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { syncTenants, getTenant } from "../database/tenant";
import { resolveAuditFile, writeAuditFile, flushAuditFile, pruneAuditFiles } from "../lib/audit";
import type { AuditFileOptions } from "../lib/audit";

const DIR = path.join(import.meta.dir, ".tmp-audit-file");
const TODAY = new Date().toISOString().slice(0, 10);

/** Minimal activity document (same shape as `ActivityInput`). */
function activity(action: string, collection = "items") {
    return {
        internal: true,
        trace: { id: crypto.randomUUID() },
        meta: {},
        operation: {
            tenant: "test",
            action,
            collection,
            status: "success",
            input: null,
            result: null,
            error: null,
            duration: 0,
            transaction: false,
        },
        ts: new Date(),
    } as any;
}

function readLines(file: string): any[] {
    return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function filesOf(dir: string, tenantId: string): string[] {
    try {
        return fs.readdirSync(dir).filter((f) => f.startsWith(`audit-${tenantId}-`)).sort();
    } catch {
        return [];
    }
}

beforeAll(() => {
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
});

afterAll(() => {
    // `cfg.server` is shared by every test file in the same process: never leak
    // the audit sink into the other suites (they would write files too)
    delete (cfg.server as any).audit;
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {};
});

// ─── Disabled by default ────────────────────────────────────────────────

describe("audit file — disabled by default", () => {
    const TENANT = "af-off";
    let rest: InstanceType<typeof useRest>;

    beforeAll(async () => {
        formatConfig({
            server: { port: 4000 },
            tenants: [{ id: TENANT, dir: "src", database: { uri: "mongodb://localhost:27017/_AUDIT_FILE_OFF" } }],
        });
        await syncTenants();
        rest = new useRest({ internal: true, tenant_id: TENANT });
    });

    it("writes nothing when no config is set anywhere", async () => {
        await rest.audit.addActivities([activity("off")]);
        await flushAuditFile();

        expect(filesOf(DIR, TENANT)).toEqual([]);
        expect(fs.existsSync(path.join(DIR, TENANT))).toBe(false);
    });

    it("resolves to null", () => {
        expect(resolveAuditFile({ id: TENANT, dir: "src", database: { uri: "" } } as any)).toBeNull();
    });
});

// ─── Configured (tenant level and server default) ───────────────────────

describe("audit file — writes and rotation", () => {
    const TENANT = "af-tenant";
    const ROT = "af-rot";
    const OPTOUT = "af-optout";
    const DIR_TENANT = path.join(DIR, "tenant");
    const DIR_ROT = path.join(DIR, "rot");
    const DIR_SERVER = path.join(DIR, "server");

    let rest: InstanceType<typeof useRest>;
    let rot: InstanceType<typeof useRest>;
    let optout: InstanceType<typeof useRest>;

    beforeAll(async () => {
        formatConfig({
            server: {
                port: 4000,
                // Server-wide default: everything goes to <DIR>/server unless a tenant says otherwise
                audit: { file: { dir: DIR_SERVER } },
            },
            tenants: [
                {
                    id: TENANT,
                    dir: "src",
                    database: { uri: "mongodb://localhost:27017/_AUDIT_FILE_TENANT" },
                    // Tenant wins: own dir + 7d retention (default size cap)
                    audit: { file: { dir: DIR_TENANT, retention: "7d" } },
                },
                {
                    id: ROT,
                    dir: "src",
                    database: { uri: "mongodb://localhost:27017/_AUDIT_FILE_ROT" },
                    // Cap is set by the rotation test itself, once the real line size is known
                    audit: { file: { dir: DIR_ROT } },
                },
                {
                    id: OPTOUT,
                    dir: "src",
                    database: { uri: "mongodb://localhost:27017/_AUDIT_FILE_OPTOUT" },
                    audit: { file: false }, // opt out of the server default
                },
            ],
        });
        await syncTenants();
        rest = new useRest({ internal: true, tenant_id: TENANT });
        rot = new useRest({ internal: true, tenant_id: ROT });
        optout = new useRest({ internal: true, tenant_id: OPTOUT });
    });

    it("appends one JSONL line per activity, in a dated file", async () => {
        await rest.audit.addActivities([activity("first"), activity("second")]);
        await flushAuditFile();

        const files = filesOf(DIR_TENANT, TENANT);
        expect(files).toEqual([`audit-${TENANT}-${TODAY}.jsonl`]);

        const lines = readLines(path.join(DIR_TENANT, files[0]!));
        expect(lines.length).toBe(2);
        expect(lines.map((l) => l.operation.action)).toEqual(["first", "second"]);
        expect(typeof lines[0]!.ts).toBe("string"); // Date serialized as ISO
    });

    it("appends (never truncates) on the next call", async () => {
        await rest.audit.addActivities([activity("third")]);
        await flushAuditFile();

        const lines = readLines(path.join(DIR_TENANT, `audit-${TENANT}-${TODAY}.jsonl`));
        expect(lines.map((l) => l.operation.action)).toEqual(["first", "second", "third"]);
    });

    it("rotates when the size cap is reached", async () => {
        // First activity reserves the plain file of the day
        await rot.audit.addActivities([activity("rot-0")]);
        await flushAuditFile();

        const plain = path.join(DIR_ROT, `audit-${ROT}-${TODAY}.jsonl`);
        const lineBytes = fs.statSync(plain).size;
        // Cap sized so exactly two lines fit per file (line size is known now)
        const cap = lineBytes * 2 + 5;
        ((getTenant(ROT)!.audit!.file) as AuditFileOptions).maxSize = cap;

        for (let i = 1; i < 4; i++) {
            await rot.audit.addActivities([activity(`rot-${i}`)]);
            await flushAuditFile();
        }

        // Chronological split: the plain file holds the two first lines,
        // the `-1` rotation the next two
        const files = filesOf(DIR_ROT, ROT);
        const rotated = `audit-${ROT}-${TODAY}-1.jsonl`;
        const name = `audit-${ROT}-${TODAY}.jsonl`;

        expect(files.length).toBe(2);
        expect(files).toContain(name);
        expect(files).toContain(rotated);

        const actions = (file: string) =>
            readLines(path.join(DIR_ROT, file)).map((l) => l.operation.action);
        expect(actions(name)).toEqual(["rot-0", "rot-1"]);
        expect(actions(rotated)).toEqual(["rot-2", "rot-3"]);

        // every file holds valid JSONL, stays under the cap, and no line is lost
        for (const file of files) {
            const raw = fs.readFileSync(path.join(DIR_ROT, file), "utf-8");
            expect(raw.endsWith("\n")).toBe(true);
            expect(raw.length).toBeLessThanOrEqual(cap);
        }
        expect([...actions(name), ...actions(rotated)])
            .toEqual(["rot-0", "rot-1", "rot-2", "rot-3"]);
    });

    it("carries the `_id` assigned by MongoDB", async () => {
        const files = filesOf(DIR_TENANT, TENANT);
        const line = readLines(path.join(DIR_TENANT, files[0]!))[0]!;
        expect(line._id).toBeString();
        expect(line._id.length).toBe(24);
    });

    it("uses the server default when the tenant declares nothing", async () => {
        const inherited = "af-inherit";
        // Same server config, another tenant — resolved from `server.audit.file`
        await rest.audit.addActivities([activity("own")]);
        writeAuditFile({ id: inherited, dir: "src", database: { uri: "" } } as any, [activity("srv")]);
        await flushAuditFile();

        const files = filesOf(DIR_SERVER, inherited);
        expect(files.length).toBe(1);
        expect(readLines(path.join(DIR_SERVER, files[0]!))[0].operation.action).toBe("srv");
    });

    it("lets a tenant opt out of the server default with `false`", async () => {
        await optout.audit.addActivities([activity("blocked")]);
        await flushAuditFile();

        expect(filesOf(DIR_SERVER, OPTOUT)).toEqual([]);
        expect(filesOf(DIR_TENANT, OPTOUT)).toEqual([]);
    });

    it("prunes files older than the retention", async () => {
        const stale = path.join(DIR_TENANT, `audit-${TENANT}-2020-01-01.jsonl`);
        fs.writeFileSync(stale, "{}\n");
        const old = new Date(Date.now() - 60 * 86400_000);
        fs.utimesSync(stale, old, old);

        const fresh = path.join(DIR_TENANT, `audit-${TENANT}-${TODAY}.jsonl`);
        const before = filesOf(DIR_TENANT, TENANT);

        const removed = await pruneAuditFiles(DIR_TENANT, TENANT, 7 * 86400_000);

        expect(removed).toContain(`audit-${TENANT}-2020-01-01.jsonl`);
        expect(fs.existsSync(stale)).toBe(false);
        expect(fs.existsSync(fresh)).toBe(true);
        expect(filesOf(DIR_TENANT, TENANT).length).toBe(before.length - 1);
    });

    it("only touches its own tenant's files", async () => {
        const stale = path.join(DIR_TENANT, `audit-${OPTOUT}-2020-01-01.jsonl`);
        fs.writeFileSync(stale, "{}\n");
        const old = new Date(Date.now() - 60 * 86400_000);
        fs.utimesSync(stale, old, old);

        await pruneAuditFiles(DIR_TENANT, TENANT, 7 * 86400_000);

        expect(fs.existsSync(stale)).toBe(true);
        fs.rmSync(stale, { force: true });
    });

    it("mirrors the database retention when no file retention is set", () => {
        const inherited = resolveAuditFile({
            id: "x", dir: "src", database: { uri: "" }, audit: { retention: "30d", file: true },
        } as any);
        expect(inherited!.retentionMs).toBe(30 * 86400_000);
        expect(inherited!.dir).toBe(path.join(".logs", "audit"));
    });
});

// ─── Automatic pruning on first write ───────────────────────────────────

describe("audit file — automatic pruning", () => {
    const TENANT = "af-prune";
    const DIR_PRUNE = path.join(DIR, "prune");
    let rest: InstanceType<typeof useRest>;

    beforeAll(async () => {
        formatConfig({
            server: { port: 4000 },
            tenants: [{
                id: TENANT,
                dir: "src",
                database: { uri: "mongodb://localhost:27017/_AUDIT_FILE_PRUNE" },
                audit: { file: { dir: DIR_PRUNE, retention: "1d" } },
            }],
        });
        await syncTenants();
        rest = new useRest({ internal: true, tenant_id: TENANT });
    });

    it("deletes stale files on the first write, without waiting", async () => {
        fs.mkdirSync(DIR_PRUNE, { recursive: true });
        const stale = path.join(DIR_PRUNE, `audit-${TENANT}-2019-12-31.jsonl`);
        fs.writeFileSync(stale, "{}\n");
        const old = new Date(Date.now() - 30 * 86400_000);
        fs.utimesSync(stale, old, old);

        await rest.audit.addActivities([activity("trigger-prune")]);
        await flushAuditFile();

        expect(fs.existsSync(stale)).toBe(false);
        expect(filesOf(DIR_PRUNE, TENANT).some((f) => f.includes(TODAY))).toBe(true);
    });
});
