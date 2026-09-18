// `anteros doctor` — diagnose the local environment.
//
// Checks the runtime, the project files, the installed dependencies, the MongoDB
// target and the HTTP port, so that `anteros dev` failures are explained before
// they happen.

import { access, readFile, stat } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import type { Command } from "../types.ts"
import { c } from "../ui.ts"

/** Bun version required by @anteros/core. */
const REQUIRED_BUN = "1.3.0"
const DEFAULT_MONGO_PORT = 27017

type Status = "ok" | "warn" | "fail"

interface Check {
  label: string
  status: Status
  detail: string
  hint?: string
}

/** Values detected from `config/app.ts` and the environment. */
interface DetectedConfig {
  file: string | null
  tenant: string | null
  port: number | null
  databaseUri: string | null
  routesPrefix: string | null
}

export const doctor: Command = async () => {
  const cwd = process.cwd()
  const checks: Check[] = []

  /* ── Runtime ───────────────────────────────────────────────────────────── */

  const bunUpToDate = compareVersions(Bun.version, REQUIRED_BUN) >= 0
  checks.push({
    label: `Bun ${Bun.version}`,
    status: bunUpToDate ? "ok" : "fail",
    detail: bunUpToDate ? `>= ${REQUIRED_BUN} required` : `Bun >= ${REQUIRED_BUN} is required`,
    hint: bunUpToDate ? undefined : "bun upgrade",
  })

  /* ── Project files ─────────────────────────────────────────────────────── */

  const packageJson = await readJson<{ name?: string; dependencies?: Record<string, string> }>(
    join(cwd, "package.json"),
  )

  checks.push(
    packageJson
      ? { label: "package.json", status: "ok", detail: packageJson.name ?? "(unnamed)" }
      : {
          label: "package.json",
          status: "fail",
          detail: "not found in the current directory",
          hint: "run `anteros doctor` from the project root",
        },
  )

  const hasCoreDependency = Boolean(packageJson?.dependencies?.["@anteros/core"])
  if (packageJson) {
    checks.push({
      label: "@anteros/core dependency",
      status: hasCoreDependency ? "ok" : "warn",
      detail: hasCoreDependency
        ? (packageJson.dependencies!["@anteros/core"] as string)
        : "not declared in package.json",
      hint: hasCoreDependency ? undefined : "bun add @anteros/core",
    })
  }

  const corePackage = await readJson<{ version?: string }>(
    join(cwd, "node_modules", "@anteros", "core", "package.json"),
  )
  checks.push({
    label: "@anteros/core installed",
    status: corePackage ? "ok" : "warn",
    detail: corePackage ? `version ${corePackage.version ?? "unknown"}` : "node_modules/@anteros/core is missing",
    hint: corePackage ? undefined : "bun install",
  })

  const hasEntry = await isFile(join(cwd, "index.ts"))
  checks.push({
    label: "index.ts",
    status: hasEntry ? "ok" : "warn",
    detail: hasEntry ? "entrypoint found" : "not found at the project root",
    hint: hasEntry ? undefined : "create it with `anteros create server`",
  })

  const config = await detectConfig(cwd)
  checks.push(
    config.file
      ? {
          label: "config/app.ts",
          status: "ok",
          detail: [
            config.tenant ? `tenant "${config.tenant}"` : null,
            config.port ? `port ${config.port}` : null,
            config.routesPrefix ? `routes ${config.routesPrefix}` : null,
          ]
            .filter(Boolean)
            .join(", ") || "found",
        }
      : {
          label: "config/app.ts",
          status: "warn",
          detail: "not found",
          hint: "boot options can also live in index.ts",
        },
  )

  const envFile = await isFile(join(cwd, ".env"))
  const hasEnvExample = await isFile(join(cwd, ".env.example"))
  if (envFile || hasEnvExample) {
    checks.push({
      label: ".env",
      status: envFile ? "ok" : "warn",
      detail: envFile ? "found" : ".env.example is present but .env is not",
      hint: envFile ? undefined : "cp .env.example .env",
    })
  }

  /* ── Environment ───────────────────────────────────────────────────────── */

  const envFileValues = envFile ? parseEnv(await readFile(join(cwd, ".env"), "utf8")) : {}

  const databaseUri =
    Bun.env.MONGODB_URI ?? envFileValues.MONGODB_URI ?? config.databaseUri ?? null
  const mongoCheck = await checkMongo(databaseUri)
  checks.push(mongoCheck)

  const port = Number(Bun.env.PORT ?? envFileValues.PORT ?? config.port ?? 4000)
  checks.push(await checkPort(port))

  const writable = await access(cwd, constants.W_OK).then(
    () => true,
    () => false,
  )
  checks.push({
    label: "project directory writable",
    status: writable ? "ok" : "fail",
    detail: writable ? cwd : `cannot write to ${cwd}`,
    hint: writable ? undefined : "the server writes logs to .logs/ and uploads to storage/",
  })

  /* ── Report ────────────────────────────────────────────────────────────── */

  console.log()
  const icons: Record<Status, string> = { ok: c.green("✔"), warn: c.yellow("⚠"), fail: c.red("✖") }
  const width = Math.max(...checks.map((check) => check.label.length))

  for (const check of checks) {
    console.log(`  ${icons[check.status]} ${c.bold(check.label.padEnd(width))}  ${check.detail}`)
    if (check.hint) console.log(`    ${" ".repeat(width)}  ${c.dim(`→ ${check.hint}`)}`)
  }

  const failures = checks.filter((check) => check.status === "fail")
  const warnings = checks.filter((check) => check.status === "warn")

  console.log()
  if (failures.length === 0 && warnings.length === 0) {
    console.log(`  ${c.green("Environment looks good.")}`)
  } else {
    console.log(
      `  ${failures.length} error${failures.length === 1 ? "" : "s"}, ` +
        `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
    )
  }
  console.log()

  if (failures.length > 0) process.exit(1)
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

async function checkMongo(uri: string | null): Promise<Check> {
  if (!uri) {
    return {
      label: "MongoDB",
      status: "warn",
      detail: "no connection string found",
      hint: "set MONGODB_URI in .env or the database.uri in config/app.ts",
    }
  }

  const target = parseMongoTarget(uri)
  if (!target) {
    return { label: "MongoDB", status: "warn", detail: `cannot parse "${uri}"`, hint: "check the URI format" }
  }

  const reachable = await probeTcp(target.host, target.port)
  return {
    label: "MongoDB",
    status: reachable ? "ok" : "fail",
    detail: reachable
      ? `reachable at ${target.host}:${target.port}`
      : `unreachable at ${target.host}:${target.port}`,
    hint: reachable
      ? undefined
      : target.srv
        ? "check the cluster's IP allowlist and your network"
        : "start MongoDB (e.g. `docker run -d -p 27017:27017 mongo:7`) or point MONGODB_URI elsewhere",
  }
}

async function checkPort(port: number): Promise<Check> {
  const busy = await probeTcp("127.0.0.1", port)
  return {
    label: `port ${port}`,
    status: busy ? "warn" : "ok",
    detail: busy ? `already in use on 127.0.0.1` : "free",
    hint: busy ? "stop the process using it, or run the server with PORT=<other>" : undefined,
  }
}

/** Resolve `mongodb://…` and `mongodb+srv://…` connection strings to a TCP target. */
function parseMongoTarget(uri: string): { host: string; port: number; srv: boolean } | null {
  try {
    const url = new URL(uri)
    const host = url.hostname
    if (!host) return null
    const srv = url.protocol === "mongodb+srv:"
    const port = url.port ? Number(url.port) : DEFAULT_MONGO_PORT
    return { host, port, srv }
  } catch {
    return null
  }
}

/** TCP probe with a timeout — resolves `false` when nothing answers. */
async function probeTcp(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false

    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => finish(false), timeoutMs)

    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          socket.end()
          finish(true)
        },
        data() {},
        close() {},
        error() {
          finish(false)
        },
      },
    }).catch(() => finish(false))
  })
}

