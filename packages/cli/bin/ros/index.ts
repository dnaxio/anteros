#!/usr/bin/env bun
// `ros` — Anteros deployment / CI-CD CLI.

import { parseArgs } from "./args.ts"
import { error, c } from "./ui.ts"
import type { Command } from "./types.ts"

import { init } from "./commands/init.ts"
import { config } from "./commands/config.ts"
import { deploy } from "./commands/deploy.ts"
import { status } from "./commands/status.ts"
import { setup } from "./commands/setup.ts"
import { logs } from "./commands/logs.ts"
import { rollback } from "./commands/rollback.ts"
import { destroy } from "./commands/destroy.ts"
import { exec } from "./commands/exec.ts"
import { env } from "./commands/env.ts"
import { proxy } from "./commands/proxy.ts"
import { history } from "./commands/history.ts"

const COMMANDS: Record<string, { run: Command; summary: string; usage?: string }> = {
  init: {
    run: init,
    summary: "Create a deploy.yaml in the current project",
  },
  deploy: {
    run: deploy,
    summary: "Deploy pods to the target environment",
    usage: "ros deploy [env] [--pod <name>] [--tag <tag>] [--strategy <s>]",
  },
  status: {
    run: status,
    summary: "Show the status of deployed pods",
    usage: "ros status [env] [pod]",
  },
  setup: {
    run: setup,
    summary: "Install required dependencies on remote servers",
    usage: "ros setup [env] [dep…]  |  ros setup --server root@ip",
  },
  logs: {
    run: logs,
    summary: "Tail logs from a pod",
    usage: "ros logs <pod> [--tail N] [--since 10m]",
  },
  rollback: {
    run: rollback,
    summary: "Roll back to the previous version",
    usage: "ros rollback <pod> [--to <tag>]",
  },
  destroy: {
    run: destroy,
    summary: "Remove a pod and its resources",
    usage: "ros destroy <pod>",
  },
  exec: {
    run: exec,
    summary: "Run a command on a remote server / inside a container",
    usage: "ros exec <pod|server> <cmd…>",
  },
  env: {
    run: env,
    summary: "Show the resolved environment variables",
    usage: "ros env [env] [pod]",
  },
  config: {
    run: config,
    summary: "Validate / inspect the deploy.yaml",
    usage: "ros config <validate|show|servers>",
  },
  proxy: {
    run: proxy,
    summary: "Manage the Caddy reverse proxy (Admin API)",
    usage: "ros proxy <apply|show|diff|watch|remove> [env]",
  },
  history: {
    run: history,
    summary: "Show the deployment history",
    usage: "ros history [pod] [--env <name>]",
  },
}

const HELP = `
${c.bold("ros")} — Anteros deployment / CI-CD CLI

${c.bold("Usage:")}
  ros <command> [options]

${c.bold("Commands:")}
${Object.entries(COMMANDS)
  .map(([name, cmd]) => `  ${c.bold(name).padEnd(12)} ${cmd.summary}`)
  .join("\n")}

${c.bold("Global options:")}
  -e, --env <name>        Target environment
  -s, --server <target>   Target server(s)
  -c, --config <path>     Path to deploy.yaml (default: ./deploy.yaml)
  -f, --force             Bypass safety checks
      --dry-run           Show the plan without applying it
      --no-color          Disable colored output
  -v, --verbose           Verbose mode
  -h, --help              Show this help
      --version           Show ros version

${c.bold("Examples:")}
  ros init
  ros deploy --env production
  ros deploy --service api --tag v1.0.3 --force
  ros status api
  ros setup --env production
  ros logs api --tail 200
  ros rollback api --to v1.0.1
  ros config validate
  ros proxy diff --env production
`

async function main() {
  const argv = process.argv.slice(2)
  const parsed = parseArgs(argv)

  if (parsed.version) {
    console.log("ros 0.0.1")
    return
  }

  if (!parsed.command || parsed.help) {
    console.log(HELP)
    return
  }

  const entry = COMMANDS[parsed.command]
  if (!entry) {
    error(`Unknown command: ${parsed.command}`)
    console.log(HELP)
    process.exit(1)
  }

  if (entry.usage && parsed.positional.length === 0 && parsed.command !== "config" && parsed.command !== "env" && parsed.command !== "init") {
    // best-effort: still allow commands to run if they accept zero positional
  }

  const ctx = {
    args: parsed.positional,
    opts: parsed.opts,
    log: (m: string) => console.log(`${c.cyan("›")} ${m}`),
    warn: (m: string) => console.warn(`${c.yellow("⚠")} ${m}`),
    error: (m: string) => console.error(`${c.red("✖")} ${m}`),
  }
  await entry.run(ctx)
}

main().catch((e) => {
  error((e as Error).message)
  if (process.argv.includes("--verbose") || process.argv.includes("-v")) {
    console.error(e)
  }
  process.exit(1)
})
