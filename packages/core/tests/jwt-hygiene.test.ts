import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Jose from "jose";
import { createApp } from "../server/hono";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { saveJwtSecret } from "../server/envFile";
import { jwt } from "../utils/func";

/**
 * #52 — JWT hygiene: a presented token must verify **everywhere** (except the two
 * session endpoints), `exp` is required, `iss` / `aud` are checked when configured,
 * and an auto-generated secret is written owner-only.
 */

const TENANT = "jwt-hygiene";
const DB = "mongodb://localhost:27017/_JWT_HYGIENE_TEST";
const SECRET = "jwt-hygiene-test-secret-at-least-32-ch";
const ISSUER = "anteros-test";

let server: any;
let url = "";

const secret = new TextEncoder().encode(SECRET);

/** Sign with `jose` directly, to control `exp` and `iss` precisely. */
async function signRaw(
    payload: Record<string, unknown> = { sub: "u" },
    opts: { exp?: number; iss?: string } = {},
): Promise<string> {
    let signer = new Jose.SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuedAt();
    if (opts.exp !== undefined) signer = signer.setExpirationTime(opts.exp);
    if (opts.iss) signer = signer.setIssuer(opts.iss);
    return signer.sign(secret);
}

const post = (pathname: string, token?: string, body: any = {}) =>
    fetch(`${url}${pathname}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
    });

const find = (token?: string) => post(`/api/${TENANT}/collections/users/find`, token);

beforeAll(async () => {
    formatConfig({
        server: { port: 4000, jwt: { secret: SECRET, issuer: ISSUER } },
        tenants: [{ id: TENANT, dir: "src", database: { uri: DB } }],
    });
    await syncTenants();

    (cfg as any).collections = [{
        _tenant_: TENANT,
        slug: "users",
        fields: [{ name: "email", type: "string" }],
        api: {
            // Public action — the point is that a *presented* token still has to verify
            access: { "*": true },
            auth: {
                enabled: true,
                onLogin: async ({ payload, jwt: signer }: any) => {
                    const token = await signer.sign({ sub: payload.email });
                    return { token, data: { email: payload.email } };
                },
                onLogout: async () => ({ ok: true }),
            },
        },
    }];

    const app = createApp();
    server = Bun.serve({ port: 0, fetch: app.fetch });
    url = server.url.href.replace(/\/$/, "");
});

afterAll(async () => {
    try {
        const { MongoClient } = await import("mongodb");
        const client = new MongoClient(DB);
        await client.connect();
        await client.db().dropDatabase();
        await client.close();
    } catch (_) {}
    try { server.stop(true); } catch (_) {}
});

describe("JWT hygiene — a presented token must verify (#52)", () => {
    it("accepts a request with no token on a public action", async () => {
        expect((await find()).status).toBe(200);
    });

    it("accepts a valid token", async () => {
        const token = await jwt.sign({ sub: "u" });
        expect((await find(token)).status).toBe(200);
    });

    it("rejects a forged token, even on a public action", async () => {
        const res = await find("not-a-token");
        expect(res.status).toBe(401);
        expect(((await res.json()) as any).code).toBe("INVALID_TOKEN");
    });

    it("rejects an expired token with `TOKEN_EXPIRED`", async () => {
        const token = await signRaw({ sub: "u" }, { exp: Math.floor(Date.now() / 1000) - 60, iss: ISSUER });
        const res = await find(token);
        expect(res.status).toBe(401);
        expect(((await res.json()) as any).code).toBe("TOKEN_EXPIRED");
    });

    it("rejects a token with no `exp` claim", async () => {
        const token = await signRaw({ sub: "u" }, { iss: ISSUER });
        const res = await find(token);
        expect(res.status).toBe(401);
        expect(((await res.json()) as any).code).toBe("INVALID_TOKEN");
    });

    it("rejects a token from another issuer", async () => {
        const token = await signRaw({ sub: "u" }, { exp: Math.floor(Date.now() / 1000) + 3600, iss: "someone-else" });
        const res = await find(token);
        expect(res.status).toBe(401);
        expect(((await res.json()) as any).code).toBe("INVALID_TOKEN");
    });
});

describe("JWT hygiene — the session endpoints stay reachable", () => {
    it("lets login through with an expired token (it replaces it)", async () => {
        const expired = await signRaw({ sub: "u" }, { exp: Math.floor(Date.now() / 1000) - 60, iss: ISSUER });
        const res = await post(`/api/${TENANT}/collections/users/login`, expired, { payload: { email: "u@test" } });
        expect(res.status).toBe(200);

        // …and the token it hands back is valid, with the configured issuer
        const body: any = await res.json();
        const verified = await jwt.verify(body.token);
        expect(verified.error).toBeNull();
        expect(verified.value?.iss).toBe(ISSUER);
    });

    it("lets logout through with an invalid token", async () => {
        const res = await post(`/api/${TENANT}/collections/users/logout`, "not-a-token", { payload: {} });
        expect(res.status).toBe(200);
    });
});

describe("JWT secret file", () => {
    it("writes the secret owner-only (0600), and tightens an existing file", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "jwt-env-"));
        const file = path.join(dir, ".env");
        try {
            // Existing file with the default umask
            writeFileSync(file, "APP_ENV=test\n", { mode: 0o644 });

            expect(await saveJwtSecret("a".repeat(64), file)).toBe(true);
            expect(statSync(file).mode & 0o777).toBe(0o600);
            const content = readFileSync(file, "utf8");
            expect(content).toContain(`JWT_SECRET=${"a".repeat(64)}`);
            expect(content).toContain("APP_ENV=test");

            // Idempotent: an existing JWT_SECRET is never overwritten
            expect(await saveJwtSecret("b".repeat(64), file)).toBe(false);
            expect(readFileSync(file, "utf8")).toContain(`JWT_SECRET=${"a".repeat(64)}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("creates the file with 0600 when it does not exist", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "jwt-env-"));
        const file = path.join(dir, ".env");
        try {
            expect(await saveJwtSecret("c".repeat(64), file)).toBe(true);
            expect(statSync(file).mode & 0o777).toBe(0o600);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("ignores a comment that mentions `JWT_SECRET=` (#63)", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "jwt-env-"));
        const file = path.join(dir, ".env");
        try {
            // A comment is not an assignment — it used to block persistence, and the
            // generated secret then lived in memory only (every restart logged everyone out)
            writeFileSync(file, "# set your own: JWT_SECRET=please-change\nAPP_ENV=test\n");

            expect(await saveJwtSecret("d".repeat(64), file)).toBe(true);
            const content = readFileSync(file, "utf8");
            expect(content).toContain(`JWT_SECRET=${"d".repeat(64)}`);
            expect(content).toContain("# set your own: JWT_SECRET=please-change");
            expect(statSync(file).mode & 0o777).toBe(0o600);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("fills an empty `JWT_SECRET=` in place, without duplicating it (#63)", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "jwt-env-"));
        const file = path.join(dir, ".env");
        try {
            writeFileSync(file, "APP_ENV=test\nJWT_SECRET=\nOTHER=1\n");

            expect(await saveJwtSecret("e".repeat(64), file)).toBe(true);
            const assignments = readFileSync(file, "utf8")
                .split("\n")
                .filter((line) => line.startsWith("JWT_SECRET="));
            expect(assignments).toHaveLength(1);
            expect(assignments[0]).toBe(`JWT_SECRET=${"e".repeat(64)}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("leaves a configured secret alone", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "jwt-env-"));
        const file = path.join(dir, ".env");
        try {
            writeFileSync(file, "JWT_SECRET=already-set\n");
            expect(await saveJwtSecret("f".repeat(64), file)).toBe(false);
            expect(readFileSync(file, "utf8")).toContain("JWT_SECRET=already-set");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
