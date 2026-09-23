import { describe, it, expect } from "bun:test";
import { endpoints, FAMILIES, isReservedFamily, patterns, segment } from "../lib/endpoints";

/**
 * The URL of everything — pinned here so a change of shape is a **deliberate**
 * change (the whole surface moved to `/api/:tenant_id/<family>/…` once already,
 * and every client, doc and skill had to follow).
 */

describe("endpoints — the server patterns", () => {
    it("keeps every surface under `/api/:tenant_id/<family>`", () => {
        for (const pattern of Object.values(patterns)) {
            expect(pattern.startsWith("/api/:tenant_id/")).toBe(true);
        }
    });

    it("names a family the builders also use", () => {
        const families = new Set<string>(FAMILIES);
        for (const pattern of Object.values(patterns)) {
            const [, , , family] = pattern.split("/");
            expect(families.has(family!)).toBe(true);
        }
    });

    it("registers no pattern that could shadow a collection action", () => {
        // A collection lives under `/collections/`, so `services`, `vars` or `login`
        // are usable as collection names — that is the point of the layout.
        expect(patterns.collection.split("/")[3]).toBe("collections");
        expect(patterns.login).toBe("/api/:tenant_id/collections/:collection/login");
    });
});

describe("endpoints — the builders", () => {
    it("builds the documented paths", () => {
        expect(endpoints.collection("v1", "orders", "find")).toBe("/api/v1/collections/orders/find");
        expect(endpoints.collection("v1", "users", "login")).toBe("/api/v1/collections/users/login");
        expect(endpoints.service("v1", "billing", "charge")).toBe("/api/v1/services/billing/charge");
        expect(endpoints.vars("v1", "get")).toBe("/api/v1/vars/get");
        expect(endpoints.upload("v1", "photos")).toBe("/api/v1/upload/photos");
        expect(endpoints.file("v1", "photos", "507f1f77.jpg")).toBe("/api/v1/files/photos/507f1f77.jpg");
        expect(endpoints.agent("v1", "support", "generate")).toBe("/api/v1/agents/support/generate");
        expect(endpoints.mcp("v1")).toBe("/api/v1/mcp");
    });

    it("matches the pattern it maps to", () => {
        const mapped: Array<[string, string]> = [
            [patterns.collection, endpoints.collection("t", "c", "a")],
            [patterns.login, endpoints.collection("t", "c", "login")],
            [patterns.service, endpoints.service("t", "s", "a")],
            [patterns.vars, endpoints.vars("t", "a")],
            [patterns.upload, endpoints.upload("t", "c")],
            [patterns.file, endpoints.file("t", "c", "f")],
            [patterns.agent, endpoints.agent("t", "ag", "a")],
            [patterns.mcp, endpoints.mcp("t")],
        ];

        for (const [pattern, path] of mapped) {
            const expected = pattern.split("/").slice(1);
            expect(path.split("/").slice(1)).toHaveLength(expected.length);
            // Same shape: each `:param` is one segment, the literals are identical
            for (const [index, part] of expected.entries()) {
                if (part.startsWith(":")) continue;
                expect(path.split("/").slice(1)[index]).toBe(part);
            }
        }
    });

    it("encodes a segment, so an id with a slash cannot forge a path", () => {
        expect(segment("a/b c")).toBe("a%2Fb%20c");
        expect(endpoints.file("v1", "photos", "../etc/passwd")).toBe("/api/v1/files/photos/..%2Fetc%2Fpasswd");
    });
});

describe("endpoints — reserved families", () => {
    it("recognises what a tenant route must not shadow", () => {
        for (const family of FAMILIES) expect(isReservedFamily(family)).toBe(true);
        expect(isReservedFamily("orders")).toBe(false);
        expect(isReservedFamily("Collections")).toBe(false);
    });
});
