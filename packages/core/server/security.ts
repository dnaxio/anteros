import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import type { ConnInfo } from "hono/conninfo";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RateLimitStore = {
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
};

export type RateLimitOptions = {
  windowMs?: number;
  max?: number;
  message?: string;
  code?: string;
  statusCode?: number;
  keyGenerator?: (c: Context) => string | Promise<string>;
  store?: RateLimitStore;
};

export type RedisClient = {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
};

// ─── In-Memory Store ─────────────────────────────────────────────────────────

interface MemoryEntry {
  count: number;
  resetAt: number;
}

export function createMemoryStore(cleanupIntervalMs = 60000): RateLimitStore & { dispose(): void } {
  const store = new Map<string, MemoryEntry>();
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) {
        store.delete(key);
      }
    }
  };

  cleanupTimer = setInterval(cleanup, cleanupIntervalMs);
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    (cleanupTimer as any).unref();
  }

  return {
    async increment(key: string, windowMs: number) {
      const now = Date.now();
      const entry = store.get(key);

      if (!entry || entry.resetAt <= now) {
        const resetAt = now + windowMs;
        store.set(key, { count: 1, resetAt });
        return { count: 1, resetAt };
      }

      entry.count += 1;
      return { count: entry.count, resetAt: entry.resetAt };
    },

    dispose() {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      store.clear();
    },
  };
}

// ─── Redis Store ─────────────────────────────────────────────────────────────

export function createRedisStore(redis: RedisClient): RateLimitStore {
  return {
    async increment(key: string, windowMs: number) {
      const count = await redis.incr(key);

      // First increment in this window – set the expiry
      if (count === 1) {
        await redis.pexpire(key, windowMs);
      }

      const ttl = await redis.pttl(key);
      const resetAt = Date.now() + Math.max(0, ttl);

      return { count, resetAt };
    },
  };
}

// ─── Default key generator ───────────────────────────────────────────────────

function defaultKeyGenerator(c: Context): string {
  // Prefer the client IP resolved once by the app middleware (trustProxy-aware).
  const clientIp = (c as any).get('clientIp') as string | undefined;
  if (clientIp) return `rn:rl:${clientIp}`;

  // Fallback: real socket address only (no spoofable proxy headers)
  let connInfo: ConnInfo | null = null;
  try {
    connInfo = getConnInfo(c);
  } catch {
    // getConnInfo throws outside a real Bun.serve (e.g. unit tests)
  }
  return `rn:rl:${connInfo?.remote.address ?? 'unknown'}`;
}

// ─── Middleware ──────────────────────────────────────────────────────────────

export function rateLimit(opts: RateLimitOptions = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 60;
  const message = opts.message ?? "Too many requests, please try again later";
  const code = opts.code ?? "RATE_LIMIT_EXCEEDED";
  const statusCode = opts.statusCode ?? 429;
  const keyGenerator = opts.keyGenerator ?? defaultKeyGenerator;
  const store = opts.store ?? createMemoryStore();

  return async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const key = await keyGenerator(c);
    const { count, resetAt } = await store.increment(key, windowMs);
    const remaining = Math.max(0, max - count);

    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));

    if (count > max) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json({ message, code }, statusCode as any);
    }

    await next();
  };
}
