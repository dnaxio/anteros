import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createApp, resolveClientIp } from "../server/hono";
import { cfg, formatConfig } from "../server/config";

/**
 * #53 — the client address comes from the **trusted** proxy chain: `X-Forwarded-For`
 * is read right to left, only the configured hops are trusted, and a forged prefix
 * (or an unattested `CF-Connecting-IP`) cannot change the resolved IP.
 */

/** The socket address the fake request arrives from. */
const SOCKET = "10.0.0.1";

function app() {
    const app = new Hono<{ Variables: { clientIp: string } }>();
    app.use(async (c, next) => {
        c.set("clientIp", resolveClientIp(c as any, SOCKET));
        await next();
    });
    app.get("/", (c) => c.json({ ip: c.get("clientIp") }));
    return app;
}

async function ip(headers: Record<string, string>): Promise<string> {
    const server = Bun.serve({ port: 0, fetch: app().fetch });
    try {
        const res = await fetch(server.url, { headers });
        return ((await res.json()) as any).ip;
    } finally {
        server.stop(true);
    }
}

const configure = (trustProxy?: any) =>
    formatConfig({ server: { port: 4000, ...(trustProxy === undefined ? {} : { trustProxy }) }, tenants: [] });

describe("client IP (#53)", () => {
    it("uses the socket address when the proxy is not trusted", async () => {
        configure();
        expect(await ip({ "X-Forwarded-For": "1.2.3.4" })).toBe(SOCKET);
        expect(await ip({ "CF-Connecting-IP": "2.2.2.2" })).toBe(SOCKET);
    });

    it("reads X-Forwarded-For from the right — a forged prefix is ignored", async () => {
        configure(true);
        // One trusted proxy: it appended the address it saw, last in the list
        expect(await ip({ "X-Forwarded-For": "6.6.6.6, 1.2.3.4" })).toBe("1.2.3.4");
        expect(await ip({ "X-Forwarded-For": "1.2.3.4" })).toBe("1.2.3.4");
    });

    it("honours the configured hop count", async () => {
        configure({ hops: 2 });
        // Two proxies: client, proxy1 — a leading forged entry does not move the client
        expect(await ip({ "X-Forwarded-For": "9.9.9.9, 1.2.3.4, 5.6.7.8" })).toBe("1.2.3.4");
    });

    it("falls back to the socket on a short or invalid chain", async () => {
        configure({ hops: 3 });
        expect(await ip({ "X-Forwarded-For": "1.2.3.4" })).toBe(SOCKET);

        configure(true);
        expect(await ip({ "X-Forwarded-For": "not-an-ip" })).toBe(SOCKET);
    });

    it("only trusts CF-Connecting-IP when Cloudflare is declared", async () => {
        configure(true);
        expect(await ip({ "CF-Connecting-IP": "2.2.2.2" })).toBe(SOCKET);

        configure({ cloudflare: true });
        expect(await ip({ "CF-Connecting-IP": "2.2.2.2" })).toBe("2.2.2.2");
    });

    it("applies `ipRestriction` to the resolved client, not to the proxy", async () => {
        configure({ hops: 1 });
        (cfg.server as any).ipRestriction = { allowList: ["1.2.3.4"] };
        try {
            const app = createApp();
            app.get("/echo-ip", (c) => c.json({ ip: c.get("clientIp") }));
            const server = Bun.serve({ port: 0, fetch: app.fetch });
            try {
                const target = new URL("/echo-ip", server.url);
                // The client sits behind the proxy: the list sees 1.2.3.4, not 10.0.0.1
                const allowed = await fetch(target, { headers: { "X-Forwarded-For": "9.9.9.9, 1.2.3.4" } });
                expect(allowed.status).toBe(200);
                expect(((await allowed.json()) as any).ip).toBe("1.2.3.4");

                const denied = await fetch(target, { headers: { "X-Forwarded-For": "9.9.9.9" } });
                expect(denied.status).toBe(403);
            } finally {
                server.stop(true);
            }
        } finally {
            (cfg.server as any).ipRestriction = undefined;
        }
    });

    it("strips a port from a forwarded entry", async () => {
        configure(true);
        expect(await ip({ "X-Forwarded-For": "1.2.3.4:5555" })).toBe("1.2.3.4");
    });
});
