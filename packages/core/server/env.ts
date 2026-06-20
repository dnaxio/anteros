/**
 * Hono context variables shared by middleware and route handlers.
 */
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
};
