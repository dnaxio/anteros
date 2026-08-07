// `ros config` — validate and inspect the deploy.yaml.

import type { Command } from "../types.ts"
import { loadConfig, resolveServers } from "../config.ts"
import { header, kvTable, success, error, info } from "../ui.ts"

export const config: Command = async ({ args, opts }) => {
  const sub = args[0] ?? "show"

  if (sub === "validate") {
    try {
      await loadConfig(opts.config)
      success(`✓ ${opts.config} is valid`)
    } catch (e) {
      error((e as Error).message)
      process.exit(1)
    }
    return
  }

  if (sub === "show") {
    const cfg = await loadConfig(opts.config)
    const envName = args[1] ?? opts.env
    if (envName) {
      const env = cfg.environments[envName]
      if (!env) {
        error(`Unknown environment: ${envName}`)
        process.exit(1)
      }
      header(`Environment: ${envName}`)
      kvTable([
        ["Servers", env.servers.map((s) => s.raw).join("\n")],
        ["Caddy routes", String(env.caddy?.length ?? 0)],
        ["Pods", Object.keys(env.pods ?? {}).join(", ") || "(none)"],
      ])
      return
    }
    header(`Config: ${opts.config}`)
    kvTable([
      ["Name", cfg.name],
      ["Version", cfg.version],
      ["Environments", Object.keys(cfg.environments).join(", ")],
      ["Pods", Object.keys(cfg.pods).join(", ")],
      ["Proxy routes", String(cfg.proxy?.routes.length ?? 0)],
    ])
    return
  }

  if (sub === "servers") {
    const cfg = await loadConfig(opts.config)
    const envName = args[1] ?? opts.env
    if (!envName) {
      error("Usage: ros config servers <env>")
      process.exit(1)
    }
    const env = cfg.environments[envName]
    if (!env) {
      error(`Unknown environment: ${envName}`)
      process.exit(1)
    }
    const servers = resolveServers(env, opts.server)
    header(`Servers for ${envName}`)
    for (const s of servers) {
      info(`${s.raw}${s.name ? `  (${s.name})` : ""}${s.tags ? `  [${s.tags.join(", ")}]` : ""}`)
    }
    return
  }

  error(`Unknown subcommand: ros config ${sub}`)
  info("Available: validate, show [env], servers <env>")
  process.exit(1)
}
