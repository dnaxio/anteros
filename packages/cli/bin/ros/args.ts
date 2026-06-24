// Tiny argument parser. No external deps.

import type { GlobalOptions } from "./types.ts"

export interface ParsedArgs {
  command: string | null
  positional: string[]
  opts: GlobalOptions
  help: boolean
  version: boolean
}

const HELP_FLAGS = new Set(["-h", "--help"])
const VERSION_FLAGS = new Set(["-V", "--version"])

export function parseArgs(argv: string[]): ParsedArgs {
  const opts: GlobalOptions = {
    env: undefined,
    server: undefined,
    config: "./deploy.yaml",
    force: false,
    dryRun: false,
    noColor: !!process.env.NO_COLOR,
    verbose: false,
  }

  const positional: string[] = []
  let command: string | null = null
  let help = false
  let version = false

  let i = 0
  // First non-flag token is the command
  while (i < argv.length) {
    const a = argv[i]!

    if (HELP_FLAGS.has(a)) {
      help = true
      i++
      continue
    }
    if (VERSION_FLAGS.has(a)) {
      version = true
      i++
      continue
    }

    if (a === "-e" || a === "--env") {
      opts.env = argv[++i]
      i++
      continue
    }
    if (a.startsWith("--env=")) {
      opts.env = a.slice("--env=".length)
      i++
      continue
    }

    if (a === "-s" || a === "--server") {
      const list: string[] = []
      i++
      while (i < argv.length && !argv[i]!.startsWith("-")) {
        list.push(argv[i]!)
        i++
      }
      opts.server = list
      continue
    }

    if (a === "-c" || a === "--config") {
      opts.config = argv[++i] ?? opts.config
      i++
      continue
    }
    if (a.startsWith("--config=")) {
      opts.config = a.slice("--config=".length)
      i++
      continue
    }

    if (a === "-f" || a === "--force") {
      opts.force = true
      i++
      continue
    }
    if (a === "--dry-run") {
      opts.dryRun = true
      i++
      continue
    }
    if (a === "--no-color") {
      opts.noColor = true
      i++
      continue
    }
    if (a === "-v" || a === "--verbose") {
      opts.verbose = true
      i++
      continue
    }

    if (a.startsWith("-") && a !== "-") {
      // Unknown flag: pass it through to the subcommand (per-command flags
      // like `ros rollback <pod> --to <tag>` are handled by the command itself).
      positional.push(a)
      i++
      continue
    }

    if (command === null) {
      command = a
    } else {
      positional.push(a)
    }
    i++
  }

  return { command, positional, opts, help, version }
}
