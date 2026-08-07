// Shared types for the `ros` binary

export type Driver = "docker" | "flox"
export type ServiceType = "web" | "api" | "database" | "cache" | "worker" | "cron" | "other"
export type Strategy = "rolling" | "recreate" | "blue-green" | "canary"
export type RestartPolicy = "always" | "unless-stopped" | "on-failure" | "no"

export interface WebhookTarget {
  url: string
  headers?: Record<string, string>
  secret?: string
}

export type MetricsTarget = WebhookTarget

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
  raw: string
  user: string
  host: string
  port: number
  name?: string
  tags?: string[]
}

export interface EnvironmentConfig {
  domain?: string
  servers: ServerTarget[]
  caddy?: CaddyRoute[]
  pods?: Record<string, PodConfig>
}

export interface CaddyRoute {
  domain: string
  target: string
  port?: number
  upstream_port: number
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
  resources?: Resources
  artifact?: ArtifactConfig
  volumes?: string[]
  command?: string[]
}

/**
 * Alert filter type.
 * - `health`, `stopped`, `oom` — container only (source is always "container")
 * - `cpu`, `mem`, `disk` — source must be "host" or "container"
 */
export type AlertFilterType =
  | "health"
  | "cpu"
  | "mem"
  | "disk"
  | "stopped"
  | "oom"

/** A single alert filter. Evaluated on every cron tick. */
export interface AlertFilter {
  name: string
  type: AlertFilterType
  /** "host" or "container". Required for cpu/mem/disk. Defaults to "container" for health/stopped/oom. */
  source?: "host" | "container"
  /** Threshold in %. Fires when usage > threshold. */
  threshold?: number
  /** Minimum duration condition must hold before firing. E.g. "5m". */
  duration?: string
  /** Container name glob (source=container). */
  container?: string
  /** Mount point for disk (e.g. "/", "/var"). All mounts if omitted. */
  mount?: string
  enabled?: boolean
}

export interface ArtifactConfig {
  source?: string
  repo?: {
    url: string
    ref?: string
    depth?: number
  }
  destination: string
  include?: string[]
  exclude?: string[]
  force?: boolean
}

export interface PodConfig {
  type: ServiceType
  driver: Driver
  instances: number
  resources?: Resources
  build?: {
    local?: { steps?: BuildStep[] }
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
    history_dir?: string
    audit?: {
      url: string | WebhookTarget
      events?: string[]
    }
    alerts?: {
      schedule?: string
      email?: string
      webhook?: string | WebhookTarget
      filters?: AlertFilter[]
    }
    metrics?: {
      schedule?: string
      endpoint: string | MetricsTarget
      include_host?: boolean
      include_disk?: boolean
      include_containers?: boolean
      include_system?: boolean
      system?: ("os" | "cpu" | "mem" | "hostname" | "uptime" | "docker")[]
      labels?: Record<string, string>
    }
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
