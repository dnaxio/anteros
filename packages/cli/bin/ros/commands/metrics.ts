// `ros metrics` — install / manage the metrics scraper on remote servers.

import type { Command } from "../types.ts"
import { loadConfig, resolveServers } from "../config.ts"
import { sshExec } from "../ssh.ts"
import {
  METRICS_CRON_NAME,
  METRICS_SCRIPT_PATH,
  normalizeMetricsConfig,
  renderMetricsCronFile,
  renderMetricsScript,
} from "../metrics.ts"
import { header, info, success, warn, error, log, confirm } from "../ui.ts"

async function installSubcommand(opts: {
  env?: string
  server?: string[]
  force?: boolean
  config: string
}) {
  const cfg = await loadConfig(opts.config)
  const metrics = cfg.settings?.metrics
  if (!metrics) {
    error("No `settings.metrics` block in deploy.yaml. Nothing to install.")
    info("Example:")
    info("  settings:")
    info("    metrics:")
    info("      endpoint: http://pushgateway:9091/metrics/job/ros")
    info("      format: prometheus        # or 'json' (default)")
    info("      include_host: true")
    info("      include_disk: true")
    process.exit(1)
  }

  const envName = opts.env ?? Object.keys(cfg.environments)[0]!
  const env = cfg.environments[envName]
  if (!env) {
    error("Unknown environment: " + envName)
    process.exit(1)
  }
  const servers = resolveServers(env, opts.server)
  if (servers.length === 0) {
    warn("No servers to install metrics on.")
    return
  }

  header("Install metrics on " + servers.length + " server(s)")

  if (!opts.force) {
    const ok = await confirm("Install metrics script and cron on " + servers.length + " server(s)?", false)
    if (!ok) {
      warn("Aborted.")
      return
    }
  }

  for (const server of servers) {
    log("-> " + server.raw)

    // The script embeds the hostname at render-time so metrics carry it as a label
    const script = renderMetricsScript(metrics, server.host)
    const cron = renderMetricsCronFile(metrics.schedule ?? "* * * * *")

    const b64 = Buffer.from(script, "utf8").toString("base64")
    const uploadCmd =
      "mkdir -p /var/log && " +
      "echo " +
      b64 +
      " | base64 -d > " +
      METRICS_SCRIPT_PATH +
      ".tmp && " +
      "chmod 755 " +
      METRICS_SCRIPT_PATH +
      ".tmp && " +
      "mv " +
      METRICS_SCRIPT_PATH +
      ".tmp " +
      METRICS_SCRIPT_PATH

    try {
      await sshExec(server, uploadCmd, { timeout: 30 })
      success("  script uploaded")
    } catch (e) {
      error("  ✖ upload failed: " + (e as Error).message)
      continue
    }

    const cronB64 = Buffer.from(cron, "utf8").toString("base64")
    const cronCmd =
      "echo " +
      cronB64 +
      " | base64 -d > /etc/cron.d/" +
      METRICS_CRON_NAME +
      " && chmod 644 /etc/cron.d/" +
      METRICS_CRON_NAME
    try {
      await sshExec(server, cronCmd, { timeout: 10 })
      success("  cron installed (/etc/cron.d/" + METRICS_CRON_NAME + ")")
    } catch (e) {
      error("  ✖ cron install failed: " + (e as Error).message)
    }
  }
}

async function uninstallSubcommand(opts: {
  env?: string
  server?: string[]
  force?: boolean
  config: string
}) {
  const cfg = await loadConfig(opts.config)
  const envName = opts.env ?? Object.keys(cfg.environments)[0]!
  const env = cfg.environments[envName]
  if (!env) {
    error("Unknown environment: " + envName)
    process.exit(1)
  }
  const servers = resolveServers(env, opts.server)

  header("Uninstall metrics from " + servers.length + " server(s)")

  if (!opts.force) {
    const ok = await confirm("Remove the metrics script and cron from " + servers.length + " server(s)?", false)
    if (!ok) {
      warn("Aborted.")
      return
    }
  }

  for (const server of servers) {
    log("-> " + server.raw)
    try {
      await sshExec(
        server,
        "rm -f " + METRICS_SCRIPT_PATH + " /etc/cron.d/" + METRICS_CRON_NAME,
        { timeout: 10 },
      )
      success("  removed")
    } catch (e) {
      warn("  ✖ " + (e as Error).message)
    }
  }
}

