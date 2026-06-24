// `ros logs <service>` — tail logs from a service.

import type { Command } from "../types.ts"
import { loadConfig, resolveServers } from "../config.ts"
import { ssh } from "../ssh.ts"
import { error } from "../ui.ts"

export const logs: Command = async ({ args, opts }) => {
  const service = args[0]
  if (!service) {
    error("Usage: ros logs <service> [--env <name>] [--tail N] [--since 10m]")
    process.exit(1)
  }

  const cfg = await loadConfig(opts.config)
  const envName = opts.env ?? Object.keys(cfg.environments)[0]!
  const env = cfg.environments[envName]
  if (!env) {
    error(`Unknown environment: ${envName}`)
    process.exit(1)
  }
  const servers = resolveServers(env, opts.server)

  const tailIdx = args.indexOf("--tail")
  const tail = tailIdx >= 0 ? args[tailIdx + 1] ?? "100" : "100"

  const sinceIdx = args.indexOf("--since")
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined

  for (const server of servers) {
    const cmd = [
      "docker",
      "logs",
      "--tail",
      tail,
      ...(since ? ["--since", since] : []),
      "-f",
      service,
    ]
    const r = await ssh(server, cmd, { timeout: 0 })
    if (r.exitCode !== 0 && opts.verbose) {
      console.error(`[${server.raw}] ${r.stderr}`)
    }
  }
}