async function detectConfig(cwd: string): Promise<DetectedConfig> {
  const path = join(cwd, "config", "app.ts")
  if (!(await isFile(path))) {
    return { file: null, tenant: null, port: null, databaseUri: null, routesPrefix: null }
  }

  const source = await readFile(path, "utf8")
  const port = source.match(/\bport:\s*(?:Number\([^)]*?\?\?\s*)?(\d{2,5})/)
  const uri = source.match(/\buri:\s*(?:Bun\.env\.\w+\s*\?\?\s*)?"([^"]+)"/)
  const tenant = source.match(/\bdir:\s*"([^"]+)"/)
  const prefix = source.match(/\bprefix:\s*"([^"]+)"/)

  return {
    file: path,
    tenant: tenant?.[1] ?? null,
    port: port?.[1] ? Number(port[1]) : null,
    databaseUri: uri?.[1] ?? null,
    routesPrefix: prefix?.[1] ?? null,
  }
}

function parseEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {}

  for (const line of source.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const equals = trimmed.indexOf("=")
    if (equals === -1) continue
    const key = trimmed.slice(0, equals).trim()
    const value = trimmed.slice(equals + 1).trim().replace(/^["']|["']$/g, "")
    if (key) values[key] = value
  }

  return values
}

async function isFile(path: string): Promise<boolean> {
  return stat(path)
    .then((stats) => stats.isFile())
    .catch(() => false)
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return (await Bun.file(path).json()) as T
  } catch {
    return null
  }
}

/** Compare dotted versions: `1` when `a > b`, `-1` when `a < b`, `0` when equal. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l > r ? 1 : -1
  }

  return 0
}
