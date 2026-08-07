// Deployment history tracking.
//
// On every successful `ros deploy`, an entry is appended to:
//   <history_dir>/<env>/<pod>.json
//
// Each entry contains the deployed tag, a timestamp, and (optionally)
// who triggered the deploy. The history is read by `ros rollback` to
// determine the previous tag when `--to` is not specified.

import { sshExec } from "./ssh.ts"
import type { ServerTarget } from "./types.ts"

export interface HistoryEntry {
  /** Image tag deployed (e.g. "v1.0.2"). */
  tag: string
  /** ISO 8601 timestamp. */
  deployed_at: string
  /** Optional: who/what triggered the deploy (CI run, user, …). */
  deployer?: string
  /** Optional: image reference (image:tag). */
  image?: string
}

export type History = HistoryEntry[]

/** Default location on the remote server. */
export const DEFAULT_HISTORY_DIR = "/var/lib/ros/history"

export function historyDirFor(env: string, baseDir: string): string {
  return baseDir.replace(/\/$/, "") + "/" + env
}

export function historyPath(env: string, pod: string, baseDir: string): string {
  return historyDirFor(env, baseDir) + "/" + pod + ".json"
}

// ---------------------------------------------------------------------------
// Remote operations (via SSH)
// ---------------------------------------------------------------------------

/** Read the history file on the remote server. Returns [] if missing. */
export async function readHistory(
  server: ServerTarget,
  env: string,
  pod: string,
  baseDir: string,
): Promise<History> {
  const path = historyPath(env, pod, baseDir)
  // cat with explicit fallback to empty array if file doesn't exist
  const cmd =
    "if [ -f " +
    path +
    " ]; then cat " +
    path +
    "; else echo '[]'; fi"
  try {
    const out = await sshExec(server, cmd, { timeout: 10 })
    const trimmed = out.trim()
    if (!trimmed) return []
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Append a new entry to the history file on the remote server. */
export async function appendHistory(
  server: ServerTarget,
  env: string,
  pod: string,
  entry: HistoryEntry,
  baseDir: string,
): Promise<void> {
  const dir = historyDirFor(env, baseDir)
  const path = historyPath(env, pod, baseDir)
  const cmd =
    "mkdir -p " +
    dir +
    " && " +
    // Read existing, append, write back atomically (via temp file + mv)
    "if [ -f " +
    path +
    " ]; then " +
    "  cat " +
    path +
    "; " +
    "else echo '[]'; fi"
  const out = await sshExec(server, cmd, { timeout: 10 })
  let current: History = []
  try {
    const trimmed = out.trim()
    if (trimmed) current = JSON.parse(trimmed)
    if (!Array.isArray(current)) current = []
  } catch {
    current = []
  }
  current.push(entry)

  // Write back via stdin (Bun.spawn doesn't pipe stdin easily, so we
  // encode the JSON as a single-quoted shell string).
  const json = JSON.stringify(current)
  const escaped = json.replace(/'/g, "'\\''")
  await sshExec(
    server,
    "printf '%s' '" + escaped + "' > " + path + ".tmp && mv " + path + ".tmp " + path,
    { timeout: 10 },
  )
}

/** Return the second-to-last entry (the "previous" tag). */
export function previousTag(history: History): HistoryEntry | null {
  if (history.length < 2) return null
  return history[history.length - 2] ?? null
}

/** Return the last entry (the "current" tag). */
export function currentTag(history: History): HistoryEntry | null {
  if (history.length === 0) return null
  return history[history.length - 1] ?? null
}

/** Build a history entry from current context. */
export function makeEntry(
  image: string,
  tag: string,
  deployer?: string,
): HistoryEntry {
  return {
    tag,
    image: image + ":" + tag,
    deployed_at: new Date().toISOString(),
    deployer: deployer ?? process.env.USER ?? process.env.USERNAME ?? "unknown",
  }
}

// ---------------------------------------------------------------------------
// Local operations (for tests / non-SSH use)
// ---------------------------------------------------------------------------

export function appendLocal(history: History, entry: HistoryEntry): History {
  return [...history, entry]
}

export function previousLocal(history: History): HistoryEntry | null {
  return previousTag(history)
}
