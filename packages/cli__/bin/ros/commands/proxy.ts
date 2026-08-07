// `ros proxy` — manage the Caddy reverse proxy via the Admin API.

import type { Command, CaddyRoute, ServerTarget } from "../types.ts"
import { loadConfig, resolveServers } from "../config.ts"
import {
  buildCaddyServerConfig,
  diffRoutes,
  fetchCurrentRoutes,
  fmtRoute,
} from "../caddy.ts"
import { sshExec } from "../ssh.ts"
import { header, info, success, warn, error, log, confirm, c } from "../ui.ts"

/** Run a curl on the remote Caddy admin API via SSH. */
async function caddyRemote(
  server: ServerTarget,
  method: string,
  path: string,
  body?: string,
): Promise<{ ok: boolean; status: number; data: string }> {
  const args = [
    "curl",
    "-sS",
    "-w",
    "\\n%{http_code}",
    "-X",
    method,
    "http://localhost:2019" + path,
  ]
  if (body !== undefined) {
    args.push("-H", "Content-Type: application/json")
    args.push("--data-binary", "@-")
  }
  const cmd = args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")
  const proc = Bun.spawn(
    [
      "ssh",
      "-p",
      String(server.port),
      "-o",
      "BatchMode=yes",
      server.raw,
      cmd,
    ],
    {
      stdin: body !== undefined ? "pipe" : undefined,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (body !== undefined && proc.stdin) {
    const writer = proc.stdin as unknown as { write: (s: string) => void; end: () => void }
    writer.write(body)
    writer.end()
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  if (code !== 0) {
    return { ok: false, status: 0, data: stderr.trim() }
  }
  const lines = stdout.trimEnd().split("\n")
  const statusStr = lines.pop() ?? "0"
  const status = Number(statusStr)
  const data = lines.join("\n")
  return { ok: status >= 200 && status < 300, status, data }
}

async function checkReachable(server: ServerTarget): Promise<boolean> {
  const r = await caddyRemote(server, "GET", "/config/")
  return r.ok
}

async function fetchRoutesRemote(server: ServerTarget): Promise<CaddyRoute[]> {
  // We can't use the Caddy API directly from the CLI machine;
  // we shell out to the server and use our own converter.
  const r = await caddyRemote(
    server,
    "GET",
    "/config/apps/http/servers/anteros",
  )
  if (!r.ok || !r.data) return []
  try {
    const data = JSON.parse(r.data)
    const routes: any[] = data?.routes ?? []
    return routes
      .map((x: any) => caddyRouteToConfig(x))
      .filter((x: CaddyRoute | null): x is CaddyRoute => x !== null)
  } catch {
    return []
  }
}

function caddyRouteToConfig(r: any): CaddyRoute | null {
  const host: string | undefined = r?.match?.[0]?.host?.[0]
  const dial: string | undefined = r?.handle?.[0]?.upstreams?.[0]?.dial
  if (!host || !dial) return null
  const [target, portStr] = dial.split(":")
  const upstream_port = portStr ? Number(portStr) : 80
  return { domain: host, target, upstream_port, tls: "auto" }
}

async function applyRoutes(
  server: ServerTarget,
  routes: CaddyRoute[],
): Promise<{ ok: boolean; status: number; data: string }> {
  const existing = await caddyRemote(server, "GET", "/config/apps/http/servers/")
  let userServers: Record<string, unknown> = {}
  if (existing.ok && existing.data) {
    try {
      userServers = JSON.parse(existing.data)
    } catch {
      // empty
    }
  }
  const anteros = buildCaddyServerConfig(routes).apps.http.servers.anteros
  const merged = { ...userServers, anteros }
  return caddyRemote(
    server,
    "POST",
    "/config/apps/http/servers/",
    JSON.stringify(merged),
  )
}

async function removeAnteros(
  server: ServerTarget,
): Promise<{ ok: boolean; status: number; data: string }> {
  return caddyRemote(server, "DELETE", "/config/apps/http/servers/anteros")
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function applySubcommand(
  args: string[],
  opts: { env?: string; server?: string[]; dryRun?: boolean; force?: boolean },
) {
  const cfg = await loadConfig(opts.config)
  const routes = cfg.proxy?.routes ?? []
  if (routes.length === 0) {
    warn("No routes configured in deploy.yaml (proxy.routes)")
    return
  }

  const envName = opts.env ?? args[1] ?? Object.keys(cfg.environments)[0]
  if (!envName) {
    error("No environment specified")
    process.exit(1)
  }
  const env = cfg.environments[envName]
  if (!env) {
    error(`Unknown environment: ${envName}`)
    process.exit(1)
  }
  const servers = resolveServers(env, opts.server)

  header(`Applying ${routes.length} route(s) to Caddy (env: ${envName})`)

  if (opts.dryRun) {
    info("Dry run - nothing applied.")
    const server = buildCaddyServerConfig(routes)
    console.log(c.cyan(JSON.stringify(server, null, 2)))
    return
  }

  for (const server of servers) {
    log("-> " + server.raw)
    const reachable = await checkReachable(server)
    if (!reachable) {
      error("  ✖ Caddy admin API not reachable on :2019")
      warn("     hint: ssh " + server.raw + " 'systemctl status caddy'")
      continue
    }
    const r = await applyRoutes(server, routes)
    if (r.ok) success("  ✓ " + routes.length + " route(s) applied (status " + r.status + ")")
    else error("  ✖ failed (status " + r.status + "): " + r.data.slice(0, 200))
  }
}

async function showSubcommand(opts: { config: string }) {
  const cfg = await loadConfig(opts.config)
  const server = buildCaddyServerConfig(cfg.proxy?.routes ?? [])
  header("Proxy config (would be applied)")
  console.log(c.cyan(JSON.stringify(server, null, 2)))
}

async function diffSubcommand(
  args: string[],
  opts: { env?: string; server?: string[]; dryRun?: boolean; force?: boolean },
) {
  const cfg = await loadConfig(opts.config)
  const desired = cfg.proxy?.routes ?? []

  const envName = opts.env ?? args[1] ?? Object.keys(cfg.environments)[0]
  if (!envName) {
    error("No environment specified")
    process.exit(1)
  }
  const env = cfg.environments[envName]
  if (!env) {
    error(`Unknown environment: ${envName}`)
    process.exit(1)
  }
  const servers = resolveServers(env, opts.server)

  for (const server of servers) {
    log("-> " + server.raw)
    const reachable = await checkReachable(server)
    if (!reachable) {
      error("  ✖ Caddy admin API not reachable on :2019")
      continue
    }
    const current = await fetchRoutesRemote(server)
    const d = diffRoutes(current, desired)

    header("Diff for " + server.raw)
    if (d.added.length === 0 && d.removed.length === 0 && d.modified.length === 0) {
      info(c.green("✓ no changes"))
      continue
    }

    for (const r of d.added) {
      console.log(c.green("  + " + fmtRoute(r)))
    }
    for (const r of d.removed) {
      console.log(c.red("  - " + fmtRoute(r)))
    }
    for (const m of d.modified) {
      console.log(c.yellow("  ~ " + fmtRoute(m.from)))
      console.log(c.yellow("      -> " + fmtRoute(m.to)))
    }
    for (const r of d.unchanged) {
      console.log(c.gray("  = " + fmtRoute(r)))
    }
  }
}

async function removeSubcommand(
  args: string[],
  opts: { env?: string; server?: string[]; dryRun?: boolean; force?: boolean },
) {
  if (!opts.force) {
    const ok = await confirm("Remove the 'anteros' server from Caddy?", false)
    if (!ok) {
      warn("Aborted.")
      return
    }
  }
  const cfg = await loadConfig(opts.config)
  const envName = opts.env ?? args[1] ?? Object.keys(cfg.environments)[0]
  if (!envName) return
  const env = cfg.environments[envName]
  if (!env) return
  const servers = resolveServers(env, opts.server)
  header("Removing 'anteros' from Caddy")
  for (const server of servers) {
    log("-> " + server.raw)
    if (opts.dryRun) {
      info("  [dry-run] would DELETE /config/apps/http/servers/anteros")
      continue
    }
    const r = await removeAnteros(server)
    if (r.ok) success("  ✓ removed (status " + r.status + ")")
    else error("  ✖ failed (status " + r.status + ")")
  }
}

async function watchSubcommand(
  args: string[],
  opts: { env?: string; server?: string[]; force?: boolean },
) {
  const cfg = await loadConfig(opts.config)
  const desired = cfg.proxy?.routes ?? []
  const envName = opts.env ?? args[1] ?? Object.keys(cfg.environments)[0]
  if (!envName) {
    error("No environment specified")
    process.exit(1)
  }
  const env = cfg.environments[envName]
  if (!env) {
    error(`Unknown environment: ${envName}`)
    process.exit(1)
  }
  const servers = resolveServers(env, opts.server)

  header("Watching " + desired.length + " route(s) on " + servers.length + " server(s)")
  info("Polling every 5s. Press Ctrl+C to stop.")

  const interval = 5_000
  let lastHash = ""
  while (true) {
    let allCurrent: CaddyRoute[] = []
    let allReachable = true
    for (const server of servers) {
      if (!(await checkReachable(server))) {
        allReachable = false
        break
      }
      allCurrent = allCurrent.concat(await fetchRoutesRemote(server))
    }
    if (!allReachable) {
      warn("  Caddy unreachable, retrying in " + interval / 1000 + "s…")
      await new Promise((r) => setTimeout(r, interval))
      continue
    }
    const d = diffRoutes(allCurrent, desired)
    const hash = JSON.stringify(d)
    if (hash !== lastHash) {
      lastHash = hash
      console.log()
      log("[" + new Date().toISOString() + "] drift detected:")
      for (const r of d.added) console.log(c.green("  + " + fmtRoute(r)))
      for (const r of d.removed) console.log(c.red("  - " + fmtRoute(r)))
      for (const m of d.modified) {
        console.log(c.yellow("  ~ " + fmtRoute(m.from)))
        console.log(c.yellow("      -> " + fmtRoute(m.to)))
      }
      info("Run `ros proxy apply` to reconcile.")
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const proxy: Command = async ({ args, opts }) => {
  const sub = args[0] ?? "apply"
  switch (sub) {
    case "apply":
      return applySubcommand(args, opts)
    case "show":
      return showSubcommand(opts)
    case "diff":
      return diffSubcommand(args, opts)
    case "remove":
      return removeSubcommand(args, opts)
    case "watch":
      return watchSubcommand(args, opts)
    default:
      error(`Unknown subcommand: ros proxy ${sub}`)
      info("Available: apply [env], show, diff [env], watch [env], remove [env]")
      process.exit(1)
  }
}

// re-export for convenience
export { checkReachable, applyRoutes, fetchRoutesRemote, diffRoutes }
void sshExec // keep import for potential future use
void fetchCurrentRoutes
