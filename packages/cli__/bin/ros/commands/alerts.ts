// `ros alerts` — install / manage a cron-based monitoring script on
// each target server.

import type { Command } from "../types.ts"
import { loadConfig, resolveServers } from "../config.ts"
import { sshExec } from "../ssh.ts"
import { ALERT_CRON_NAME, ALERT_SCRIPT_PATH, renderAlertScript, renderCronFile } from "../alerts.ts"
import { header, info, success, warn, error, log, confirm } from "../ui.ts"

async function installSubcommand(opts: {
  env?: string
  server?: string[]
  force?: boolean
  config: string
}) {
  const cfg = await loadConfig(opts.config)
  const alerts = cfg.settings?.alerts
  if (!alerts) {
    error("No `settings.alerts` block in deploy.yaml. Nothing to install.")
    info("Example:")
    info("  settings:")
    info("    alerts:")
    info("      schedule: '*/5 * * * *'")
    info("      webhook: https://hooks.slack.com/...")
    info("      email: ops@example.com")
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
    warn("No servers to install alerts on.")
    return
  }

  header("Install alerts on " + servers.length + " server(s)")

  const script = renderAlertScript(alerts)
  const schedule = alerts.schedule ?? "*/5 * * * *"
  const cron = renderCronFile(schedule)

  if (!opts.force) {
    const ok = await confirm("Install alerts script and cron on " + servers.length + " server(s)?", false)
    if (!ok) {
      warn("Aborted.")
      return
    }
  }

  for (const server of servers) {
    log("-> " + server.raw)

    // Upload the script to a temp file, then move it into place with chmod
    // We use a base64 roundtrip to avoid shell quoting issues.
    const b64 = Buffer.from(script, "utf8").toString("base64")
    const uploadCmd =
      "mkdir -p /var/lib/ros && " +
      "echo " +
      b64 +
      " | base64 -d > " +
      ALERT_SCRIPT_PATH +
      ".tmp && " +
      "chmod 755 " +
      ALERT_SCRIPT_PATH +
      ".tmp && " +
      "mv " +
      ALERT_SCRIPT_PATH +
      ".tmp " +
      ALERT_SCRIPT_PATH

    try {
      await sshExec(server, uploadCmd, { timeout: 30 })
      success("  script uploaded")
    } catch (e) {
      error("  ✖ upload failed: " + (e as Error).message)
      continue
    }

    // Install the cron entry
    const cronB64 = Buffer.from(cron, "utf8").toString("base64")
    const cronCmd =
      "echo " +
      cronB64 +
      " | base64 -d > /etc/cron.d/" +
      ALERT_CRON_NAME +
      " && chmod 644 /etc/cron.d/" +
      ALERT_CRON_NAME
    try {
      await sshExec(server, cronCmd, { timeout: 10 })
      success("  cron installed (/etc/cron.d/" + ALERT_CRON_NAME + ")")
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

  header("Uninstall alerts from " + servers.length + " server(s)")

  if (!opts.force) {
    const ok = await confirm("Remove the alerts script and cron from " + servers.length + " server(s)?", false)
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
        "rm -f " + ALERT_SCRIPT_PATH + " /etc/cron.d/" + ALERT_CRON_NAME,
        { timeout: 10 },
      )
      success("  removed")
    } catch (e) {
      warn("  ✖ " + (e as Error).message)
    }
  }
}

async function showSubcommand(opts: { config: string }) {
  const cfg = await loadConfig(opts.config)
  const alerts = cfg.settings?.alerts
  if (!alerts) {
    warn("No `settings.alerts` block in deploy.yaml.")
    return
  }
  header("Generated script")
  console.log(renderAlertScript(alerts))
  console.log("\n" + c.dim("-- cron entry --") + "\n")
  console.log(renderCronFile(alerts.schedule ?? "*/5 * * * *"))
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

  header("Alerts status")
  for (const server of servers) {
    log("-> " + server.raw)
    try {
      const out = await sshExec(
        server,
        "if [ -f " + ALERT_SCRIPT_PATH + " ]; then echo SCRIPT_OK; else echo SCRIPT_MISSING; fi; " +
          "if [ -f /etc/cron.d/" + ALERT_CRON_NAME + " ]; then echo CRON_OK; else echo CRON_MISSING; fi; " +
          "if [ -f /var/log/ros-alerts.log ]; then tail -3 /var/log/ros-alerts.log; fi",
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

async function testSubcommand(opts: { env?: string; server?: string[]; config: string }) {
  const cfg = await loadConfig(opts.config)
  const alerts = cfg.settings?.alerts
  if (!alerts?.webhook && !alerts?.email) {
    warn("No webhook or email configured in settings.alerts")
    return
  }
  if (!alerts.webhook) {
    warn("Only email is configured; cannot test from CLI (the cron script would send the email).")
    return
  }

  const envName = opts.env ?? Object.keys(cfg.environments)[0]!
  const env = cfg.environments[envName]
  if (!env) {
    error("Unknown environment: " + envName)
    process.exit(1)
  }
  const servers = resolveServers(env, opts.server)

  // POST a test payload directly (not via the server script)
  const { signPayload } = await import("../webhook.ts")
  const payload = JSON.stringify({
    event: "alert.test",
    host: servers[0]?.raw ?? "unknown",
    timestamp: new Date().toISOString(),
    subject: "Test alert from `ros alerts test`",
    body: "If you see this, your webhook is working.",
  })
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (alerts.webhook_secret) {
    headers["X-Ros-Signature"] = "sha256=" + signPayload(payload, alerts.webhook_secret)
  }

  try {
    const res = await fetch(alerts.webhook, { method: "POST", headers, body: payload })
    info("POST " + alerts.webhook + " -> " + res.status)
    if (res.ok) success("✓ webhook accepted the test event")
    else error("✖ webhook returned " + res.status)
  } catch (e) {
    error("✖ " + (e as Error).message)
  }
}

import { c } from "../ui.ts"

export const alerts: Command = async ({ args, opts }) => {
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
      error(`Unknown subcommand: ros alerts ${sub}`)
      info("Available: install, uninstall, show, status, test")
      process.exit(1)
  }
}
