// `ros rollback <pod>` — roll back to a previous image tag.
//
// Without `--to`, reads the deploy history (recorded by `ros deploy`)
// and rolls back to the previous tag. With `--to <tag>`, deploys that
// specific tag explicitly.

import type { Command } from "../types.ts"
import { loadConfig, resolveServers, expandEnv } from "../config.ts"
import { sshExec } from "../ssh.ts"
import { DEFAULT_HISTORY_DIR, readHistory, previousTag, currentTag } from "../history.ts"
import { sendWebhook, makeRollbackEvent, normalizeWebhook } from "../webhook.ts"
import { header, info, success, warn, error, log, confirm } from "../ui.ts"

export const rollback: Command = async ({ args, opts }) => {
  const pod = args[0]
  if (!pod) {
    error("Usage: ros rollback <pod> [--to <tag>] [--env <name>]")
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

  const toIdx = args.indexOf("--to")
  const toTag = toIdx >= 0 ? args[toIdx + 1] : undefined

  const podCfg = cfg.pods[pod]
  if (!podCfg) {
    error("Unknown pod: " + pod)
    process.exit(1)
  }
  const container = podCfg.containers[0]!
  const image = container.image ?? ""
  if (!image) {
    error("Pod " + pod + " has no image defined")
    process.exit(1)
  }

  const historyDir = cfg.settings?.history_dir ?? DEFAULT_HISTORY_DIR

  // Resolve target tag: explicit (--to), or previous from history
  let targetTag: string
  if (toTag) {
    targetTag = toTag
  } else {
    // Read history from the first reachable server
    let history = []
    let usedServer = servers[0]
    for (const server of servers) {
      try {
        history = await readHistory(server, envName, pod, historyDir)
        usedServer = server
        break
      } catch {
        // try next server
      }
    }
    if (!usedServer) {
      error("No server reachable to read history. Use --to <tag> explicitly.")
      process.exit(1)
    }
    const prev = previousTag(history)
    const curr = currentTag(history)
    if (!prev) {
      error("No previous version found in history. Use --to <tag> explicitly.")
      process.exit(1)
    }
    targetTag = prev.tag
    info("History on " + usedServer.raw + " (" + historyDir + "/" + envName + "/" + pod + ".json):")
    info("  current:  " + (curr?.tag ?? "—") + " (" + (curr?.deployed_at ?? "—") + ")")
    info("  previous: " + prev.tag + " (" + prev.deployed_at + ")")
  }

  const currentTagVal = container.tag ?? "latest"
  if (targetTag === currentTagVal) {
    warn("Target tag equals the tag in deploy.yaml. The YAML will need to be updated too.")
  }

  header("Rollback: " + pod)
  info("Image:      " + image)
  info("Current:    " + currentTagVal)
  info("Rollback to: " + targetTag)

  if (opts.dryRun) {
    info("Dry run - nothing applied.")
    return
  }

  const startTime = Date.now()
  const ok = await confirm("Proceed with rollback?", opts.force)
  if (!ok) {
    warn("Aborted.")
    return
  }

  for (const server of servers) {
    log("-> " + server.raw)
    try {
      const ref = expandEnv(image + ":" + targetTag)
      await sshExec(
        server,
        "docker pull " + ref + " && " +
          "docker stop " + container.name + " 2>/dev/null || true && " +
          "docker rm " + container.name + " 2>/dev/null || true && " +
          "docker run -d --name " + container.name + " " + ref,
        { timeout: cfg.ssh?.timeout },
      )
      success("  ✓ rolled back to " + targetTag)

      // Record the rollback in history
      try {
        const { appendHistory, makeEntry } = await import("../history.ts")
        await appendHistory(
          server,
          envName,
          pod,
          makeEntry(image, targetTag, "rollback"),
          historyDir,
        )
      } catch {
        // best-effort
      }
    } catch (e) {
      warn("  ✖ " + (e as Error).message)
    }
  }

  // Webhook notification (best-effort, non-blocking)
  const duration = Math.round((Date.now() - startTime) / 1000)
  const event = makeRollbackEvent(
    pod,
    envName,
    currentTagVal,
    targetTag,
    servers.map((s) => s.raw),
    duration,
  )
  const wh = await sendWebhook(
    normalizeWebhook(cfg.settings?.audit?.url, cfg.settings?.audit?.events),
    event,
  )
  if (!wh.ok && wh.error) {
    warn("webhook failed: " + wh.error)
  } else if (wh.ok && !wh.skipped) {
    info("webhook ✓ (status " + wh.status + ")")
  }
}
