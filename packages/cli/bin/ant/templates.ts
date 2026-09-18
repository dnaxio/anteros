// Template discovery + scaffolding engine for `anteros create`.
//
// A template is a directory under `templates/` containing a `template.json`
// manifest and the files to copy. Two conventions make the files safe to ship
// inside an npm package and easy to read in a diff:
//
//   1. Files whose name must start with a dot are stored with a leading `_`
//      (`_gitignore` → `.gitignore`, `_env.example` → `.env.example`).
//   2. The tenant folder declared in the manifest (`v1`) is renamed to the
//      tenant requested on the command line, everywhere in the tree.

import { Glob } from "bun"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

const TEMPLATES_DIR = join(import.meta.dir, "..", "..", "templates")
const MANIFEST = "template.json"
const IGNORED = new Set([MANIFEST, ".DS_Store"])

export interface TemplateInfo {
  /** Template name, e.g. `server`. */
  name: string
  /** One-line description shown in `--help` and prompts. */
  description: string
  /** Tenant folder used by the template files, e.g. `v1`. */
  tenant: string
  /** Absolute path of the template directory. */
  path: string
}

/** Values substituted into `{{placeholders}}`. */
export interface ScaffoldVars {
  /** Project name as typed by the user. */
  name: string
  /** npm-safe project name. */
  packageName: string
  /** Tenant id / folder. */
  tenant: string
  /** HTTP port. */
  port: number
  /** MongoDB connection string. */
  databaseUri: string
  /** Version range written for `@anteros/core`. */
  coreVersion: string
}

export interface ScaffoldFile {
  /** Path relative to the project root, slash-separated. */
  path: string
  content: string
}

export async function listTemplates(): Promise<TemplateInfo[]> {
  const glob = new Glob(`*/${MANIFEST}`)
  const templates: TemplateInfo[] = []

  for await (const file of glob.scan({ cwd: TEMPLATES_DIR, dot: true })) {
    const path = join(TEMPLATES_DIR, dirname(file))
    const manifest = (await Bun.file(join(path, MANIFEST)).json()) as {
      name?: string
      description?: string
      tenant?: string
    }
    const directory = dirname(file)

    templates.push({
      name: manifest.name ?? directory,
      description: manifest.description ?? "",
      tenant: manifest.tenant ?? "v1",
      path,
    })
  }

  return templates.sort((a, b) => a.name.localeCompare(b.name))
}

/** Turn a user-supplied name into a valid npm package name. */
export function toPackageName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+/, "")
    .replace(/[-._]+$/, "")

  return slug || "anteros-server"
}

/** Default MongoDB database name for a project. */
export function defaultDatabaseUri(packageName: string): string {
  return `mongodb://localhost:27017/${packageName}`
}

/** Validate a tenant id: safe as a folder name and as a URL segment. */
export function isValidTenant(tenant: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(tenant)
}

/** Build the full file plan: paths resolved, placeholders rendered. */
export async function planTemplate(
  template: TemplateInfo,
  vars: ScaffoldVars,
): Promise<ScaffoldFile[]> {
  const glob = new Glob("**/*")
  const files: ScaffoldFile[] = []

  for await (const relative of glob.scan({ cwd: template.path, dot: true })) {
    const segments = relative.split("/")
    if (segments.some((segment) => IGNORED.has(segment) || segment === "node_modules")) continue

    const source = Bun.file(join(template.path, relative))
    if (!(await source.exists())) continue

    files.push({
      path: targetPath(relative, template.tenant, vars.tenant),
      content: render(await source.text(), vars),
    })
  }

  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** `_gitignore` → `.gitignore`, `v1/routes/x.ts` → `<tenant>/routes/x.ts`. */
function targetPath(relative: string, templateTenant: string, tenant: string): string {
  return relative
    .split("/")
    .map((segment) => {
      const named = segment.startsWith("_") ? `.${segment.slice(1)}` : segment
      return named === templateTenant ? tenant : named
    })
    .join("/")
}

/** Substitute `{{placeholder}}` values and fail loudly on a typo. */
export function render(content: string, vars: ScaffoldVars): string {
  return content.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = (vars as unknown as Record<string, unknown>)[key]
    if (value === undefined) throw new Error(`Unknown template placeholder: {{${key}}}`)
    return String(value)
  })
}

/** Write a plan to disk. Returns the created paths, relative to `targetDir`. */
export async function writeScaffold(targetDir: string, files: ScaffoldFile[]): Promise<string[]> {
  const written: string[] = []

  for (const file of files) {
    const absolute = join(targetDir, file.path)
    await mkdir(dirname(absolute), { recursive: true })
    await Bun.write(absolute, file.content)
    written.push(file.path)
  }

  return written
}
