#!/usr/bin/env bun
// `anteros` — Anteros framework CLI.
//
//   anteros create server [name]   scaffold a new project
//   anteros dev                    run the local dev server
//   anteros doctor                 diagnose the local environment
//   anteros ros <command>          deployment / CI-CD commands

import { join } from "node:path"
import { parseArgs, unsupportedFlags } from "./args.ts"
import { c, error, info, log, setColorEnabled, success, warn } from "./ui.ts"
import type { Command, OptionKey } from "./types.ts"
import { create } from "./commands/create.ts"
import { dev } from "./commands/dev.ts"
import { doctor } from "./commands/doctor.ts"

const manifest = (await Bun.file(join(import.meta.dir, "..", "..", "package.json")).json()) as {
  version?: string
}
const VERSION = manifest.version ?? "0.0.0"

interface CommandEntry {
  run: Command
  summary: string
  usage: string
  /** Options accepted on top of the globals. */
  flags: OptionKey[]
  /** Help shown by `anteros <command> --help`. */
  help: string
}

const COMMANDS: Record<string, CommandEntry> = {
  create: {
    run: create,
    summary: "Scaffold a new Anteros project",
    usage: "anteros create [template] [name] [options]",
    flags: ["dir", "tenant", "port", "mongo", "pm", "install", "git"],
    help: `
${c.bold("anteros create")} — scaffold a new Anteros project

${c.bold("Usage:")}
  anteros create [template] [name] [options]

${c.bold("Templates:")}
  server                  Bun + MongoDB server: a tenant, a collection, a route and an MCP tool

${c.bold("Arguments:")}
  template                Template to use (default: the only bundled template)
  name                    Project name and target directory (default: prompted)

${c.bold("Options:")}
  -d, --dir <path>        Target directory (default: ./<name>)
  -t, --tenant <id>       Tenant id and folder (default: v1)
  -p, --port <port>       HTTP port (default: 4000)
      --mongo <uri>       MongoDB connection string (default: mongodb://localhost:27017/<name>)
      --pm <pm>           Package manager: bun | npm | pnpm | yarn (default: bun)
      --install           Install dependencies (no prompt)
      --no-install        Skip dependency installation
      --git | --no-git    Initialize a git repository (default: ask)
  -f, --force             Write into a non-empty directory
  -y, --yes               Accept the default answer to every prompt

${c.bold("Examples:")}
  bunx @anteros/cli create server my-api
  anteros create server my-api --no-install
  anteros create my-api --tenant acme --port 3001
`,
  },

  dev: {
    run: dev,
    summary: "Run the local dev server (Bun watch)",
    usage: "anteros dev [entry] [options]",
    flags: ["entry", "watch"],
    help: `
${c.bold("anteros dev")} — run the local dev server

${c.bold("Usage:")}
  anteros dev [entry] [options]

${c.bold("Options:")}
  -e, --entry <file>      Entrypoint to run (default: index.ts)
      --watch             Restart on file changes (default)
      --no-watch          Disable the watcher

${c.bold("Examples:")}
  anteros dev
  anteros dev src/main.ts --no-watch
`,
  },

  doctor: {
    run: doctor,
    summary: "Diagnose the local environment",
    usage: "anteros doctor",
    flags: [],
    help: `
${c.bold("anteros doctor")} — diagnose the local environment

${c.bold("Usage:")}
  anteros doctor

Checks the Bun version, the project files, the installed @anteros/core, the
MongoDB connection, the HTTP port and the writability of the project directory.
Exits with code 1 when an error is reported.
`,
  },

  ros: {
    // Never dispatched: `anteros ros …` is forwarded before argument parsing.
    run: () => {},
    summary: "Deployment / CI-CD commands (forwarded to `ros`)",
    usage: "anteros ros <command> [options]",
    flags: [],
    help: `
${c.bold("anteros ros")} — deployment / CI-CD commands

${c.bold("Usage:")}
  anteros ros <command> [options]

Every argument is forwarded to the \`ros\` binary — run \`anteros ros --help\`
for the command list and options.

${c.bold("Examples:")}
  anteros ros init
  anteros ros deploy --env production
  anteros ros status api
`,
  },
}

const HELP = `
${c.bold("anteros")} ${c.dim(`v${VERSION}`)} — Anteros framework CLI

${c.bold("Usage:")}
  anteros <command> [options]

${c.bold("Commands:")}
${Object.entries(COMMANDS)
  .map(([name, command]) => `  ${c.bold(name.padEnd(12))} ${command.summary}`)
  .join("\n")}

${c.bold("Global options:")}
  -y, --yes               Accept the default answer to every prompt
      --no-color          Disable colored output
  -v, --verbose           Print stack traces on failure
  -h, --help              Show help
  -V, --version           Show the CLI version

${c.bold("Examples:")}
  bunx @anteros/cli create server my-api
  anteros create server my-api
  anteros dev
  anteros doctor
  anteros ros deploy --env production

${c.dim("Run `anteros <command> --help` for command-specific options.")}
`

async function main(argv = process.argv.slice(2)) {
  // `anteros ros …` is forwarded verbatim to the ros binary, which owns its
  // deployment flags (`--env`, `--server`, …) and its own help.
  const rosIndex = argv.indexOf("ros")
  if (rosIndex !== -1 && !argv.slice(0, rosIndex).some((token) => !token.startsWith("-"))) {
    const { main: runRos } = await import("../ros/index.ts")
    await runRos(argv.slice(rosIndex + 1))
    return
  }

  const parsed = parseArgs(argv)
  setColorEnabled(!parsed.opts.noColor)

  if (parsed.opts.version && !parsed.command) {
    console.log(VERSION)
    return
  }

  if (!parsed.command || (parsed.opts.help && !parsed.command)) {
    console.log(HELP)
    return
  }

  const entry = COMMANDS[parsed.command]
  if (!entry) {
    error(`Unknown command: ${parsed.command}`)
    console.log(HELP)
    process.exit(1)
  }

  if (parsed.opts.help) {
    console.log(entry.help)
    return
  }

  const unsupported = unsupportedFlags(parsed, entry.flags)
  const problems = [
    ...parsed.unknown.map((flag) => `Unknown option: ${flag}`),
    ...unsupported.map((flag) => `Option ${flag} is not valid for \`anteros ${parsed.command}\``),
    ...parsed.invalid,
  ]

  if (problems.length > 0) {
    for (const problem of problems) error(problem)
    info(`Run \`anteros ${parsed.command} --help\` for the accepted options.`)
    process.exit(1)
  }

  await entry.run({
    args: parsed.positional,
    opts: parsed.opts,
    log,
    warn,
    error,
    success,
  })
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    error(err instanceof Error ? err.message : String(err))
    if (process.argv.includes("--verbose") || process.argv.includes("-v")) console.error(err)
    process.exit(1)
  })
}

export { main }
