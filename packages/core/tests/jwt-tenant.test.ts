import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../server/hono";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { useRest } from "../database/rest";
import { jwt } from "../utils/func";

/**
 * #35 — a JWT is bound to its tenant: the login action signs a `tenant` claim,
 * and a token only opens the routes of that tenant.
 */

const TA = "jwt-tenant-a";
const TB = "jwt-tenant-b";
const DB_A = "mongodb://localhost:27017/_JWT_TENANT_A";
const DB_B = "mongodb://localhost:27017/_JWT_TENANT_B";
const SECRET = "jwt-tenant-test-secret";

let server: any;
let url = "";
let restA: InstanceType<typeof useRest>;
let restB: InstanceType<typeof useRest>;

function collectionFor(tenant: string) {
    return {
        _tenant_: tenant,
        slug: "users",
        fields: [{ name: "email", type: "string" }],
        api: {
            access: { "*": true },
            auth: {
                enabled: true,
                onLogin: async ({ payload, jwt: signer, cookies }: any) => {
                    const token = await signer.sign({ sub: payload.email });
                    cookies.set("session", token);
                    return { token, data: { email: payload.email } };
                },
                onLogout: async ({ cookies }: any) => {
                    cookies.delete("session", { domain: ".example.com" });
                },
            },
        },
    };
}

async function login(tenant: string, email = "u@test"): Promise<{ status: number; token?: string }> {
    const res = await fetch(`${url}/api/${tenant}/collections/users/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: { email } }),
    });
    const body: any = await res.json();
    return { status: res.status, token: body.token };
}

const withToken = (path: string, token?: string, method = "GET") =>
    fetch(`${url}${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });

beforeAll(async () => {
    formatConfig({
        server: { port: 4000, jwt: { secret: SECRET } },
        tenants: [
            { id: TA, dir: "src", database: { uri: DB_A } },
            { id: TB, dir: "src", database: { uri: DB_B } },
        ],
    });
    await syncTenants();
    (cfg as any).collections = [collectionFor(TA), collectionFor(TB)];
    restA = new useRest({ internal: false, tenant_id: TA });
    restB = new useRest({ internal: false, tenant_id: TB });
    const app = createApp();
    server = Bun.serve({ port: 0, fetch: app.fetch });
    url = server.url.href.replace(/\/$/, "");
});

afterAll(async () => {
    try { await restA.db.dropDatabase(); } catch {}
    try { await restB.db.dropDatabase(); } catch {}
    try { server.stop(true); } catch {}
    delete (cfg.server.jwt as any)?.requireTenantClaim;
});

describe("JWT — tenant claim (#35)", () => {
    it("signs the tenant into the token", async () => {
        const { status, token } = await login(TA);
        expect(status).toBe(200);
        expect(token).toBeString();

        const verified = await jwt.verify(token!);
        expect(verified.error).toBeNull();
        expect(verified.value?.tenant).toBe(TA);
    });

    it("refuses a token on another tenant's collection API", async () => {
        const token = (await login(TA)).token!;
        const same = await withToken(`/api/${TA}/collections/users/find`, token, "POST");
        expect(same.status).toBe(200);

        const other = await withToken(`/api/${TB}/collections/users/find`, token, "POST");
        expect(other.status).toBe(401);
        expect(((await other.json()) as any).code).toBe("TENANT_MISMATCH");
    });

    it("refuses a token on another tenant's public config", async () => {
        const token = (await login(TA)).token!;
        expect((await withToken(`/_dnax/config/${TA}`, token)).status).toBe(200);

        const other = await withToken(`/_dnax/config/${TB}`, token);
        expect(other.status).toBe(401);
        expect(((await other.json()) as any).code).toBe("TENANT_MISMATCH");
    });

    it("can require a tenant claim (legacy tokens rejected)", async () => {
        cfg.server = { ...cfg.server, jwt: { ...cfg.server.jwt, requireTenantClaim: true } };

        const legacy = await jwt.sign({ sub: "legacy" });
        const rejected = await withToken(`/_dnax/config/${TA}`, legacy);
        expect(rejected.status).toBe(401);
        expect(((await rejected.json()) as any).code).toBe("TENANT_CLAIM_REQUIRED");

        const withClaim = await jwt.sign({ sub: "new", tenant: TA });
        expect((await withToken(`/_dnax/config/${TA}`, withClaim)).status).toBe(200);
    });
});

describe("cookies — safe defaults and matching deletion (#48)", () => {
    const cookiesOf = (res: Response): string => {
        const list = typeof (res.headers as any).getSetCookie === "function"
            ? (res.headers as any).getSetCookie()
            : [res.headers.get("set-cookie")];
        return (list as (string | null)[]).filter(Boolean).join("; ");
    };

    it("sets HttpOnly / SameSite=Lax / Path=/ by default", async () => {
        const res = await fetch(`${url}/api/${TA}/collections/users/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ payload: { email: "cookie@test" } }),
        });
        expect(res.status).toBe(200);
        const cookie = cookiesOf(res);
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Lax");
        expect(cookie).toContain("Path=/");
    });

    it("deletes the cookie with the same domain", async () => {
        const login = await fetch(`${url}/api/${TA}/collections/users/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ payload: { email: "cookie@test" } }),
        });
        const token = ((await login.json()) as any).token;

        const res = await fetch(`${url}/api/${TA}/collections/users/logout`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ payload: {} }),
        });
        expect(res.status).toBe(200);
        const cookie = cookiesOf(res);
        expect(cookie).toContain("Domain=.example.com");
        expect(cookie.toLowerCase()).toContain("max-age=0");
    });
});
