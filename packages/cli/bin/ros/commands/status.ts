// `ros status` — show the status of deployed pods.

import type { Command } from "../types.ts"
import { loadConfig, resolveServers } from "../config.ts"
import { sshExec } from "../ssh.ts"
import { header, table, warn, error, c } from "../ui.ts"

interface PodStatus {
  pod: string
  container: string
  server: string
  state: string
  image: string
  started: string
}

export const status: Command = async ({ args, opts }) => {
  const cfg = await loadConfig(opts.config)
  const envName = opts.env ?? args[0] ?? Object.keys(cfg.environments)[0]
  if (!envName) {
    error("No environment specified and none found in config.")
    process.exit(1)
  }
  const env = cfg.environments[envName]
  if (!env) {
    error("Unknown environment: " + envName)
    process.exit(1)
  }
  const servers = resolveServers(env, opts.server)
  const podFilter = args.find((a) => a !== envName)

  const pods = podFilter
    ? Object.entries(cfg.pods).filter(([k]) => k === podFilter)
    : Object.entries(cfg.pods)

  if (pods.length === 0) {
    warn("No matching pods.")
    return
  }

  header("Status: " + envName)

  const results: PodStatus[] = []
  await Promise.all(
    servers.map(async (server) => {
      for (const [podName, pod] of pods) {
        const c0 = pod.containers[0]!
        try {
          const out = await sshExec(
            server,
            "docker inspect --format '{{.State.Status}}|{{.Config.Image}}|{{.State.StartedAt}}' " +
              c0.name + " 2>/dev/null || echo \"missing|missing|missing\"",
            { timeout: 10 },
          )
          const [state, image, startedAt] = out.trim().split("|")
          const started = startedAt && startedAt !== "missing" ? startedAt : "—"
          results.push({
            pod: podName,
            container: c0.name,
            server: server.raw,
            state: state ?? "unknown",
            image: image ?? "?",
            started: stateColor(state, started),
          })
        } catch (e) {
          results.push({
            pod: podName,
            container: c0.name,
            server: server.raw,
            state: "error",
            image: "?",
            started: (e as Error).message,
          })
        }
      }
    }),
  )

  const rows = results.map((r) => [r.pod, r.container, r.server, r.state, r.image, r.started])
  table(["POD", "CONTAINER", "SERVER", "STATE", "IMAGE", "STARTED"], rows)
}

function stateColor(state: string | undefined, text: string): string {
  if (!state) return text
  if (state === "running") return c.green(text)
  if (state === "exited" || state === "dead") return c.red(text)
  if (state === "missing") return c.gray(text)
  if (state === "error") return c.yellow(text)
  return text
}
