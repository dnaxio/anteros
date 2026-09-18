// Caddy Admin API client + diff logic.
//
// `ros` manages a dedicated Caddy server named `anteros`, isolated from
// any user-managed Caddyfile. Routes are pushed via the Admin API on
// http://localhost:2019 (or the configured `admin` URL).
//
// References:
//   https://caddyserver.com/docs/api

import type { CaddyRoute } from "./types.ts"

const DEFAULT_ADMIN = "http://localhost:2019"

/**
 * Resolve the Caddy admin URL.
 *   - `CADDY_ADMIN` env var if set
 *   - else `http://localhost:2019` (Caddy default)
 */
export function caddyAdminUrl(): string {
  return process.env.CADDY_ADMIN ?? DEFAULT_ADMIN
}

/**
 * Build the Caddy route JSON for a single declarative route.
 */
export function buildCaddyRoute(r: CaddyRoute): Record<string, unknown> {
  const [host, portStr] = r.domain.split(":")
  const port = portStr ? Number(portStr) : (r.port ?? 80)

  return {
    "@id": "anteros-" + host + "-" + port,
    match: [{ host: [host] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: r.target + ":" + r.upstream_port }],
      },
    ],
    terminal: true,
  }
}

/**
 * Build the full server config: a single server `anteros` with all
 * the given routes. Listens on the union of (host, port) pairs.
 */
export function buildCaddyServerConfig(
  routes: CaddyRoute[],
): Record<string, unknown> {
  const listen: string[] = [":80"]
  for (const r of routes) {
    const [host, portStr] = r.domain.split(":")
    const port = portStr ? Number(portStr) : (r.port ?? 80)
    if (port === 443) continue // Caddy auto-handles :443
    if (port !== 80) {
      const addr = ":" + port
      if (!listen.includes(addr)) listen.push(addr)
    }
    void host
  }

  return {
    apps: {
      http: {
        servers: {
          anteros: {
            listen,
            routes: routes.map(buildCaddyRoute),
          },
        },
      },
    },
  }
}

/**
 * Apply the config: POST to `/config/apps/http/servers/`.
 * Replaces the entire `anteros` server in one call.
 */
export async function applyCaddyConfig(
  routes: CaddyRoute[],
): Promise<{ ok: boolean; status: number; body: string }> {
  const cfg = buildCaddyServerConfig(routes)
  const anteros = (cfg.apps as any).http.servers.anteros

  // GET current config to preserve any user-managed servers
  let current: any = {}
  try {
    const getRes = await fetch(caddyAdminUrl() + "/config/apps/http/servers/", {
      method: "GET",
    })
    if (getRes.ok) current = await getRes.json()
  } catch {
    // Caddy not reachable
  }

  const merged = { ...(current ?? {}), anteros }
  const allServers = { apps: { http: { servers: merged } } }

  const res = await fetch(caddyAdminUrl() + "/config/apps/http/servers/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(allServers),
  })
  const body = await res.text()
  return { ok: res.ok, status: res.status, body }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface RouteDiff {
  added: CaddyRoute[]
  removed: CaddyRoute[]
  modified: Array<{ from: CaddyRoute; to: CaddyRoute }>
  unchanged: CaddyRoute[]
}

/** Make a route identity key (domain+port). */
function routeKey(r: CaddyRoute): string {
  return r.domain + "|" + (r.port ?? 80) + "|" + r.upstream_port
}

/**
 * Compare two route sets and produce a structured diff.
 */
export function diffRoutes(
  before: CaddyRoute[],
  after: CaddyRoute[],
): RouteDiff {
  const beforeMap = new Map(before.map((r) => [routeKey(r), r]))
  const afterMap = new Map(after.map((r) => [routeKey(r), r]))

  const added: CaddyRoute[] = []
  const removed: CaddyRoute[] = []
  const modified: Array<{ from: CaddyRoute; to: CaddyRoute }> = []
  const unchanged: CaddyRoute[] = []

  for (const [k, a] of afterMap) {
    const b = beforeMap.get(k)
    if (!b) {
      added.push(a)
    } else if (!routesEqual(b, a)) {
      modified.push({ from: b, to: a })
    } else {
      unchanged.push(a)
    }
  }
  for (const [k, b] of beforeMap) {
    if (!afterMap.has(k)) removed.push(b)
  }
  return { added, removed, modified, unchanged }
}

function routesEqual(a: CaddyRoute, b: CaddyRoute): boolean {
  return (
    a.domain === b.domain &&
    a.target === b.target &&
    (a.port ?? 80) === (b.port ?? 80) &&
    a.upstream_port === b.upstream_port &&
    (a.tls ?? "auto") === (b.tls ?? "auto")
  )
}

/** Format a single route for diff display. */
export function fmtRoute(r: CaddyRoute): string {
  const tls = r.tls === false ? "no-tls" : "tls"
  return r.domain + " -> " + r.target + ":" + r.upstream_port + " (" + tls + ")"
}

/**
 * Pull the current `anteros` server's routes from a live Caddy.
 * Returns [] if the server doesn't exist yet.
 */
export async function fetchCurrentRoutes(): Promise<CaddyRoute[]> {
  try {
    const res = await fetch(caddyAdminUrl() + "/config/apps/http/servers/anteros", {
      method: "GET",
    })
    if (!res.ok) return []
    const data: any = await res.json()
    const routes: any[] = data?.routes ?? []
    return routes
      .map((r) => caddyRouteToConfig(r))
      .filter((r): r is CaddyRoute => r !== null)
  } catch {
    return []
  }
}

/** Convert a Caddy route JSON back to our CaddyRoute config. */
function caddyRouteToConfig(r: any): CaddyRoute | null {
  const host: string | undefined = r?.match?.[0]?.host?.[0]
  const dial: string | undefined = r?.handle?.[0]?.upstreams?.[0]?.dial
  if (!host || !dial) return null
  const [target, portStr] = dial.split(":")
  const upstream_port = portStr ? Number(portStr) : 80
  return {
    domain: host,
    target,
    upstream_port,
    tls: "auto",
  }
}
