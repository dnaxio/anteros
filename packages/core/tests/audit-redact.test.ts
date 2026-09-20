import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import { createApp } from "../server/hono";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { useRest } from "../database/rest";
import { AUDIT_COLLECTION } from "../database/audit";
import { REDACTED, redactPayload } from "../lib/redact";

const TENANT = "redact-test";
const DB = "mongodb://localhost:27017/_AUDIT_REDACT_TEST";
const SLUG = "patients";

let rest: InstanceType<typeof useRest>;
let server: any;
let url = "";

/** Latest audited entry for an action, written *after* `since` (fire-and-forget logging) */
async function lastActivity(action: string, since?: Date) {
    for (let i = 0; i < 40; i++) {
        const found: any = await rest.db.collection(AUDIT_COLLECTION).findOne(
            { "operation.action": action, ...(since ? { ts: { $gte: since } } : {}) },
            { sort: { ts: -1 } },
        );
        if (found) return found;
        await Bun.sleep(25);
    }
    return null;
}

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
);

beforeAll(async () => {
    formatConfig({
        server: { port: 4000, jwt: { secret: "redact-secret" } },
        tenants: [{ id: TENANT, dir: "src", database: { uri: DB } }],
    });
    await syncTenants();

    (cfg as any).collections = [{
        _tenant_: TENANT,
        slug: SLUG,
        fields: [
            { name: "name", type: "string" },
            { name: "password", type: "string" },
            { name: "ssn", type: "string" },
            { name: "profile", type: "json" },
            { name: "list", type: "json" },
        ],
        api: {
            access: { "*": true },
            auth: {
                enabled: true,
                onLogin: async ({ payload, jwt }: any) => ({
                    // `jwt.sign` is async — must be awaited, or the token fails verification
                    token: await jwt.sign({ sub: payload.email }),
                    data: { email: payload.email },
                }),
            },
        },
    }];

    rest = new useRest({ internal: false, tenant_id: TENANT });

    const app = createApp();
    server = Bun.serve({ port: 0, fetch: app.fetch });
    url = server.url.href.replace(/\/$/, "");
});

afterAll(async () => {
    try { await rest.db.collection(SLUG).drop(); } catch (_) {}
    try { await rest.db.collection(AUDIT_COLLECTION).drop(); } catch (_) {}
    try { server.stop(true); } catch {}
    delete (cfg.server as any).audit;
});

