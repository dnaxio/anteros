// Thin wrapper around the system `ssh` binary.
// - Reuses a single TCP connection per server via SSH ControlMaster.
// - Provides rsync helpers for `sync` operations.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ServerTarget } from "./types.ts"

export interface SshOptions {
  identity?: string
  port?: number
  timeout?: number
  quiet?: boolean
  /** Compress SSH stream (default: true) */
  compress?: boolean
}

// ---------------------------------------------------------------------------
// ControlMaster: one persistent socket per (host,port,user) per CLI run.
// ---------------------------------------------------------------------------

const CONTROL_DIR = mkdtempSync(join(tmpdir(), "ros-ssh-"))
const SOCKET_RE = /[^a-zA-Z0-9._-]/g

function socketPathFor(server: ServerTarget): string {
  const safe = `${server.user}@${server.host}:${server.port}`.replace(
    SOCKET_RE,
    "_",
  )
  return join(CONTROL_DIR, `cm-${safe}.sock`)
}

function buildCommonArgs(
  server: ServerTarget,
  opts: SshOptions,
  extra: string[] = [],
): string[] {
  const args: string[] = []
  args.push("-p", String(opts.port ?? server.port))
  if (opts.identity) args.push("-i", opts.identity)
  args.push("-o", "BatchMode=yes")
  args.push("-o", "StrictHostKeyChecking=accept-new")
  if (opts.timeout) args.push("-o", `ConnectTimeout=${opts.timeout}`)
  if (opts.compress !== false) args.push("-C")
  // ControlMaster: reuse the persistent socket
  args.push("-o", "ControlMaster=auto")
  args.push("-o", `ControlPath=${socketPathFor(server)}`)
  args.push("-o", "ControlPersist=600") // keep alive 10min after last use
  args.push(...extra)
  return args
}

export function buildSshArgs(
  server: ServerTarget,
  opts: SshOptions = {},
  remoteCmd: string[],
): string[] {
  return [...buildCommonArgs(server, opts), server.raw, ...remoteCmd]
}

export async function ssh(
  server: ServerTarget,
  remoteCmd: string | string[],
  opts: SshOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cmd = Array.isArray(remoteCmd) ? remoteCmd : [remoteCmd]
  const args = buildSshArgs(server, opts, cmd)
  const proc = Bun.spawn(["ssh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

export async function sshExec(
  server: ServerTarget,
  cmd: string,
  opts: SshOptions = {},
): Promise<string> {
  const r = await ssh(server, cmd, opts)
  if (r.exitCode !== 0) {
    throw new Error(
      `SSH command failed on ${server.raw} (exit ${r.exitCode}): ${r.stderr.trim()}`,
    )
  }
  return r.stdout
}

// ---------------------------------------------------------------------------
// rsync helpers
// ---------------------------------------------------------------------------

export interface RsyncOptions {
  /** local source path (must end with `/` to copy contents only) */
  source: string
  /** remote destination (absolute path on the server) */
  dest: string
  /** include globs (rsync `--include`) */
  include?: string[]
  /** exclude globs (rsync `--exclude`) */
  exclude?: string[]
  /** force overwrite (rsync `--delete`) */
  force?: boolean
  /** ssh identity / port (forwarded via `-e`) */
  identity?: string
  port?: number
  timeout?: number
  dryRun?: boolean
}

/** Build rsync args for local → remote sync. */
export function buildRsyncArgs(
  server: ServerTarget,
  opts: RsyncOptions,
): string[] {
  const args: string[] = ["-az"] // archive + compress
  args.push("--human-readable")
  args.push("--info=progress2,stats2")
  if (opts.dryRun) args.push("--dry-run")
  if (opts.force) args.push("--delete")
  for (const inc of opts.include ?? []) args.push(`--include=${inc}`)
  for (const exc of opts.exclude ?? []) args.push(`--exclude=${exc}`)

  // Use the same ControlMaster socket via a custom `ssh` command
  const sshCmd = [
    "ssh",
    "-p",
    String(opts.port ?? server.port),
    ...(opts.identity ? ["-i", opts.identity] : []),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `ControlPath=${socketPathFor(server)}`,
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPersist=600",
    ...(opts.timeout ? ["-o", `ConnectTimeout=${opts.timeout}`] : []),
    "-C",
  ]
  args.push("-e", sshCmd.map(quoteShell).join(" "))

  args.push(opts.source) // local
  args.push(`${server.raw}:${opts.dest}`) // remote
  return args
}

export async function rsync(
  server: ServerTarget,
  opts: RsyncOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = buildRsyncArgs(server, opts)
  const proc = Bun.spawn(["rsync", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

export async function rsyncToRemote(
  server: ServerTarget,
  opts: RsyncOptions,
): Promise<void> {
  const r = await rsync(server, opts)
  if (r.exitCode !== 0) {
    throw new Error(
      `rsync to ${server.raw} failed (exit ${r.exitCode}): ${r.stderr.trim()}`,
    )
  }
}

/** Quote a shell token for inclusion in a single `-e` argument. */
function quoteShell(s: string): string {
  if (/^[a-zA-Z0-9_./:=@,-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// ---------------------------------------------------------------------------
// Cleanup: close control sockets on exit.
// ---------------------------------------------------------------------------

let cleanupRegistered = false
function registerCleanup() {
  if (cleanupRegistered) return
  cleanupRegistered = true
  const close = () => {
    try {
      rmSync(CONTROL_DIR, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
  process.once("exit", close)
  process.once("SIGINT", () => {
    close()
    process.exit(130)
  })
  process.once("SIGTERM", () => {
    close()
    process.exit(143)
  })
}
registerCleanup()
