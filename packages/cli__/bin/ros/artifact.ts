// Artifact transfer logic.
//   source  → local file (scp) or directory (rsync, with .gitignore filter)
//   repo    → remote git repository cloned on the server
//
// Exactly one of `source` or `repo` is required per artifact.

import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve, relative, isAbsolute } from "node:path"
import type { ArtifactConfig, ServerTarget } from "./types.ts"
import { sshExec, rsyncToRemote } from "./ssh.ts"
import { log, success, error, warn, c } from "./ui.ts"

// ---------------------------------------------------------------------------
// .gitignore parsing
// ---------------------------------------------------------------------------

/**
 * Convert a .gitignore line to an rsync --exclude pattern.
 * Returns null for comments / blank lines.
 *
 * rsync semantics differ slightly from gitignore (no `!` negation, no
 * double-star matching), so we do a pragmatic translation:
 *   - leading `/` anchors to the source root
 *   - trailing `/` means dir-only (match the dir and everything inside)
 *   - GLOB_STAR_GLOB (e.g. double-star and double-star/X) are translated to X
 *     (rsync already matches at any depth)
 *   - other globs are passed through
 */
export function gitignoreToRsyncExclude(patterns: string[]): string[] {
  const out: string[] = []
  for (const raw of patterns) {
    let p = raw.trim()
    if (!p || p.startsWith("#")) continue
    if (p.startsWith("!")) {
      // gitignore negation → cannot be expressed as rsync exclude;
      // caller should pass it as include.
      continue
    }
    let prefix = ""
    if (p.startsWith("/")) {
      prefix = "/"
      p = p.slice(1)
    }
    if (p.endsWith("/")) {
      // directory pattern → match the dir and everything inside
      const d = p.slice(0, -1)
      out.push("--exclude=" + prefix + d)
      out.push("--exclude=" + prefix + d + "/" + "*" + "*")
    } else {
      p = p.replace(/^\*\*\//, "")
      out.push("--exclude=" + prefix + p)
    }
  }
  return out
}

/** Read and parse a .gitignore file. Returns [] if missing. */
export function loadGitignore(cwd: string): string[] {
  const path = resolve(cwd, ".gitignore")
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
}

/**
 * Merge gitignore excludes with user exclude patterns, then add
 * include patterns (which override everything).
 */
export function buildRsyncFilters(
  artifact: ArtifactConfig,
  cwd: string,
): { excludes: string[]; includes: string[] } {
  const gitignore = loadGitignore(cwd)
  const excludes: string[] = [
    ...gitignoreToRsyncExclude(gitignore),
    ...(artifact.exclude ?? []).map((e) => "--exclude=" + e),
  ]
  const includes: string[] = (artifact.include ?? []).map((i) => "--include=" + i)
  return { excludes, includes }
}

// ---------------------------------------------------------------------------
// Transfer: source (local file or directory)
// ---------------------------------------------------------------------------

/** True if the local path is a directory, false if it's a file. */
export function isDirectory(cwd: string, p: string): boolean {
  return statSync(resolve(cwd, p)).isDirectory()
}

/**
 * Ship a local file or directory to the remote server.
 *   - directory → rsync (with .gitignore / include / exclude)
 *   - file      → scp
 *
 * The `source:` field is intentionally permissive: it can be any local
 * path, the type is auto-detected.
 */
export async function pushSource(
  server: ServerTarget,
  artifact: ArtifactConfig,
  cwd: string,
  timeout: number | undefined,
  dryRun: boolean,
): Promise<void> {
  if (!artifact.source) throw new Error("source artifact requires source:")
  const src = resolve(cwd, artifact.source)
  if (!existsSync(src)) {
    throw new Error("Local path not found: " + src)
  }
  const isDir = statSync(src).isDirectory()

  if (isDir) {
    const { excludes, includes } = buildRsyncFilters(artifact, cwd)
    const source = src.endsWith("/") ? src : src + "/"

    log("  [" + server.raw + "] rsync " + source + " -> " + artifact.destination)
    if (dryRun) {
      log(
        c.dim(
          "    [dry-run] " +
            excludes.length +
            " exclude(s) (incl. gitignore), " +
            includes.length +
            " include(s) override",
        ),
      )
      return
    }
    await rsyncToRemote(server, {
      source,
      dest: artifact.destination,
      include: artifact.include,
      exclude: artifact.exclude,
      force: artifact.force,
      port: server.port,
      timeout,
      dryRun: false,
    })
    void excludes
    void includes
    success("  [" + server.raw + "] source synced")
  } else {
    // Single file: scp
    const remote = server.raw + ":" + artifact.destination
    log("  [" + server.raw + "] scp " + src + " -> " + artifact.destination)
    if (dryRun) {
      log(c.dim("    [dry-run] would scp " + relative(cwd, src)))
      return
    }
    const proc = Bun.spawn(["scp", "-P", String(server.port), src, remote], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    if (code !== 0) {
      throw new Error("scp failed (exit " + code + "): " + stderr.trim())
    }
    void stdout
    success("  [" + server.raw + "] file copied")
  }
}

// ---------------------------------------------------------------------------
// Transfer: repo (git clone on the remote)
// ---------------------------------------------------------------------------

export async function pushRepo(
  server: ServerTarget,
  artifact: ArtifactConfig,
  timeout: number | undefined,
  dryRun: boolean,
): Promise<void> {
  if (!artifact.repo) throw new Error("repo artifact requires repo:")
  const url = artifact.repo.url
  const ref = artifact.repo.ref
  const depth = artifact.repo.depth
  const dest = artifact.destination
  const isDirDest = dest.endsWith("/") || (!dest.includes(".") && !isAbsolute(dest))

  log(
    "  [" +
      server.raw +
      "] git clone " +
      url +
      (ref ? " (" + ref + ")" : "") +
      " -> " +
      dest,
  )
  if (dryRun) {
    log(c.dim("    [dry-run] would clone into " + dest))
    return
  }

  const depthArg = depth ? "--depth " + depth : ""
  const branchArg = ref ? "--branch " + ref : ""

  if (isDirDest) {
    // Clone (or update) the repo into dest
    const cmd =
      "mkdir -p " +
      dest +
      " && " +
      "if [ -d " +
      dest +
      "/.git ]; then " +
      "  cd " +
      dest +
      " && git fetch --all --prune " +
      depthArg +
      " && git reset --hard origin/" +
      (ref ?? "HEAD") +
      "; " +
      "else " +
      "  git clone " +
      depthArg +
      " " +
      branchArg +
      " " +
      url +
      " " +
      dest +
      "; " +
      "fi"
    await sshExec(server, cmd, { timeout: timeout ?? 300 })
  } else {
    // dest is a tarball path
    const cmd =
      "git clone " +
      depthArg +
      " " +
      branchArg +
      " " +
      url +
      " /tmp/ros-clone && " +
      "(cd /tmp/ros-clone && git archive --output=" +
      dest +
      " " +
      (ref ?? "HEAD") +
      ") && " +
      "rm -rf /tmp/ros-clone"
    await sshExec(server, cmd, { timeout: timeout ?? 300 })
  }
  success("  [" + server.raw + "] repo artifact ready")
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function pushArtifact(
  server: ServerTarget,
  artifact: ArtifactConfig,
  cwd: string,
  timeout: number | undefined,
  dryRun: boolean,
): Promise<void> {
  const kinds = [
    artifact.source && "source",
    artifact.repo && "repo",
  ].filter(Boolean) as string[]

  if (kinds.length === 0) {
    throw new Error("artifact must define one of source: or repo:")
  }
  if (kinds.length > 1) {
    throw new Error("artifact can only define one source (got: " + kinds.join(", ") + ")")
  }

  if (artifact.source) return pushSource(server, artifact, cwd, timeout, dryRun)
  if (artifact.repo) return pushRepo(server, artifact, timeout, dryRun)
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function describeArtifact(a: ArtifactConfig | undefined): string {
  if (!a) return "—"
  if (a.source) {
    const inc = a.include?.length ?? 0
    const exc = a.exclude?.length ?? 0
    const flags: string[] = []
    if (a.force) flags.push("force")
    if (inc > 0) flags.push("+" + inc)
    if (exc > 0) flags.push("-" + exc)
    return (
      a.source +
      " -> " +
      a.destination +
      (flags.length ? " [" + flags.join(", ") + "]" : "")
    )
  }
  if (a.repo) {
    const ref = a.repo.ref ? "@" + a.repo.ref : ""
    return "repo:" + a.repo.url + ref + " -> " + a.destination
  }
  return "—"
}
