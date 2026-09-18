// `anteros dev` — run the project entrypoint with Bun's watcher.

import { relative, resolve } from "node:path"
import type { Command } from "../types.ts"
import { error, info, step } from "../ui.ts"

export const dev: Command = async ({ args, opts }) => {
  const entry = opts.entry ?? args[0] ?? "index.ts"
  const entryPath = resolve(entry)

  if (!(await Bun.file(entryPath).exists())) {
    error(`Entry file not found: ${relative(process.cwd(), entryPath) || entry}`)
    info("Create a project with `anteros create server`, or pass --entry <file>.")
    process.exit(1)
  }

  const watch = opts.watch ?? true
  const cmd = watch ? ["bun", "--watch", entryPath] : ["bun", entryPath]

  step(cmd.join(" "))

  const child = Bun.spawn(cmd, {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })

  process.exit((await child.exited) ?? 0)
}
