import { describe, expect, test } from "bun:test";
import { applyCors, isPreflight, preflightResponse, resolveCors } from "../lib/cors";

const allowed = resolveCors({
    origins: ["https://app.example.com"],
    methods: ["GET", "POST"],
    exposeHeaders: ["x-request-id"],
    maxAge: 300,
})!;

function preflight(origin = "https://app.example.com"): Request {
    return new Request("http://gateway/api/pharmacie/x", {
        method: "OPTIONS",
        headers: {
            origin,
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization, content-type",
        },
    });
}

describe("resolveCors", () => {
    test("refuses credentials with a wildcard origin", () => {
        expect(() => resolveCors({ origins: "*", credentials: true })).toThrow();
    });

    test("normalizes methods and defaults maxAge", () => {
        const cors = resolveCors({ origins: "*", methods: ["get", "post"] })!;
        expect(cors.methods).toEqual(["GET", "POST"]);
        expect(cors.maxAge).toBe(600);
    });
});

describe("CORS preflight", () => {
    test("detects a browser preflight and answers it locally", () => {
        expect(isPreflight(preflight())).toBe(true);
        const response = preflightResponse(allowed, preflight());

        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
        expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST");
        expect(response.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
        expect(response.headers.get("access-control-max-age")).toBe("300");
        expect(response.headers.get("vary")).toContain("Origin");
    });

    test("answers without allow headers for a disallowed origin", () => {
        const response = preflightResponse(allowed, preflight("https://evil.example.com"));
        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
});

describe("applyCors", () => {
    test("adds the policy and removes upstream CORS headers", async () => {
        const upstream = new Response("ok", {
            headers: {
                "access-control-allow-origin": "*",
                "access-control-allow-methods": "PUT",
                "content-type": "text/plain",
            },
        });

        const response = applyCors(upstream, allowed, "https://app.example.com");
        expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
        expect(response.headers.get("access-control-allow-methods")).toBeNull();
        expect(response.headers.get("access-control-expose-headers")).toBe("x-request-id");
        expect(await response.text()).toBe("ok");
    });

    test("leaves a response without an Origin free of CORS headers", () => {
        const response = applyCors(new Response("ok"), allowed, null);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
});
