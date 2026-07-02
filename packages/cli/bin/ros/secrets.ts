// Secret resolver for `ros` CLI
// Resolves `env_from: [{ secret: ... }]` references before deploy.
// Secrets are resolved client-side and never written to disk on the remote.

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface SecretRef {
  secret: string
}

export interface ResolvedSecrets {
  [key: string]: string
}

/**
 * Parse a secret reference string.
 * Format: "<backend>:<key>" or just "<key>" (defaults to file backend)
 *
 * Examples:
 *   "api-keys"              → file: ~/.config/ros/secrets/api-keys
 *   "env:API_KEY"           → process.env.API_KEY
 *   "1password:API_KEY"     → op read op://Prod/API_KEY
 *   "vault:kv/api/key"      → vault kv get kv/api/key
 */
function parseSecretRef(ref: string): { backend: string; key: string } {
  const colonIdx = ref.indexOf(":")
  if (colonIdx === -1) {
    return { backend: "file", key: ref }
  }
  const backend = ref.slice(0, colonIdx)
  const key = ref.slice(colonIdx + 1)
  return { backend, key }
}

/**
 * Resolve a single secret reference to its value.
 */
async function resolveSingleSecret(ref: string): Promise<string> {
  const { backend, key } = parseSecretRef(ref)

  switch (backend) {
    case "file": {
      // Read from ~/.config/ros/secrets/<key>
      const secretsDir = join(homedir(), ".config", "ros", "secrets")
      const filePath = join(secretsDir, key)
      if (!existsSync(filePath)) {
        throw new Error(`Secret file not found: ${filePath}`)
      }
      return readFileSync(filePath, "utf-8").trim()
    }

    case "env": {
      // Read from process.env
      const value = process.env[key]
      if (value === undefined) {
        throw new Error(`Environment variable not set: ${key}`)
      }
      return value
    }

    case "1password": {
      // Use 1Password CLI: op read op://<key>
      const proc = Bun.spawn(["op", "read", `op://${key}`], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        throw new Error(`1Password CLI failed for '${key}': ${stderr.trim()}`)
      }
      return stdout.trim()
    }

    case "vault": {
      // Use Vault CLI: vault kv get -field=value <key>
      const parts = key.split("/")
      const secretPath = parts.slice(0, -1).join("/")
      const field = parts[parts.length - 1] || "value"
      const proc = Bun.spawn(["vault", "kv", "get", "-field=" + field, secretPath], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        throw new Error(`Vault CLI failed for '${key}': ${stderr.trim()}`)
      }
      return stdout.trim()
    }

    default:
      throw new Error(`Unknown secret backend: '${backend}'`)
  }
}

/**
 * Resolve an array of secret references into a key-value map.
 * Each entry in env_from has format: { secret: "<backend>:<key>" }
 * The "key" part becomes the env var name, resolved to the secret value.
 */
export async function resolveSecrets(
  envFrom: SecretRef[] | undefined,
): Promise<ResolvedSecrets> {
  if (!envFrom || envFrom.length === 0) {
    return {}
  }

  const resolved: ResolvedSecrets = {}

  for (const entry of envFrom) {
    const ref = entry.secret
    const { backend, key } = parseSecretRef(ref)

    // The env var name is the last segment of the key
    // e.g. "env:API_KEY" → API_KEY, "1password:Prod/API_KEY" → API_KEY
    const envName = key.split("/").pop() || key

    try {
      resolved[envName] = await resolveSingleSecret(ref)
    } catch (err) {
      throw new Error(`Failed to resolve secret '${ref}': ${(err as Error).message}`)
    }
  }

  return resolved
}

/**
 * Merge resolved secrets with explicit env vars.
 * Explicit env vars take precedence over secrets.
 */
export function mergeEnvWithSecrets(
  env: Record<string, string> | undefined,
  secrets: ResolvedSecrets,
): Record<string, string> {
  return { ...secrets, ...(env ?? {}) }
}
