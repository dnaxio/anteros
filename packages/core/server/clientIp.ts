import { isIP } from "node:net";
import { cfg } from "./config";

/** Strip brackets / port and refuse anything that is not a literal IP. */
function normalizeIp(value?: string | null): string | null {
    if (!value) return null;
    let ip = value.trim();
    if (ip.startsWith("[")) {
        const end = ip.indexOf("]");
        ip = end > 0 ? ip.slice(1, end) : ip;
    } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
        ip = ip.slice(0, ip.lastIndexOf(":"));
    }
    return isIP(ip) ? ip : null;
}

/**
 * The client address, resolved from the **trusted** proxy chain (#53).
 *
 * `X-Forwarded-For` is read right to left: each proxy appends the address it saw, so
 * with `hops` proxies the client is the entry `hops` from the end. Anything further
 * left is caller-supplied and ignored — rotating a forged prefix cannot mint a new
 * rate-limit bucket or a new audit IP. `CF-Connecting-IP` is only read when
 * `cloudflare` is set, because any client can send that header too.
 *
 * Shared by the API middleware and the Socket.IO engine path (#60), so both see
 * the same address for the same client.
 */
function resolveClientIp(headers: Headers, socketIp?: string): string {
    const fallback = socketIp || "unknown";
    const trust = cfg.server.trustProxy;
    if (!trust) return fallback;

    const options = trust === true ? {} : trust;
    const hops = Math.max(1, Math.min(16, Math.floor(options.hops ?? 1)));

    if (options.cloudflare) {
        const cf = normalizeIp(headers.get("CF-Connecting-IP"));
        if (cf) return cf;
    }

    const chain = (headers.get("X-Forwarded-For") ?? "")
        .split(",")
        .map((entry) => normalizeIp(entry))
        .filter((entry): entry is string => Boolean(entry));

    return chain[chain.length - hops] ?? fallback;
}

export { normalizeIp, resolveClientIp };
