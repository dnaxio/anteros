// Loads and validates the deploy.yaml configuration.

import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { DeployConfig, ServerTarget } from "./types.ts"
import { error } from "./ui.ts"

const SERVER_RE = /^(?:(?<user>[^@]+)@)?(?<host>[^:]+)(?::(?<port>\d+))?$/

/** Expand ${VAR} and ${VAR:-default} patterns in a string. */
export function expandEnv(input: string): string {
  return input.replace(
    /\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name, fallback) => {
      const v = process.env[name]
      if (v !== undefined && v !== "") return v
      if (fallback !== undefined) return fallback
      return ""
    },
  )
}

/** Parse a single server entry: string or object. */
export function parseServer(entry: unknown, index: number): ServerTarget {
  if (typeof entry === "string") {
    const raw = expandEnv(entry).trim()
    const m = SERVER_RE.exec(raw)
    if (!m || !m.groups) {
      throw new Error(
        `Invalid server target "${raw}" at index ${index}. Expected "user@host[:port]".`,
      )
    }
    return {
      raw,
      user: m.groups.user ?? "root",
      host: m.groups.host!,
      port: Number(m.groups.port ?? 22),
    }
  }
  if (typeof entry === "object" && entry !== null) {
    const e = entry as { name?: string; host: string; tags?: string[]; port?: number }
    const raw = expandEnv(e.host).trim()
    const m = SERVER_RE.exec(raw)
    if (!m || !m.groups) {
      throw new Error(
        `Invalid server target "${raw}" (name=${e.name ?? "?"}). Expected "user@host[:port]".`,
      )
    }
    return {
      raw,
      name: e.name,
      user: m.groups.user ?? "root",
      host: m.groups.host!,
      port: e.port ?? Number(m.groups.port ?? 22),
      tags: e.tags,
    }
  }
  throw new Error(`Invalid server entry at index ${index}: ${String(entry)}`)
}

export async function loadConfig(path: string): Promise<DeployConfig> {
  const abs = resolve(path)
  if (!existsSync(abs)) {
    error(`Config file not found: ${abs}`)
    process.exit(1)
  }
  const text = await Bun.file(abs).text()
  let data: any
  try {
    // @ts-ignore — Bun.YAML is available since Bun 1.2
    data = Bun.YAML.parse(text)
  } catch (e) {
    error(`Failed to parse ${abs}: ${(e as Error).message}`)
    process.exit(1)
  }

  // Normalize server entries to ServerTarget[]
  for (const env of Object.values<any>(data.environments)) {
    env.servers = (env.servers as unknown[]).map((s, i) => parseServer(s, i))
  }

  validate(data)
  return data as DeployConfig
}

function validate(c: any): asserts c is DeployConfig {
  if (!c || typeof c !== "object") {
    throw new Error("Config must be an object")
  }
  if (!c.version) throw new Error("Missing 'version' in deploy.yaml")
  if (!c.name) throw new Error("Missing 'name' in deploy.yaml")
  if (!c.environments || typeof c.environments !== "object") {
    throw new Error("Missing 'environments' in deploy.yaml")
  }
  if (!c.pods || typeof c.pods !== "object") {
    throw new Error("Missing 'pods' in deploy.yaml")
  }
  for (const [envName, env] of Object.entries<any>(c.environments)) {
    if (!Array.isArray(env.servers)) {
      throw new Error(`environments.${envName}.servers must be an array`)
    }
  }
}

/** Resolve a list of --server filters against an env's servers. */
export function resolveServers(
  env: { servers: ServerTarget[] },
  filters: string[] | undefined,
): ServerTarget[] {
  if (!filters || filters.length === 0) return env.servers
  const out: ServerTarget[] = []
  for (const f of filters) {
    const expanded = expandEnv(f).trim()
    const found = env.servers.find((s) => {
      if (s.raw === expanded) return true
      if (s.name === expanded) return true
      if (s.tags?.includes(expanded)) return true
      if (s.host === expanded) return true
      return false
    })
    if (!found) {
      throw new Error(
        `Server "${expanded}" not found in environment. ` +
          `Available: ${env.servers.map((s) => s.raw).join(", ")}`,
      )
    }
    out.push(found)
  }
  return out
}
