/**
 * Default idle timeout of an HTTP connection, in **seconds** (Bun's unit).
 *
 * Bun's own default is 10 s; the framework makes the value explicit and gives a
 * little more room to a slow handler (a report, an export), while still cutting a
 * stalled client. `0` disables the timeout.
 *
 * It bounds the **connection**, not the handler: a slow query keeps running after
 * the socket is gone — it simply has nothing left to answer on.
 */
const DEFAULT_HTTP_IDLE_TIMEOUT = 30;

/**
 * Resolve `server.http.idleTimeout` into what `Bun.serve()` accepts.
 *
 * - omitted → the framework default (`30`)
 * - `0` → no timeout
 * - anything outside `0..255` (Bun's range) → clamped, so a typo never kills the boot
 * - a fractional value below 1 → `1`, never an accidental disable
 * - a non-finite value → the default
 */
function resolveHttpIdleTimeout(config?: { idleTimeout?: number }): number {
    const value = config?.idleTimeout;
    if (value === undefined) return DEFAULT_HTTP_IDLE_TIMEOUT;
    if (!Number.isFinite(value)) return DEFAULT_HTTP_IDLE_TIMEOUT;
    if (value === 0) return 0;
    return Math.max(1, Math.min(255, Math.floor(value)));
}

export { resolveHttpIdleTimeout, DEFAULT_HTTP_IDLE_TIMEOUT };
