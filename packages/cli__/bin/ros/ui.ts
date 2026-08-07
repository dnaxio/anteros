// Lightweight UI helpers: colors, log levels, tables.

const enabled = !process.env.NO_COLOR && process.stdout.isTTY !== false

const wrap = (open: number, close: number) => (s: string) =>
  enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s

export const c = {
  reset: wrap(0, 0),
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
}

export const log = (msg: string) => console.log(`${c.cyan("›")} ${msg}`)
export const info = (msg: string) => console.log(`${c.blue("ℹ")} ${msg}`)
export const warn = (msg: string) => console.warn(`${c.yellow("⚠")} ${msg}`)
export const error = (msg: string) => console.error(`${c.red("✖")} ${msg}`)
export const success = (msg: string) => console.log(`${c.green("✔")} ${msg}`)

export function header(title: string) {
  const line = "─".repeat(Math.max(0, 60 - title.length - 2))
  console.log(`\n${c.bold(title)} ${c.dim(line)}\n`)
}

export function table(headers: string[], rows: string[][]) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  )
  const fmt = (cells: string[]) =>
    cells.map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0)).join("  ")
  console.log(c.bold(fmt(headers)))
  console.log(c.dim(fmt(widths.map((w) => "─".repeat(w)))))
  for (const row of rows) console.log(fmt(row))
}

export function kvTable(rows: Array<[string, string]>) {
  const width = Math.max(...rows.map(([k]) => k.length))
  for (const [k, v] of rows) {
    console.log(`${c.dim(k.padEnd(width))}  ${v}`)
  }
}

export async function confirm(prompt: string, force = false): Promise<boolean> {
  if (force) return true
  if (!process.stdin.isTTY) return true
  process.stdout.write(`${c.yellow("?")} ${prompt} [y/N] `)
  for await (const chunk of Bun.stdin.stream()) {
    const line = new TextDecoder().decode(chunk).trim().toLowerCase()
    return line === "y" || line === "yes"
  }
  return false
}
