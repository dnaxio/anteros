import { describe, it, expect, beforeAll } from "bun:test";
import { formatConfig } from "../server/config";
import { createSocketApp, handshakeToken } from "../server/socketGuard";

/**
 * #60 — the Socket.IO engine path is served before Hono, so it used to see none
 * of the API's policies. `createSocketApp` puts the **same** CORS/IP/headers in
 * front of it; the handshake token feeds the optional `authorize` hook.
 */

beforeAll(() => {
    formatConfig({
        server: {
            port: 4000,
            cors: { origin: ["https://app.test"], credentials: true },
        },
        tenants: [],
    } as any);
});

const preflight = (origin: string) => new Request("http://localhost/socket.io/?EIO=4&transport=polling", {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
});

describe("socket guard — CORS (#60)", () => {
    it("answers the preflight with the API policy", async () => {
        const res = await createSocketApp().request(preflight("https://app.test"));
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("https://app.test");
        expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    });

    it("does not allow another origin", async () => {
        const res = await createSocketApp().request(preflight("https://evil.test"));
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
});

describe("socket guard — headers and delegation", () => {
    it("reaches the engine and carries the security headers", async () => {
        const res = await createSocketApp().request(new Request("http://localhost/socket.io/", { method: "GET" }));
        // The engine refuses a request without a transport — the point is that it answered
        expect(res.status).toBe(400);
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });
});

describe("socket guard — handshake token", () => {
    it("prefers auth.token, then the header, then the query", () => {
        expect(handshakeToken({ auth: { token: "a" }, headers: {}, query: {} })).toBe("a");
        expect(handshakeToken({ auth: {}, headers: { authorization: "Bearer b" }, query: {} })).toBe("b");
        expect(handshakeToken({ auth: {}, headers: {}, query: { token: "c" } })).toBe("c");
        expect(handshakeToken({ auth: {}, headers: {}, query: {} })).toBeNull();
    });
});
