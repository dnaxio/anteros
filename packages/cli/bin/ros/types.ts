// Shared types for the `ros` binary

export type Driver = "docker" | "flox"
export type ServiceType = "web" | "api" | "database" | "cache" | "worker" | "cron" | "other"
export type Strategy = "rolling" | "recreate" | "blue-green" | "canary"
export type RestartPolicy = "always" | "unless-stopped" | "on-failure" | "no"

/**
 * Container resources, expressed directly as Docker flags.
 *
 * - `cpu`    : whole or fractional cores (`"0.5"`, `"1"`, `"2"`).
 *              Maps to `docker run --cpus=<value>`.
 * - `memory` : size with unit (`"256Mi"`, `"1Gi"`, `"512M"`).
 *              Maps to `docker run --memory=<value> --memory-swap=-1`
 *              (unlimited swap so the memory limit is the only cap).
 *
 * Why this format? `ros` is Docker-first, and these are the only two
 * hard resource limits Docker supports. No scheduler, no `requests`:
 * if you need fine-grained scheduling, move to Kubernetes / Nomad.
 */
export interface Resources {
  cpu?: string
  memory?: string
}

export type BuildStep =
  | { run: string; cwd?: string; env?: Record<string, string> }
  | { name: string; run: string; cwd?: string; env?: Record<string, string> }

export interface GlobalOptions {
  env?: string
  server?: string[]
  config: string
  force: boolean
  dryRun: boolean
  noColor: boolean
  verbose: boolean
}

export interface ServerTarget {
  /** raw target string, e.g. "root@192.168.30.11" or "root@host:2222" */
  raw: string
  /** parsed user (default: "root") */
  user: string
  /** parsed host */
  host: string
  /** parsed port (default: 22) */
  port: number
  /** optional logical name */
  name?: string
  /** optional tags, e.g. ["canary", "eu-west"] */
  tags?: string[]
}

export interface EnvironmentConfig {
  domain?: string
  servers: ServerTarget[]
  caddy?: CaddyRoute[]
  pods?: Record<string, PodConfig>
}

export interface CaddyRoute {
  /** Public domain (and optional port) to match. e.g. "api.example.com" or "api.example.com:8080". */
  domain: string
  /** Upstream target host (usually 127.0.0.1). */
  target: string
  /** Public listen port (default: 80). Use 443 for HTTPS, or omit to let Caddy auto-bind. */
  port?: number
  /** Upstream port to forward to. */
  upstream_port: number
  /** Whether Caddy should manage TLS for this domain. */
  tls?: "auto" | true | false
}

export interface ContainerConfig {
  name: string
  image?: string
  tag?: string
  ports?: string[]
  env?: Record<string, string>
  env_from?: Array<{ secret: string }>
  healthcheck?: string
  restart?: RestartPolicy
  /** Per-container resource limits. */
  resources?: Resources
  artifact?: ArtifactConfig
  volumes?: string[]
  command?: string[]
}

/**
 * An artifact describes WHAT to ship to the remote server and WHERE to put it.
 *
 * Exactly one source must be defined:
 *
 * - `source:`  → a local path (file or directory). Directories are
 *                transferred with `rsync`, single files with `scp`.
 *                Use `./` to ship the project root, or any subpath
 *                like `./apps/api` or `./README.md`.
 * - `repo:`    → a remote git repository. Cloned on the remote server
 *                (no local transfer). Use for shared libraries,
 *                vendored dependencies, or large repos.
 *
 * Filtering (only for `source:` directories):
 * - `include`  → force include these globs (overrides .gitignore and `exclude`)
 * - `exclude`  → skip these globs in addition to .gitignore
 * - `force`    → `--delete` to mirror the local source on the remote
 */
export interface ArtifactConfig {
  /** Local path to a file or directory (relative to the deploy.yaml). */
  source?: string
  /** Git repository to clone on the remote server. */
  repo?: {
    url: string
    ref?: string          // branch / tag / commit (default: HEAD)
    depth?: number        // --depth for clone
  }
  /** Destination directory or file path on the remote server. */
  destination: string
  include?: string[]
  exclude?: string[]
  force?: boolean
}

/**
 * A pod is a deployable unit: a typed workload (web, api, db, …) running on a
 * single driver (docker or flox), with one or more containers. The outer
 * `pods:` key in `deploy.yaml` is a map of pod name to PodConfig.
 */
export interface PodConfig {
  type: ServiceType
  driver: Driver
  instances: number
  /**
   * Default resources applied to every container of this pod. Can be
   * overridden per-container via `containers[].resources`.
   */
  resources?: Resources
  build?: {
    /**
     * Steps run on the machine where the `ros` CLI is invoked.
     * Use for code generation, asset bundling, image build, etc.
     */
    local?: { steps?: BuildStep[] }
    /**
     * Steps run on each remote server (via SSH) BEFORE sync/deploy.
     * Use for apt install, pre-flight checks, etc.
     */
    remote?: { steps?: BuildStep[] }
  }
  artifact?: ArtifactConfig
  containers: ContainerConfig[]
  depends_on?: string[]
}

export interface DeployConfig {
  version: string
  name: string
  defaults?: {
    tag?: string
    restart?: RestartPolicy
    healthcheck_grace_period?: number
  }
  deploy?: {
    tag?: string
    strategy?: Strategy
    max_unavailable?: number
    healthcheck_grace_period?: number
  }
  ssh?: {
    port: number
    key_path?: string
    timeout: number
  }
  settings?: {
    install_dir?: string
    auto_tls?: boolean
    /** Directory on the remote server where `ros` stores deployment history. */
    history_dir?: string
  }
  environments: Record<string, EnvironmentConfig>
  pods: Record<string, PodConfig>
  proxy?: {
    routes: CaddyRoute[]
  }
}

export interface ResolvedTarget {
  env: string
  server: ServerTarget
  service?: string
}

export type CommandContext = {
  args: string[]
  opts: GlobalOptions
  config?: DeployConfig
  log: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type Command = (ctx: CommandContext) => Promise<void> | void