async function showSubcommand(opts: { config: string; env?: string }) {
  const cfg = await loadConfig(opts.config)
  const metrics = cfg.settings?.metrics
  if (!metrics) {
    warn("No `settings.metrics` block in deploy.yaml.")
    return
  }
  const envName = opts.env ?? Object.keys(cfg.environments)[0]!
  const server = cfg.environments[envName]?.servers?.[0]
  const host = server?.host ?? "localhost"
  header("Generated script (for host: " + host + ")")
  console.log(renderMetricsScript(metrics, host))
}

async function statusSubcommand(opts: {
  env?: string
  server?: string[]
  config: string
}) {
  const cfg = await loadConfig(opts.config)
  const envName = opts.env ?? Object.keys(cfg.environments)[0]!
  const env = cfg.environments[envName]
  if (!env) {
    error("Unknown environment: " + envName)
    process.exit(1)
  }
  const servers = resolveServers(env, opts.server)

  header("Metrics status")
  for (const server of servers) {
    log("-> " + server.raw)
    try {
      const out = await sshExec(
        server,
        "if [ -f " + METRICS_SCRIPT_PATH + " ]; then echo SCRIPT_OK; else echo SCRIPT_MISSING; fi; " +
          "if [ -f /etc/cron.d/" + METRICS_CRON_NAME + " ]; then echo CRON_OK; else echo CRON_MISSING; fi; " +
          "if [ -f /var/log/ros-metrics.log ]; then tail -5 /var/log/ros-metrics.log; fi",
        { timeout: 10 },
      )
      const lines = out.split("\n")
      for (const line of lines) {
        if (line === "SCRIPT_OK") success("  script: installed")
        else if (line === "SCRIPT_MISSING") warn("  script: NOT installed")
        else if (line === "CRON_OK") success("  cron: installed")
        else if (line === "CRON_MISSING") warn("  cron: NOT installed")
        else if (line) console.log("    " + line)
      }
    } catch (e) {
      warn("  ✖ " + (e as Error).message)
    }
  }
}

async function testSubcommand(opts: { config: string; env?: string }) {
  const cfg = await loadConfig(opts.config)
  const metrics = cfg.settings?.metrics
  if (!metrics?.endpoint) {
    warn("No metrics.endpoint configured")
    return
  }
  const normalized = normalizeMetricsConfig(metrics.endpoint)
  if (!normalized) {
    warn("No metrics.endpoint configured")
    return
  }

  // Manually POST a few sample metrics (new schema: source/metric/usage).
  // Covers the three metrics on host and the two container metrics.
  const { signPayload } = await import("../webhook.ts")
  const now = new Date().toISOString()
  const body = [
    JSON.stringify({ source: "host", metric: "mem", host: "ros-cli", ts: now, usage: 0 }),
    JSON.stringify({ source: "host", metric: "cpu", host: "ros-cli", ts: now, usage: 0 }),
    JSON.stringify({ source: "host", metric: "disk", host: "ros-cli", ts: now, mount: "/", usage: 0 }),
    JSON.stringify({ source: "container", metric: "mem", host: "ros-cli", ts: now, container: "example", usage: 0 }),
    JSON.stringify({ source: "container", metric: "cpu", host: "ros-cli", ts: now, container: "example", usage: 0 }),
  ].join("\n") + "\n"
  const headers: Record<string, string> = {
    "Content-Type": "application/x-ndjson",
    ...normalized.headers,
  }
  if (normalized.secret) {
    headers["X-Ros-Signature"] = "sha256=" + signPayload(body, normalized.secret)
  }

  try {
    const res = await fetch(normalized.url, {
      method: "POST",
      headers,
      body,
    })
    info("POST " + normalized.url + " -> " + res.status)
    if (res.ok) success("✓ endpoint accepted the test")
    else error("✖ endpoint returned " + res.status)
  } catch (e) {
    error("✖ " + (e as Error).message)
  }
}

export const metrics: Command = async ({ args, opts }) => {
  const sub = args[0] ?? "status"
  switch (sub) {
    case "install":
      return installSubcommand(opts)
    case "uninstall":
    case "remove":
      return uninstallSubcommand(opts)
    case "show":
      return showSubcommand(opts)
    case "status":
      return statusSubcommand(opts)
    case "test":
      return testSubcommand(opts)
    default:
      error(`Unknown subcommand: ros metrics ${sub}`)
      info("Available: install, uninstall, show, status, test")
      process.exit(1)
  }
}
