/**
 * Hono context variables shared by middleware and route handlers.
 */
import type { ConnInfo } from "hono/conninfo";

export type HonoVariables = {
    /** Present when `Authorization: Bearer <jwt>` was sent and verification succeeded. */
    token?: {
        /** Raw JWT string from the `Authorization` header. */
        value: string | null;
        /** Verified payload (claims). */
        decoded: Record<string, unknown> | null;
        /** Whether a token was provided in the Authorization header */
        provided: boolean;
        /** Whether the token is expired */
        expired: boolean;
    };
    /** Best-effort client IP, resolved once per request (real socket, or trusted proxy header when cfg.server.trustProxy). */
    clientIp?: string;
    /** Connection info (real socket address) — set once per request by the IP middleware. */
    connInfo?: ConnInfo;
};
