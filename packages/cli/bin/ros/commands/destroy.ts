// `ros destroy <pod>` — remove a pod and its resources.

import type { Command } from "../types.ts"
import { loadConfig, resolveServers } from "../config.ts"
import { sshExec } from "../ssh.ts"
import { header, info, success, warn, error, log, confirm } from "../ui.ts"

export const destroy: Command = async ({ args, opts }) => {
  const pod = args[0]
  if (!pod) {
    error("Usage: ros destroy <pod> [--env <name>]")
    process.exit(1)
  }

  const cfg = await loadConfig(opts.config)
  const envName = opts.env ?? Object.keys(cfg.environments)[0]!
  const env = cfg.environments[envName]
  if (!env) {
    error("Unknown environment: " + envName)
    process.exit(1)
  }
  const servers = resolveServers(env, opts.server)

  const podCfg = cfg.pods[pod]
  if (!podCfg) {
    error("Unknown pod: " + pod)
    process.exit(1)
  }
  const container = podCfg.containers[0]!

  header("Destroy: " + pod + " on " + envName)
  for (const s of servers) info("  - " + s.raw)

  if (opts.dryRun) {
    info("Dry run - nothing applied.")
    return
  }

  const ok = await confirm("Destroy " + pod + "? This cannot be undone.", opts.force)
  if (!ok) {
    warn("Aborted.")
    return
  }

  for (const server of servers) {
    log("-> " + server.raw)
    try {
      await sshExec(
        server,
        "docker stop " + container.name + " 2>/dev/null; docker rm -f " + container.name + " 2>/dev/null; true",
        { timeout: cfg.ssh?.timeout },
      )
      success("  ✓ removed")
    } catch (e) {
      warn("  ✖ " + (e as Error).message)
    }
  }
}
