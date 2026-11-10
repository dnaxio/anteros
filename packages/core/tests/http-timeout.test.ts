import { describe, it, expect } from "bun:test";
import { DEFAULT_HTTP_IDLE_TIMEOUT, resolveHttpIdleTimeout } from "../server/http";

/**
 * `server.http.idleTimeout` (#63) — the connection timeout is explicit, configurable,
 * and clamped to what `Bun.serve()` accepts (seconds, `0` = none, max `255`).
 */

describe("HTTP idle timeout", () => {
    it("defaults to 30 seconds", () => {
        expect(DEFAULT_HTTP_IDLE_TIMEOUT).toBe(30);
        expect(resolveHttpIdleTimeout(undefined)).toBe(30);
        expect(resolveHttpIdleTimeout({})).toBe(30);
    });

    it("takes the configured value", () => {
        expect(resolveHttpIdleTimeout({ idleTimeout: 5 })).toBe(5);
        expect(resolveHttpIdleTimeout({ idleTimeout: 255 })).toBe(255);
    });

    it("lets an explicit 0 disable it", () => {
        expect(resolveHttpIdleTimeout({ idleTimeout: 0 })).toBe(0);
    });

    it("never disables it by accident on a fractional value", () => {
        expect(resolveHttpIdleTimeout({ idleTimeout: 0.4 })).toBe(1);
    });

    it("clamps outside Bun's range instead of failing the boot", () => {
        expect(resolveHttpIdleTimeout({ idleTimeout: 600 })).toBe(255);
        expect(resolveHttpIdleTimeout({ idleTimeout: -3 })).toBe(1);
    });

    it("falls back to the default on a non-finite value", () => {
        expect(resolveHttpIdleTimeout({ idleTimeout: Number.NaN })).toBe(30);
        expect(resolveHttpIdleTimeout({ idleTimeout: Number.POSITIVE_INFINITY })).toBe(30);
    });
});
