// Shared types for the `anteros` binary (framework CLI)

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn"

const PACKAGE_MANAGERS = ["bun", "npm", "pnpm", "yarn"] as const

export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value)
}

/** Flag names accepted by the parser (aliases included). */
export type FlagName = string

/** Where a flag writes its value. */
export type OptionKey =
  | "force"
  | "yes"
  | "verbose"
  | "noColor"
  | "help"
  | "version"
  | "dir"
  | "tenant"
  | "port"
  | "mongo"
  | "pm"
  | "install"
  | "git"
  | "entry"
  | "watch"

/** Normalized command-line options. */
export interface Options {
  force: boolean
  yes: boolean
  verbose: boolean
  noColor: boolean
  help: boolean
  version: boolean

  /** `anteros create` */
  dir?: string
  tenant?: string
  port?: number
  mongo?: string
  pm?: PackageManager
  install?: boolean
  git?: boolean

  /** `anteros dev` */
  entry?: string
  watch?: boolean
}

export interface UsedFlag {
  /** Flag as typed by the user (`--port`, `-p`, …). */
  flag: FlagName
  /** Option the flag resolves to. */
  key: OptionKey
}

export interface ParsedArgs {
  /** First non-flag token (`create`, `dev`, …). */
  command: string | null
  /** Remaining non-flag tokens. */
  positional: string[]
  /** Normalized options. */
  opts: Options
  /** Every recognized flag that was passed. */
  used: UsedFlag[]
  /** Flags the parser does not know at all. */
  unknown: FlagName[]
  /** Valid flags with a missing or malformed value. */
  invalid: string[]
}

export type CommandContext = {
  args: string[]
  opts: Options
  log: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
  success: (msg: string) => void
}

export type Command = (ctx: CommandContext) => Promise<void> | void