describe("audit redaction — defaults", () => {
    it("masks the password of a login payload (success path)", async () => {
        const since = new Date();
        const res = await fetch(`${url}/api/${TENANT}/${SLUG}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ payload: { email: "ada@example.com", password: "SuperSecret123!" } }),
        });
        expect(res.status).toBe(200);

        const logged = await lastActivity("login", since);
        expect(logged.operation.status).toBe("success");
        expect(logged.operation.input.payload.password).toBe(REDACTED);
        expect(logged.operation.input.payload.email).toBe("ada@example.com"); // untouched
    });

    it("masks the password of a login payload (failure path)", async () => {
        const since = new Date();
        const res = await fetch(`${url}/api/${TENANT}/${SLUG}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ payload: { email: "bad", password: "WrongOne!" } }),
        });
        // unknown user is not the point here — whatever the status, the payload is logged
        expect(res.status).toBeGreaterThanOrEqual(200);

        const logged = await lastActivity("login", since);
        expect(logged.operation.input.payload.password).toBe(REDACTED);
    });

    it("masks keys at any depth, in arrays, case-insensitively — and stores no result data", async () => {
        const since = new Date();
        const doc: any = await rest.insertOne(SLUG, {
            name: "John",
            password: "p4ss",
            profile: { apiKey: "k-123", nested: { token: "tok", ok: "keep" } },
            list: [{ key: "secret-key", label: "visible" }],
        });

        const logged = await lastActivity("insertOne", since);
        const input = logged.operation.input.data;
        expect(input.name).toBe("John");
        expect(input.password).toBe(REDACTED);
        expect(input.profile.apiKey).toBe(REDACTED);
        expect(input.profile.nested.token).toBe(REDACTED);
        expect(input.profile.nested.ok).toBe("keep");
        expect(input.list[0].key).toBe(REDACTED);
        expect(input.list[0].label).toBe("visible");

        // The result holds the generated identifier only — no document, and
        // therefore no value to leak in the first place.
        expect(logged.operation.result).toEqual({ _id: doc._id });

        // …while the caller still received the real values
        expect(doc.password).toBe("p4ss");
    });

    it("never alters non-plain values (Date, ObjectId) or the payload reference when nothing matches", async () => {
        // Direct check on the redactor: non-plain objects pass through untouched
        const when = new Date();
        const id = new ObjectId();
        const clean = { name: "x", when, id, list: [when] };
        expect(redactPayload(clean)).toBe(clean); // same reference — no allocation

        const dirty = redactPayload({ when, id, password: "p" });
        expect(dirty.when).toBe(when);
        expect(dirty.id).toBe(id);
        expect(dirty.password).toBe(REDACTED);

        // …and on a real entry: only the generated id comes back
        const since = new Date();
        await rest.insertOne(SLUG, { name: "dates" });
        const logged = await lastActivity("insertOne", since);
        expect(logged.operation.result._id).toBeString();
        expect(typeof logged.operation.duration).toBe("number");
    });

    it("redacts the request headers and query string", async () => {
        const since = new Date();
        const res = await fetch(`${url}/api/${TENANT}/${SLUG}/find?token=query-secret&page=2`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer fake.jwt",
                "X-API-Key": "api-key-secret",
                "X-Trace": "keep-me",
            },
            body: JSON.stringify({ $limit: 1 }),
        });
        expect(res.status).toBe(200);

        const logged = await lastActivity("find", since);
        // `authorization` and `cookie` are dropped by the request middleware
        expect(logged.request.headers.authorization).toBeUndefined();
        // …the rest goes through the redactor: `x-api-key` → `api_key`, `token` → `token`
        expect(logged.request.headers["x-api-key"]).toBe(REDACTED);
        expect(logged.request.query.token).toBe(REDACTED);
        // innocuous values are kept
        expect(logged.request.headers["x-trace"]).toBe("keep-me");
        expect(logged.request.query.page).toBe("2");
    });

    it("masks the headers-like `authorization` key of a custom activity", async () => {
        await rest.audit.addActivities([{
            internal: true,
            trace: { id: crypto.randomUUID() },
            meta: { authorization: "Bearer abc" },
            operation: {
                tenant: TENANT, action: "manual", collection: SLUG,
                status: "success", input: { authorization: "Bearer xyz", token: "t" },
                result: null, error: null, duration: 0, transaction: false,
            },
            ts: new Date(),
        } as any]);

        const logged: any = await rest.db.collection(AUDIT_COLLECTION).findOne({ "operation.action": "manual" });
        expect(logged.operation.input.authorization).toBe(REDACTED);
        expect(logged.operation.input.token).toBe(REDACTED);
        expect(logged.meta.authorization).toBe(REDACTED);
    });
});

describe("audit redaction — configuration", () => {
    it("uses a custom key list instead of the defaults", async () => {
        (cfg.server as any).audit = { redact: ["ssn"] };

        const since = new Date();
        await rest.insertOne(SLUG, { name: "custom", password: "keep-me", ssn: "123-45-6789" });

        const logged = await lastActivity("insertOne", since);
        expect(logged.operation.input.data.ssn).toBe(REDACTED);
        expect(logged.operation.input.data.password).toBe("keep-me");
    });

    it("can be disabled with `redact: false`", async () => {
        (cfg.server as any).audit = { redact: false };

        const since = new Date();
        await rest.insertOne(SLUG, { name: "off", password: "clear" });

        const logged = await lastActivity("insertOne", since);
        expect(logged.operation.input.data.password).toBe("clear");
    });

    it("falls back to the defaults when unset", async () => {
        delete (cfg.server as any).audit;

        const since = new Date();
        await rest.insertOne(SLUG, { name: "back", password: "masked-again" });

        const logged = await lastActivity("insertOne", since);
        expect(logged.operation.input.data.password).toBe(REDACTED);
    });
});
