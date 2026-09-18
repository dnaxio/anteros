// Flag parsing for `anteros`. No external dependencies.
//
// The parser is deliberately strict: every flag must be declared in FLAGS, and
// each command declares which options it accepts (see `commands/`). Unknown or
// misplaced flags are reported instead of being silently ignored.

import { isPackageManager, type OptionKey, type Options, type ParsedArgs, type UsedFlag } from "./types.ts"

type FlagDef =
  | { key: OptionKey; kind: "boolean"; value: boolean }
  | { key: OptionKey; kind: "string" }
  | { key: OptionKey; kind: "number" }
  | { key: OptionKey; kind: "choice"; choices: readonly string[] }

const FLAGS: Record<string, FlagDef> = {
  // globals
  "-h": { key: "help", kind: "boolean", value: true },
  "--help": { key: "help", kind: "boolean", value: true },
  "-V": { key: "version", kind: "boolean", value: true },
  "--version": { key: "version", kind: "boolean", value: true },
  "-v": { key: "verbose", kind: "boolean", value: true },
  "--verbose": { key: "verbose", kind: "boolean", value: true },
  "--no-color": { key: "noColor", kind: "boolean", value: true },
  "-f": { key: "force", kind: "boolean", value: true },
  "--force": { key: "force", kind: "boolean", value: true },
  "-y": { key: "yes", kind: "boolean", value: true },
  "--yes": { key: "yes", kind: "boolean", value: true },

  // create
  "-d": { key: "dir", kind: "string" },
  "--dir": { key: "dir", kind: "string" },
  "-t": { key: "tenant", kind: "string" },
  "--tenant": { key: "tenant", kind: "string" },
  "-p": { key: "port", kind: "number" },
  "--port": { key: "port", kind: "number" },
  "--mongo": { key: "mongo", kind: "string" },
  "--pm": { key: "pm", kind: "choice", choices: ["bun", "npm", "pnpm", "yarn"] },
  "--install": { key: "install", kind: "boolean", value: true },
  "--no-install": { key: "install", kind: "boolean", value: false },
  "--git": { key: "git", kind: "boolean", value: true },
  "--no-git": { key: "git", kind: "boolean", value: false },

  // dev
  "-e": { key: "entry", kind: "string" },
  "--entry": { key: "entry", kind: "string" },
  "--watch": { key: "watch", kind: "boolean", value: true },
  "--no-watch": { key: "watch", kind: "boolean", value: false },
}

/** Options every command accepts. */
export const GLOBAL_KEYS: OptionKey[] = ["help", "version", "verbose", "noColor", "force", "yes"]

/** Option keys that can be set from a flag. */
export type RawOptions = Record<string, string | number | boolean>

export function parseArgs(argv: string[]): ParsedArgs {
  const raw: RawOptions = {}
  const positional: string[] = []
  const used: UsedFlag[] = []
  const unknown: string[] = []
  const invalid: string[] = []
  let command: string | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!

    // Everything after `--` is positional
    if (arg === "--") {
      positional.push(...argv.slice(i + 1))
      break
    }

    if (!arg.startsWith("-") || arg === "-") {
      if (command === null) command = arg
      else positional.push(arg)
      continue
    }

    const equals = arg.indexOf("=")
    const name = equals === -1 ? arg : arg.slice(0, equals)
    const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1)
    const def = FLAGS[name]

    if (!def) {
      unknown.push(name)
      continue
    }

    used.push({ flag: name, key: def.key })

    if (def.kind === "boolean") {
      raw[def.key] = inlineValue === undefined ? def.value : inlineValue !== "false"
      continue
    }

    const value = inlineValue ?? argv[++i]
    if (value === undefined || value === "") {
      invalid.push(`${name} expects a value`)
      continue
    }

    if (def.kind === "number") {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) invalid.push(`${name} expects a number, received "${value}"`)
      else raw[def.key] = parsed
      continue
    }

    if (def.kind === "choice") {
      if (!def.choices.includes(value)) {
        invalid.push(`${name} expects one of ${def.choices.join(", ")} — received "${value}"`)
      } else raw[def.key] = value
      continue
    }

    raw[def.key] = value
  }

  return { command, positional, opts: buildOptions(raw), used, unknown, invalid }
}

function buildOptions(raw: RawOptions): Options {
  const opts: Options = {
    force: raw.force === true,
    yes: raw.yes === true,
    verbose: raw.verbose === true,
    noColor: raw.noColor === true,
    help: raw.help === true,
    version: raw.version === true,
  }

  if (raw.dir !== undefined) opts.dir = String(raw.dir)
  if (raw.tenant !== undefined) opts.tenant = String(raw.tenant)
  if (raw.port !== undefined) opts.port = Number(raw.port)
  if (raw.mongo !== undefined) opts.mongo = String(raw.mongo)
  if (typeof raw.pm === "string" && isPackageManager(raw.pm)) opts.pm = raw.pm
  if (raw.install !== undefined) opts.install = raw.install === true
  if (raw.git !== undefined) opts.git = raw.git === true
  if (raw.entry !== undefined) opts.entry = String(raw.entry)
  if (raw.watch !== undefined) opts.watch = raw.watch === true

  return opts
}

/** Flags that were used but are not accepted by the given command. */
export function unsupportedFlags(parsed: ParsedArgs, allowed: OptionKey[]): string[] {
  const accepted = new Set<OptionKey>([...GLOBAL_KEYS, ...allowed])
  return parsed.used.filter((flag) => !accepted.has(flag.key)).map((flag) => flag.flag)
}
