/**
 * Token information available in request context and handlers.
 * Always present (even without a token — use `provided` to check).
 */
export type Token = {
  /** Raw JWT string from the `Authorization` header, or null if not sent */
  value: string | null;
  /** Verified payload (claims), or null if invalid / expired / not sent */
  decoded: Record<string, unknown> | null;
  /** Whether a token was provided in the Authorization header */
  provided: boolean;
  /** Whether the token is expired */
  expired: boolean;
};
