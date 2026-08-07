// `ros env` — show resolved environment variables.

import type { Command } from "../types.ts"
import { loadConfig, expandEnv } from "../config.ts"
import { header, kvTable, info } from "../ui.ts"

export const env: Command = async ({ args, opts }) => {
  const cfg = await loadConfig(opts.config)
  const envName = opts.env ?? args[0]
  const podName = args.find((a) => a !== envName && cfg.pods[a])

  if (envName) {
    const env = cfg.environments[envName]
    if (!env) {
      info("Unknown environment: " + envName)
      return
    }
    header("Env: " + envName)
    kvTable([["Servers", env.servers.map((s) => s.raw).join("\n")]])
    return
  }

  if (podName) {
    const pod = cfg.pods[podName]!
    header("Env: pod " + podName)
    const c0 = pod.containers[0]!
    const rows: Array<[string, string]> = []
    for (const [k, v] of Object.entries(c0.env ?? {})) {
      rows.push([k, expandEnv(String(v))])
    }
    kvTable(rows.length > 0 ? rows : [["", "(no env vars)"]])
    return
  }

  header("Project")
  kvTable([
    ["Name", cfg.name],
    ["Version", cfg.version],
    ["Tag", cfg.deploy?.tag ?? "(none)"],
    ["Strategy", cfg.deploy?.strategy ?? "(none)"],
  ])
}
