// `anteros create <template> [name]` — scaffold a new Anteros project.
//
//   anteros create server                 # asks for a project name
//   anteros create server my-api          # -> ./my-api
//   anteros create my-api                 # default template
//   anteros create server my-api -d apps/api

import { mkdir, readdir, stat } from "node:fs/promises"
import { basename, relative, resolve } from "node:path"
import type { Command, PackageManager } from "../types.ts"
import {
  error as fail,
  fileTree,
  info,
  isInteractive,
  keyValues,
  nextSteps,
  promptConfirm,
  promptText,
  step,
  success,
  warn,
} from "../ui.ts"
import {
  defaultDatabaseUri,
  isValidTenant,
  listTemplates,
  planTemplate,
  toPackageName,
  writeScaffold,
  type ScaffoldVars,
  type TemplateInfo,
} from "../templates.ts"

const DEFAULT_TENANT = "v1"
const DEFAULT_PORT = 4000
/** Version requested for `@anteros/core` in the generated package.json. */
const CORE_VERSION = "latest"

export const create: Command = async ({ args, opts, log }) => {
  const templates = await listTemplates()
  if (templates.length === 0) {
    fail("No templates found in this build of @anteros/cli.")
    process.exit(1)
  }

  /* ── Template + project name ───────────────────────────────────────────── */

  const [first, second] = args
  const named = first ? templates.find((template) => template.name === first) : undefined

  let template: TemplateInfo
  let name: string

  if (named) {
    template = named
    name = second ?? ""
  } else if (first && args.length > 1) {
    fail(`Unknown template: ${first}`)
    info(`Available templates: ${templates.map((t) => t.name).join(", ")}`)
    process.exit(1)
  } else {
    // `anteros create` / `anteros create my-api` → the default template
    template = templates.length === 1 ? templates[0]! : await pickTemplate(templates)
    name = first ?? ""
  }

  const interactive = isInteractive() && !opts.yes

  /* ── Target directory ──────────────────────────────────────────────────── */

  let targetDir = opts.dir ? resolve(opts.dir) : ""

  if (!targetDir) {
    if (!name && interactive) name = await promptText("Project name", "anteros-server")
    if (!name) name = "anteros-server"
    targetDir = resolve(name)
  } else if (!name) {
    name = basename(targetDir)
  }

  const packageName = toPackageName(name)

  if (await isDirectory(targetDir)) {
    const entries = (await readdir(targetDir)).filter((entry) => entry !== ".DS_Store")
    if (entries.length > 0 && !opts.force) {
      fail(`Directory is not empty: ${display(targetDir)}`)
      info("Choose another name, or pass --force to write into it anyway.")
      process.exit(1)
    }
  }

  /* ── Project options ───────────────────────────────────────────────────── */

  let tenant = opts.tenant ?? ""
  if (!tenant) {
    tenant = interactive ? await promptText("Tenant id (folder)", DEFAULT_TENANT) : DEFAULT_TENANT
  }
  if (!isValidTenant(tenant)) {
    fail(`Invalid tenant id: "${tenant}" — use letters, digits, "-" or "_".`)
    process.exit(1)
  }

  let port = opts.port
  if (port === undefined) {
    const answer = interactive ? await promptText("HTTP port", String(DEFAULT_PORT)) : String(DEFAULT_PORT)
    port = Number(answer)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`Invalid port: "${port}"`)
    process.exit(1)
  }

  const fallbackUri = defaultDatabaseUri(packageName)
  let databaseUri = opts.mongo ?? ""
  if (!databaseUri) {
    databaseUri = interactive ? await promptText("MongoDB URI", fallbackUri) : fallbackUri
  }

  const pm: PackageManager = opts.pm ?? "bun"
  const shouldInstall =
    opts.install ??
    (interactive ? await promptConfirm(`Install dependencies with ${pm}?`, true) : opts.yes)

  const shouldInitGit =
    opts.git ?? (interactive ? await promptConfirm("Initialize a git repository?", false) : false)

  /* ── Scaffold ──────────────────────────────────────────────────────────── */

  const vars: ScaffoldVars = { name, packageName, tenant, port, databaseUri, coreVersion: CORE_VERSION }
  const projectDir = display(targetDir)

  log(`Creating ${packageName} from the "${template.name}" template`)

  const plan = await planTemplate(template, vars)
  await mkdir(targetDir, { recursive: true })
  const written = await writeScaffold(targetDir, plan)

  if (shouldInstall) {
    step(`Installing dependencies with ${pm}…`)
    const installed = await run([pm, "install"], targetDir)
    if (!installed) {
      warn(`\`${pm} install\` failed — run it again inside ${projectDir} once the cause is fixed.`)
    }
  }

  if (shouldInitGit) {
    step("Initializing a git repository…")
    const initialized =
      (await run(["git", "init", "-q", "-b", "main"], targetDir)) ||
      (await run(["git", "init", "-q"], targetDir))
    if (!initialized) warn("`git init` failed — initialize the repository manually.")
  }

  /* ── Report ────────────────────────────────────────────────────────────── */

  success(`Created ${packageName} in ${projectDir}`)
  console.log()
  fileTree(written, projectDir)

  const steps: Array<[string, string]> = []
  if (!shouldInstall) steps.push(["install", `cd ${projectDir} && ${pm} install`])
  steps.push(["env", "cp .env.example .env  (adjust MONGODB_URI / JWT_SECRET)"])
  steps.push(["run", "bun run dev"])

  nextSteps("Next steps", steps)

  keyValues([
    ["API", `POST http://localhost:${port}/api/${tenant}/collections/items/:action`],
    ["Route", `GET  http://localhost:${port}/api/v1/healthz`],
    ["MCP", `http://localhost:${port}/api/${tenant}/mcp`],
  ])
  console.log()
}

async function pickTemplate(templates: TemplateInfo[]): Promise<TemplateInfo> {
  const answer = await promptText(
    `Which template? ${templates.map((template, index) => `${index + 1}) ${template.name}`).join("  ")}`,
    templates[0]!.name,
  )

  const index = Number(answer) - 1
  if (Number.isInteger(index) && templates[index]) return templates[index]!
  return templates.find((template) => template.name === answer) ?? templates[0]!
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path)
    .then((stats) => stats.isDirectory())
    .catch(() => false)
}

/** Path relative to the current directory (absolute when outside of it). */
function display(path: string): string {
  const relativePath = relative(process.cwd(), path)
  if (!relativePath) return "."
  if (relativePath.startsWith("..")) return path
  return relativePath
}

async function run(cmd: string[], cwd: string): Promise<boolean> {
  try {
    const child = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" })
    return (await child.exited) === 0
  } catch {
    return false
  }
}
