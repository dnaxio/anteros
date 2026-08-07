// `ros deploy` — deploy pods to a target environment.

import type { Command, ServerTarget, PodConfig, ContainerConfig } from "../types.ts"
import { loadConfig, resolveServers, expandEnv } from "../config.ts"
import { sshExec, ssh } from "../ssh.ts"
import { runLocalBuild, runRemoteBuild, describeBuild } from "../build.ts"
import { pushArtifact, describeArtifact } from "../artifact.ts"
import { mergeResources, resourcesToDockerFlags, describeResources } from "../resources.ts"
import { appendHistory, DEFAULT_HISTORY_DIR, makeEntry } from "../history.ts"
import { sendWebhook, makeDeployEvent, makeDeployFailedEvent, normalizeWebhook } from "../webhook.ts"
import { resolveSecrets, mergeEnvWithSecrets } from "../secrets.ts"
import {
  header,
  success,
  warn,
  error,
  info,
  log,
  confirm,
  table,
} from "../ui.ts"

// Parse CLI flags for deploy options
interface DeployFlags {
  noHealthcheck: boolean
  healthcheckTimeout: number
}

function parseDeployFlags(args: string[]): { args: string[]; flags: DeployFlags } {
  const flags: DeployFlags = {
    noHealthcheck: false,
    healthcheckTimeout: 60,
  }
  const filtered: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--no-healthcheck") {
      flags.noHealthcheck = true
    } else if (arg === "--healthcheck-timeout" && i + 1 < args.length) {
      const nextArg = args[++i]
      if (nextArg) {
        flags.healthcheckTimeout = parseInt(nextArg, 10) || 60
      }
    } else if (arg) {
      filtered.push(arg)
    }
  }
  return { args: filtered, flags }
}

/**
 * Poll a healthcheck URL until it returns 2xx or timeout.
 * Returns true if healthy, false if timeout.
 */
async function waitForHealthy(
  server: ServerTarget,
  healthcheckUrl: string,
  timeoutSec: number,
  sshTimeout?: number,
): Promise<boolean> {
  const start = Date.now()
  const timeoutMs = timeoutSec * 1000
  const pollInterval = 3000 // 3 seconds

  while (Date.now() - start < timeoutMs) {
    try {
      const result = await ssh(
        server,
        `curl -sf -o /dev/null -w '%{http_code}' '${healthcheckUrl}' 2>/dev/null || echo "000"`,
        { timeout: sshTimeout },
      )
      const statusCode = result.stdout.trim()
      if (statusCode.startsWith("2")) {
        return true
      }
    } catch {
      // ignore errors, keep polling
    }
    await new Promise((r) => setTimeout(r, pollInterval))
  }
  return false
}

/**
 * Get the previous version from history for rollback.
 */
async function getPreviousVersion(
  server: ServerTarget,
  envName: string,
  podName: string,
  historyDir: string,
  sshTimeout?: number,
): Promise<string | null> {
  try {
    const result = await ssh(
      server,
      `cat ${historyDir}/${envName}/${podName}.json 2>/dev/null || echo "[]"`,
      { timeout: sshTimeout },
    )
    const history = JSON.parse(result.stdout)
    if (history.length >= 2) {
      return history[history.length - 2]
    }
  } catch {
    // ignore
  }
  return null
}

function buildImageRef(p: PodConfig): string {
  const c0 = p.containers[0]
  if (!c0?.image) return "(no image)"
  const tag = c0.tag ?? "latest"
  return c0.image + ":" + tag
}

interface PlanRow {
  env: string
  pod: string
  container: string
  image: string
  inst: number
  server: string
  artifact: string
  build: string
  resources: string
}

