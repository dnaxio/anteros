// Lightweight UI helpers for the `anteros` binary: colors, logs, prompts, trees.
// No external dependencies.

let colorEnabled = !process.env.NO_COLOR && process.stdout.isTTY !== false

/** Toggle colors (driven by `--no-color`). */
export function setColorEnabled(enabled: boolean) {
  colorEnabled = enabled
}

/** True when both stdin and stdout are TTYs — i.e. prompts are safe. */
export function isInteractive() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

const wrap = (open: number, close: number) => (s: string) =>
  colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : s

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
export const step = (msg: string) => console.log(`${c.cyan("→")} ${msg}`)
export const info = (msg: string) => console.log(`${c.blue("ℹ")} ${msg}`)
export const warn = (msg: string) => console.warn(`${c.yellow("⚠")} ${msg}`)
export const error = (msg: string) => console.error(`${c.red("✖")} ${msg}`)
export const success = (msg: string) => console.log(`${c.green("✔")} ${msg}`)

/** Render a `key: value` block, aligned on the widest key. */
export function keyValues(rows: Array<[string, string]>) {
  if (rows.length === 0) return
  const width = Math.max(...rows.map(([k]) => k.length))
  for (const [k, v] of rows) console.log(`  ${c.dim(k.padEnd(width))}  ${v}`)
}

/** Render a file tree from slash-separated relative paths. */
export function fileTree(paths: string[], root = "") {
  type Node = { name: string; children: Map<string, Node> }
  const tree: Node = { name: root, children: new Map() }

  for (const path of [...paths].sort()) {
    let node = tree
    for (const part of path.split("/")) {
      let child = node.children.get(part)
      if (!child) {
        child = { name: part, children: new Map() }
        node.children.set(part, child)
      }
      node = child
    }
  }

  if (root) console.log(`  ${c.bold(root)}`)

  const walk = (node: Node, prefix: string) => {
    const children = [...node.children.values()]
    children.forEach((child, index) => {
      const last = index === children.length - 1
      const isDirectory = child.children.size > 0
      const label = isDirectory ? c.blue(child.name) : child.name
      console.log(`  ${prefix}${last ? "└── " : "├── "}${label}`)
      walk(child, prefix + (last ? "    " : "│   "))
    })
  }

  walk(tree, "")
}

/** Print a "next steps" block. */
export function nextSteps(title: string, rows: Array<[string, string]>) {
  console.log()
  console.log(c.bold(`${title}:`))
  keyValues(rows)
  console.log()
}

async function readLine(): Promise<string> {
  // Bun reads a TTY line at a time
  for await (const chunk of Bun.stdin.stream()) {
    return new TextDecoder().decode(chunk).split("\n")[0]!.trim()
  }
  return ""
}

/** Ask for free text. Returns `defaultValue` when not interactive. */
export async function promptText(question: string, defaultValue = ""): Promise<string> {
  if (!isInteractive()) return defaultValue
  const hint = defaultValue ? c.dim(` (${defaultValue})`) : ""
  process.stdout.write(`${c.cyan("?")} ${question}${hint} `)
  const answer = await readLine()
  return answer || defaultValue
}

/** Yes/no question. Returns `defaultValue` when not interactive. */
export async function promptConfirm(question: string, defaultValue = true): Promise<boolean> {
  if (!isInteractive()) return defaultValue
  const hint = defaultValue ? "Y/n" : "y/N"
  process.stdout.write(`${c.cyan("?")} ${question} ${c.dim(`(${hint})`)} `)
  const answer = (await readLine()).toLowerCase()
  if (!answer) return defaultValue
  return answer === "y" || answer === "yes"
}
