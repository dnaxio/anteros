/**
 * What a process actually runs.
 *
 * `api: false` disables everything the HTTP server carries — routes, services,
 * MCP tools, middlewares, websockets — and the scripts that run alongside it.
 */
export type BootCapabilities = {
    /** HTTP server: routes, services, MCP tools, middlewares, `/health` */
    api: boolean
    /** Replication engine: schedule, tombstones, `_replication_` state */
    replication: boolean
    /** `runScripts()` shortly after boot */
    scripts: boolean
    /** Socket.IO handlers and the `/socket.io/` endpoint */
    sockets: boolean
}

/**
 * Named boot modes (configurable through `server.mode`, overridable by flags).
 *
 * - `full` (default): everything.
 * - `replication-only`: replication engine only — no API at all.
 * - `no-replication`: full server that never starts the replication engine.
 * - `api-only`: the HTTP API and nothing around it (no replication, no scripts, no sockets).
 */
export type BootMode = 'full' | 'replication-only' | 'no-replication' | 'api-only'

export type BootFlags = {
    /** `--replication-only` — replication engine only, no API */
    replicationOnly: boolean
    /** `--no-replication` — full server, replication engine not started */
    noReplication: boolean
    /** `--api-only` — the HTTP API and nothing around it */
    apiOnly: boolean
    /** `--no-scripts` — never run the tenant scripts (`*.run.ts` under `scripts/`) */
    noScripts: boolean
    /** `--no-sockets` — no Socket.IO handlers, no `/socket.io/` endpoint */
    noSockets: boolean
}

export const FULL_CAPABILITIES: BootCapabilities = {
    api: true,
    replication: true,
    scripts: true,
    sockets: true,
}

const REPLICATION_ONLY: BootCapabilities = {
    api: false,
    replication: true,
    scripts: false,
    sockets: false,
}

const API_ONLY: BootCapabilities = {
    api: true,
    replication: false,
    scripts: false,
    sockets: false,
}

function bootModeCapabilities(mode?: BootMode): BootCapabilities {
    switch (mode) {
        case 'replication-only': return { ...REPLICATION_ONLY }
        case 'api-only': return { ...API_ONLY }
        case 'no-replication': return { ...FULL_CAPABILITIES, replication: false }
        default: return { ...FULL_CAPABILITIES }
    }
}

/**
 * Read the boot flags from the command line (camelCase spellings accepted).
 *
 * @example bun index.ts --replication-only
 * @example bun index.ts --api-only
 * @example bun index.ts --no-scripts --no-sockets
 */
function parseBootFlags(argv: string[] = process.argv): BootFlags {
    const has = (...names: string[]) => names.some((name) => argv.includes(name))
    return {
        replicationOnly: has('--replication-only', '--replicationOnly'),
        noReplication: has('--no-replication', '--noReplication'),
        apiOnly: has('--api-only', '--apiOnly'),
        noScripts: has('--no-scripts', '--noScripts'),
        noSockets: has('--no-sockets', '--noSockets'),
    }
}

/** True when the flags ask for contradictory things — worth warning the operator */
function conflictingBootFlags(flags: BootFlags): boolean {
    return flags.replicationOnly && (flags.noReplication || flags.apiOnly)
}

/**
 * What the process will run: `server.mode` first, then the flags, which win.
 * `--api-only` is the preset "API and nothing around it".
 */
function resolveCapabilities(flags: BootFlags, configured?: BootMode): BootCapabilities {
    // A flag always wins over the configured mode
    if (flags.replicationOnly) return { ...REPLICATION_ONLY }
    if (flags.apiOnly) return { ...API_ONLY }

    const caps = bootModeCapabilities(configured)
    if (flags.noReplication) caps.replication = false
    if (flags.noScripts) caps.scripts = false
    if (flags.noSockets) caps.sockets = false

    // Scripts and sockets belong to the API process
    if (!caps.api) {
        caps.scripts = false
        caps.sockets = false
    }

    return caps
}

/** Disabled capabilities, for the banner and logs — e.g. `['scripts', 'sockets']` */
function offCapabilities(caps: BootCapabilities): (keyof BootCapabilities)[] {
    return (Object.keys(caps) as (keyof BootCapabilities)[]).filter((key) => !caps[key])
}

/** Closest named mode, used by the banner — all flags off is simply `full` */
function capabilitiesLabel(caps: BootCapabilities): BootMode {
    if (!caps.api && caps.replication) return 'replication-only'
    if (caps.api && !caps.replication && !caps.scripts && !caps.sockets) return 'api-only'
    // `--no-scripts` / `--no-sockets` alone stay in `full`: the banner lists what is off
    return 'full'
}

export {
    parseBootFlags,
    conflictingBootFlags,
    resolveCapabilities,
    offCapabilities,
    capabilitiesLabel,
}