export const deploy: Command = async ({ args, opts }) => {
  // Parse deploy-specific flags
  const { args: cleanArgs, flags: deployFlags } = parseDeployFlags(args)

  const cfg = await loadConfig(opts.config)
  const envName = opts.env ?? cleanArgs[0] ?? "production"
  const env = cfg.environments[envName]
  if (!env) {
    error("Unknown environment: " + envName + ". Available: " + Object.keys(cfg.environments).join(", "))
    process.exit(1)
  }

  const servers = resolveServers(env, opts.server)
  const podFilter = cleanArgs.find((a) => a !== envName)
  const pods = podFilter
    ? Object.values(cfg.pods).filter((_, i) => Object.keys(cfg.pods)[i] === podFilter)
    : Object.values(cfg.pods)

  if (pods.length === 0) {
    warn("No pods to deploy.")
    return
  }

  // ---------------------------------------------------------------------
  // Build plan
  // ---------------------------------------------------------------------
  const podNameCache = new WeakMap<PodConfig, string>()
  const nameOf = (pod: PodConfig) => {
    let n = podNameCache.get(pod)
    if (n === undefined) {
      n = Object.keys(cfg.pods).find((k) => cfg.pods[k] === pod) ?? "?"
      podNameCache.set(pod, n)
    }
    return n
  }

  const rows: PlanRow[] = []
  for (const s of servers) {
    for (const pod of pods) {
      const c0 = pod.containers[0]!
      const merged = mergeResources(pod.resources, c0.resources)
      rows.push({
        env: envName,
        pod: nameOf(pod),
        container: c0.name,
        image: buildImageRef(pod),
        inst: pod.instances,
        server: s.raw,
        artifact: describeArtifact(pod.artifact ?? c0.artifact),
        build: describeBuild(pod.build),
        resources: describeResources(merged),
      })
    }
  }

  header("Deploy plan: " + envName)
  table(
    ["POD", "CONTAINER", "BUILD", "IMAGE", "INST", "RES", "SERVER", "ARTIFACT"],
    rows.map((r) => [r.pod, r.container, r.build, r.image, String(r.inst), r.resources, r.server, r.artifact]),
  )

  if (opts.dryRun) {
    info("Dry run - nothing applied.")
    return
  }

  const ok = await confirm(
    "Deploy " + pods.length + " pod(s) to " + servers.length + " server(s)?",
    opts.force,
  )
  if (!ok) {
    warn("Aborted.")
    return
  }

  // ---------------------------------------------------------------------
  // Execute
  // ---------------------------------------------------------------------
  const deployStart = Date.now()
  for (const pod of pods) {
    const c0 = pod.containers[0]!
    const image = expandEnv(buildImageRef(pod))
    const podName = Object.keys(cfg.pods).find((k) => cfg.pods[k] === pod) ?? c0.name
    log("Deploying " + podName + " (" + image + ") to " + servers.length + " server(s)…")

    // 1) Local build steps (run on the machine where `ros` is invoked)
    try {
      await runLocalBuild(podName, pod.build, process.cwd(), opts.dryRun)
    } catch (e) {
      error("Local build failed for " + podName + ": " + (e as Error).message)
      if (!opts.force) return
    }

    // 2) Per-server work, in parallel
    await Promise.all(
      servers.map(async (server) => {
        try {
          // 2a) Remote build steps (run on the server BEFORE sync)
          try {
            await runRemoteBuild(podName, pod.build, [server], cfg.ssh?.timeout, opts.dryRun)
          } catch (e) {
            error("  [" + server.raw + "] remote build failed: " + (e as Error).message)
            if (!opts.force) return
          }

          // 2b) artifact (folder | file | git)
          const artifact = pod.artifact ?? c0.artifact
          if (artifact) {
            const dest = artifact.destination ?? installDir(cfg) + "/" + c0.name + "/"
            const resolved: typeof artifact = { ...artifact, destination: dest }
            await pushArtifact(server, resolved, process.cwd(), cfg.ssh?.timeout, opts.dryRun)
          }

          // 2c) ensure install dir exists
          await sshExec(
            server,
            "mkdir -p " + installDir(cfg) + "/" + c0.name,
            { timeout: cfg.ssh?.timeout },
          )

          // 2d) Resolve secrets from env_from (client-side)
          const secrets = await resolveSecrets(c0.env_from)
          const mergedEnv = mergeEnvWithSecrets(c0.env, secrets)

          // 2e) pull + run
          const portArgs = (c0.ports ?? []).map((p) => "-p " + p + " ").join("")
          const envArgs = Object.keys(mergedEnv).length > 0
            ? Object.entries(mergedEnv)
                .map(([k, v]) => "-e " + k + "=" + JSON.stringify(String(v)))
                .join(" ")
            : ""
          const resourceArgs = resourcesToDockerFlags(
            mergeResources(pod.resources, c0.resources),
          ).join(" ")
          await sshExec(
            server,
            "docker pull " + image + " && " +
              "docker stop " + c0.name + " 2>/dev/null || true && " +
              "docker rm " + c0.name + " 2>/dev/null || true && " +
              "docker run -d --name " + c0.name + " " +
              "--restart " + (c0.restart ?? "unless-stopped") + " " +
              portArgs + envArgs + resourceArgs + " " + image,
            { timeout: cfg.ssh?.timeout },
          )

          // 2f) Health check (unless disabled)
          if (!deployFlags.noHealthcheck && c0.healthcheck) {
            const healthUrl = expandEnv(c0.healthcheck)
            log("  " + server.raw + " → health check: " + healthUrl)
            const healthy = await waitForHealthy(
              server,
              healthUrl,
              deployFlags.healthcheckTimeout,
              cfg.ssh?.timeout,
            )
            if (!healthy) {
              error("  " + server.raw + " ✖ health check failed after " + deployFlags.healthcheckTimeout + "s")
              // Auto-rollback: try to restore previous version
              const prevVersion = await getPreviousVersion(
                server,
                envName,
                podName,
                cfg.settings?.history_dir ?? DEFAULT_HISTORY_DIR,
                cfg.ssh?.timeout,
              )
              if (prevVersion) {
                warn("  " + server.raw + " → rolling back to " + prevVersion)
                try {
                  await sshExec(
                    server,
                    "docker stop " + c0.name + " 2>/dev/null || true && " +
                      "docker rm " + c0.name + " 2>/dev/null || true && " +
                      "docker run -d --name " + c0.name + " " +
                      "--restart " + (c0.restart ?? "unless-stopped") + " " +
                      portArgs + envArgs + resourceArgs + " " + prevVersion,
                    { timeout: cfg.ssh?.timeout },
                  )
                  success("  " + server.raw + " → rollback complete")
                } catch (rollbackErr) {
                  error("  " + server.raw + " ✖ rollback failed: " + (rollbackErr as Error).message)
                }
              } else {
                warn("  " + server.raw + " → no previous version to rollback to")
              }
              throw new Error("Health check failed")
            }
          }
          success("  " + server.raw + " ✓")

          // 2g) record deploy in history (so `ros rollback` can find the previous tag)
          const c0Tag = c0.tag ?? "latest"
          const historyDir = cfg.settings?.history_dir ?? DEFAULT_HISTORY_DIR
          try {
            await appendHistory(
              server,
              envName,
              podName,
              makeEntry(c0.image ?? "", c0Tag),
              historyDir,
            )
          } catch (e) {
            warn("  [" + server.raw + "] could not write history: " + (e as Error).message)
          }
        } catch (e) {
          error("  " + server.raw + " ✖ " + (e as Error).message)
        }
      }),
    )

    // 3) Webhook notification (best-effort, non-blocking)
    const duration = Math.round((Date.now() - deployStart) / 1000)
    const c0Tag = c0.tag ?? "latest"
    const serverNames = resolveServers(env, opts.server).map((s) => s.raw)
    const event = makeDeployEvent(
      podName,
      envName,
      c0Tag,
      serverNames,
      duration,
    )
    const wh = await sendWebhook(
      normalizeWebhook(cfg.settings?.audit?.url, cfg.settings?.audit?.events),
      event,
    )
    if (!wh.ok && wh.error) {
      warn("  webhook failed: " + wh.error)
    } else if (wh.skipped) {
      // silent: not configured or filtered
    } else if (wh.ok) {
      info("  webhook ✓ (status " + wh.status + ")")
    }
  }
}

function installDir(cfg: { settings?: { install_dir?: string } }): string {
  return cfg.settings?.install_dir ?? "/opt/anteros"
}
