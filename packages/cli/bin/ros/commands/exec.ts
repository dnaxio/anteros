// `ros exec <pod|server> <cmd…>` — run a command on a remote server or inside a container.

import type { Command } from "../types.ts"
import { loadConfig, resolveServers } from "../config.ts"
import { ssh } from "../ssh.ts"
import { error } from "../ui.ts"

export const exec: Command = async ({ args, opts }) => {
  const target = args[0]
  if (!target) {
    error("Usage: ros exec <pod|server> <cmd…> [--env <name>]")
    process.exit(1)
  }
  const cmdArgs = args.slice(1)
  if (cmdArgs.length === 0) {
    error("Missing command to execute")
    process.exit(1)
  }

  const cfg = await loadConfig(opts.config)
  const envName = opts.env ?? Object.keys(cfg.environments)[0]!
  const env = cfg.environments[envName]
  if (!env) {
    error("Unknown environment: " + envName)
    process.exit(1)
  }

  // If target is a pod name, run inside its container; otherwise treat as server.
  const pod = cfg.pods[target]
  const servers = resolveServers(env, opts.server)
  const targets = pod
    ? servers.map((s) => ({ server: s, container: pod.containers[0]!.name }))
    : servers.map((s) => ({ server: s }))

  for (const t of targets) {
    const cmd = t.container
      ? ["docker", "exec", "-i", t.container, ...cmdArgs]
      : cmdArgs
    const r = await ssh(t.server, cmd, { timeout: 0 })
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
  }
}
