// `ros history [pod]` — show the deployment history.

import type { Command } from "../types.ts"
import { loadConfig, resolveServers } from "../config.ts"
import { DEFAULT_HISTORY_DIR, readHistory } from "../history.ts"
import { header, table, info, warn, error } from "../ui.ts"

export const history: Command = async ({ args, opts }) => {
  const cfg = await loadConfig(opts.config)
  const envName = opts.env ?? Object.keys(cfg.environments)[0]!
  const env = cfg.environments[envName]
  if (!env) {
    error("Unknown environment: " + envName)
    process.exit(1)
  }
  const servers = resolveServers(env, opts.server)
  const historyDir = cfg.settings?.history_dir ?? DEFAULT_HISTORY_DIR

  const pod = args[0]

  // If a pod is given, show its history
  if (pod) {
    if (!cfg.pods[pod]) {
      error("Unknown pod: " + pod)
      process.exit(1)
    }
    header("History: " + pod + " (" + envName + ")")
    info("Path: " + historyDir + "/" + envName + "/" + pod + ".json")
    info("Source: " + servers[0]?.raw ?? "(no server)")

    let h = []
    for (const server of servers) {
      try {
        h = await readHistory(server, envName, pod, historyDir)
        break
      } catch {
        // try next
      }
    }
    if (h.length === 0) {
      warn("No deploys recorded yet. Run `ros deploy` to start tracking.")
      return
    }
    const rows = h.map((e, i) => [
      String(i + 1),
      e.tag,
      e.image ?? "—",
      e.deployed_at,
      e.deployer ?? "—",
    ])
    table(["#", "TAG", "IMAGE", "DEPLOYED AT", "DEPLOYER"], rows)
    return
  }

  // No pod: show summary of all pods
  header("Deploy history (" + envName + ")")
  info("Path on servers: " + historyDir + "/" + envName + "/<pod>.json")
  info("Server: " + servers[0]?.raw ?? "(no server)")

  const podNames = Object.keys(cfg.pods)
  const summaries: Array<[string, string, string, string]> = []
  for (const p of podNames) {
    let h = []
    for (const server of servers) {
      try {
        h = await readHistory(server, envName, p, historyDir)
        break
      } catch {
        // try next
      }
    }
    if (h.length === 0) {
      summaries.push([p, "—", "—", "—"])
      continue
    }
    const last = h[h.length - 1]!
    summaries.push([p, last.tag, last.deployed_at, String(h.length)])
  }
  table(["POD", "LATEST TAG", "LATEST DEPLOY", "TOTAL"], summaries)
}
