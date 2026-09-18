// Build step executor: runs steps locally (Bun.spawn) or remotely (sshExec).

import type { BuildStep, ServerTarget, PodConfig } from "./types.ts"
import { sshExec } from "./ssh.ts"
import { log, success, error, warn, c } from "./ui.ts"

export interface BuildResult {
  /** Steps that ran locally */
  local: number
  /** Steps that ran on each server */
  remote: number
  /** Servers that ran remote steps */
  servers: ServerTarget[]
}

function fmtStep(step: BuildStep, idx: number): string {
  if ("name" in step && step.name) return `${idx + 1}. ${step.name}`
  return `${idx + 1}. ${step.run}`
}

/**
 * Build a PATH string with the typical toolchain install locations
 * prepended, so local build steps work right after `ros setup` without
 * requiring a shell re-login to pick up `~/.bashrc` / `~/.zshrc` changes.
 *
 * This is OS-aware but conservative: only paths that actually exist on
 * the filesystem are added.
 */
export function buildLocalPath(): string {
  const candidates = [
    "$HOME/.bun/bin",          // Bun (https://bun.sh)
    "$HOME/.local/bin",        // pip, pipx, etc.
    "$HOME/.cargo/bin",        // Rust
    "$HOME/.flox/bin",         // Flox
    "$HOME/.nvm/versions/node/current/bin", // nvm-managed node
    "/usr/local/bin",
    "/opt/homebrew/bin",       // macOS Homebrew (Apple Silicon)
    "/usr/local/cellar/bin",   // macOS Homebrew (Intel)
  ]
  // Resolve $HOME once
  const home = process.env.HOME ?? ""
  const extras: string[] = []
  for (const raw of candidates) {
    const p = raw.replace(/\$HOME/g, home)
    try {
      // require("node:fs") is already imported elsewhere; use a lazy require
      // to avoid an import at the top of the file just for this.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { existsSync } = require("node:fs") as typeof import("node:fs")
      if (existsSync(p)) extras.push(p)
    } catch {
      // ignore
    }
  }
  const current = process.env.PATH ?? ""
  return [...extras, current].join(":")
}

/** Run all local build steps for a service. */
export async function runLocalBuild(
  pod: string,
  build: PodConfig["build"],
  cwd: string,
  dryRun: boolean,
): Promise<number> {
  const steps = build?.local?.steps ?? []
  if (steps.length === 0) return 0

  log(c.dim(`  [local] ${steps.length} step(s) for ${pod}`))
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    if (dryRun) {
      log(c.dim(`    [dry-run] ${fmtStep(step, i)}`))
      continue
    }
    const label = "name" in step && step.name ? step.name : step.run
    log(`    ${c.cyan("→")} ${label}`)
    const proc = Bun.spawn(["sh", "-c", step.run], {
      cwd: step.cwd ?? cwd,
      env: {
        ...process.env,
        ...(step.env ?? {}),
        // Auto-export common toolchain paths so steps work right after
        // `ros setup`, without requiring the user to re-login.
        PATH: buildLocalPath(),
      },
      stdout: "inherit",
      stderr: "inherit",
    })
    const code = await proc.exited
    if (code !== 0) {
      throw new Error(`Local build step failed for ${pod}: ${label} (exit ${code})`)
    }
    success(`    ✓ ${label}`)
  }
  return steps.length
}

/** Run all remote build steps for a service on each target server. */
export async function runRemoteBuild(
  pod: string,
  build: PodConfig["build"],
  servers: ServerTarget[],
  timeout: number | undefined,
  dryRun: boolean,
): Promise<number> {
  const steps = build?.remote?.steps ?? []
  if (steps.length === 0 || servers.length === 0) return 0

  log(c.dim(`  [remote] ${steps.length} step(s) for ${pod} on ${servers.length} server(s)`))

  await Promise.all(
    servers.map(async (server) => {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!
        if (dryRun) {
          log(c.dim(`    [dry-run:${server.raw}] ${fmtStep(step, i)}`))
          continue
        }
        const label = "name" in step && step.name ? step.name : step.run
        log(`    [${server.raw}] ${c.cyan("→")} ${label}`)
        try {
          await sshExec(server, step.run, { timeout })
          success(`    [${server.raw}] ✓ ${label}`)
        } catch (e) {
          error(`    [${server.raw}] ✖ ${(e as Error).message}`)
          throw e
        }
      }
    }),
  )
  return steps.length
}

/** Build summary for the deploy plan table. */
export function describeBuild(build: PodConfig["build"]): string {
  const local = build?.local?.steps?.length ?? 0
  const remote = build?.remote?.steps?.length ?? 0
  const parts: string[] = []
  if (local > 0) parts.push(`local:${local}`)
  if (remote > 0) parts.push(`remote:${remote}`)
  return parts.length > 0 ? parts.join(" ") : "—"
}
