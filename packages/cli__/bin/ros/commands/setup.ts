// `ros setup` — install server-side dependencies.

import type { Command } from "../types.ts"
import { loadConfig, resolveServers, expandEnv } from "../config.ts"
import { sshExec } from "../ssh.ts"
import { header, info, success, warn, log, confirm } from "../ui.ts"

const DEPS = ["docker", "caddy", "flox", "git", "unzip", "bun"] as const
type Dep = (typeof DEPS)[number]

const INSTALL: Record<Dep, string> = {
  docker: "curl -fsSL https://get.docker.com | sh",
  caddy: "apt install -y debian-keyring debian-archive-keyring && apt install -y caddy",
  flox: "curl -fsSL https://download.flox.dev/install | sh",
  git: "apt install -y git",
  unzip: "apt install -y unzip",
  bun: "curl -fsSL https://bun.sh/install | bash",
}

const CHECK: Record<Dep, string> = {
  docker: "command -v docker",
  caddy: "command -v caddy",
  flox: "command -v flox",
  git: "command -v git",
  unzip: "command -v unzip",
  bun: "command -v bun",
}

export const setup: Command = async ({ args, opts }) => {
  const cfg = await loadConfig(opts.config)
  const envName = opts.env ?? args[0] ?? Object.keys(cfg.environments)[0]
  const env = envName ? cfg.environments[envName] : undefined

  // If no env, use direct server args
  const direct = opts.server ?? []
  const targets = env ? resolveServers(env, opts.server) : []

  if (targets.length === 0 && direct.length === 0) {
    warn("No targets. Use --env <name> or --server root@ip.")
    return
  }

  const only = args
    .filter((a) => a !== envName)
    .filter((a) => (DEPS as readonly string[]).includes(a)) as Dep[]
  const deps = only.length > 0 ? only : [...DEPS]

  header(`Setup on ${targets.length || direct.length} server(s)`)
  info(`Will install: ${deps.join(", ")}`)

  if (opts.dryRun) {
    info("Dry run — nothing applied.")
    return
  }

  const ok = await confirm("Proceed?", opts.force)
  if (!ok) {
    warn("Aborted.")
    return
  }

  for (const server of targets.length > 0 ? targets : direct.map((s) => ({ raw: expandEnv(s), user: "root", host: expandEnv(s), port: 22 }))) {
    log(`→ ${server.raw}`)
    for (const dep of deps) {
      try {
        const check = await sshExec(server, CHECK[dep], { timeout: 10 })
        if (check.trim().length > 0 && !opts.force) {
          log(`  ${dep} already present, skipping (use --force to reinstall)`)
          continue
        }
      } catch {
        // not installed
      }
      log(`  installing ${dep}…`)
      try {
        await sshExec(server, INSTALL[dep], { timeout: 300 })
        success(`  ${dep} ✓`)
      } catch (e) {
        warn(`  ${dep} ✖ ${(e as Error).message}`)
      }
    }
  }
}
