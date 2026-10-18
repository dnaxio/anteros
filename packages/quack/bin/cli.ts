#!/usr/bin/env bun
// `antq` — the @anteros/quack CLI.
//
//   antq start --dbPath ./data/analytics.duckdb --port 9494 --token super-secret
//
// One command, because the package does one thing: run a Quack server. The CLI is
// standalone: it drives DuckDB through `@duckdb/node-api`, not through the
// `@anteros/duckdb` library.

import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

// ─── Options ──────────────────────────────────────────────────────────────

type OptionSpec = {
    /** Canonical name, as the flag spells it. */
    key: string;
    type: "string" | "number" | "boolean";
    help: string;
};

const OPTIONS: OptionSpec[] = [
    { key: "quack", type: "boolean", help: "Serve over the Quack protocol (the mode — today the only one)" },
    { key: "dbPath", type: "string", help: "DuckDB file to serve (default: in memory — nothing is persisted)" },
    { key: "port", type: "number", help: "Port to listen on (default 9494)" },
    { key: "host", type: "string", help: "Interface to bind (default 127.0.0.1)" },
    { key: "token", type: "string", help: "Secret clients present (or QUACK_TOKEN / DUCKDB_QUACK_TOKEN)" },
    { key: "allowOtherHostname", type: "boolean", help: "Accept a non-localhost Host header — required for a remote client" },
    { key: "disableSsl", type: "boolean", help: "Serve plain HTTP instead of TLS" },
    { key: "threads", type: "number", help: "DuckDB threads of the server instance" },
    { key: "fetchBatchChunks", type: "number", help: "DataChunks per FETCH response (default 12)" },
    { key: "name", type: "string", help: "Node name advertised by whoami()" },
    { key: "region", type: "string", help: "Node region advertised by whoami()" },
    { key: "provider", type: "string", help: "Node provider advertised by whoami()" },
    { key: "hostname", type: "string", help: "Node hostname advertised by whoami()" },
    { key: "printToken", type: "boolean", help: "Show the token in the banner (masked by default)" },
    { key: "help", type: "boolean", help: "Show this help" },
    { key: "version", type: "boolean", help: "Show the package version" },
];

/** `--dbPath`, `--db-path` and `--DBPATH` are the same option. */
function normalise(name: string): string {
    return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const BY_NAME = new Map(OPTIONS.map((option) => [normalise(option.key), option]));

class CliError extends Error {}

// ─── Parsing ──────────────────────────────────────────────────────────────

type Parsed = { command?: string; flags: Record<string, any> };

function parse(argv: string[]): Parsed {
    const flags: Record<string, any> = {};
    let command: string | undefined;

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]!;

        if (!arg.startsWith("-")) {
            if (command === undefined) command = arg;
            else throw new CliError(`Unexpected argument '${arg}'`);
            continue;
        }

        const stripped = arg.replace(/^-+/, "");
        const equals = stripped.indexOf("=");
        const name = equals === -1 ? stripped : stripped.slice(0, equals);
        const inline = equals === -1 ? undefined : stripped.slice(equals + 1);

        const spec = BY_NAME.get(normalise(name));
        if (!spec) throw new CliError(`Unknown option '${arg}'`);

        if (spec.type === "boolean") {
            flags[spec.key] = inline === undefined ? true : inline !== "false";
            continue;
        }

        const value = inline ?? argv[++index];
        if (value === undefined) throw new CliError(`Option '${arg}' expects a value`);

        if (spec.type === "number") {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) throw new CliError(`Option '${arg}' expects a number, got '${value}'`);
            flags[spec.key] = parsed;
        } else {
            flags[spec.key] = value;
        }
    }

    return { command, flags };
}

const USAGE = `antq — a DuckDB instance served over the Quack protocol

Usage:
  antq start [options]

Options:
${OPTIONS.map((option) => `  --${option.key}${option.type === "boolean" ? "" : " <value>"}`.padEnd(30) + option.help).join("\n")}

Examples:
  antq start --quack --token super-secret
  antq start --dbPath ./data/analytics.duckdb --port 9494 --token super-secret
  antq start --host 0.0.0.0 --allowOtherHostname --token super-secret
`;

// ─── Version ──────────────────────────────────────────────────────────────

async function version(): Promise<string> {
    const manifest = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as { version?: string };
    return manifest.version ?? "0.0.0";
}

// ─── start ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 9494;

/** A SQL string literal — quoted and escaped. */
function quote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function firstLine(message: unknown): string {
    return String(message ?? "").split("\n")[0]!.trim();
}

function masked(token: string): string {
    return `${"*".repeat(Math.min(token.length, 8))} (${token.length} characters)`;
}

function banner(url: string, dbPath: string | undefined, token: string, showToken: boolean, mode: Mode): string {
    const where = dbPath ?? "in memory (nothing is persisted)";
    return [
        "",
        "  @anteros/quack — serving",
        `    mode     ${mode}`,
        `    url      ${url}`,
        `    db       ${where}`,
        `    token    ${showToken ? token : masked(token)}`,
        `    pid      ${process.pid}`,
        "",
        "  Attach from another process:",
        `    new DuckdbQuackInstance({ url: '${url}', token: '…' })   // @anteros/duckdb`,
        "",
        "  Ctrl-C to stop.",
        "",
    ].join("\n");
}

/** The serving modes. Quack is the only one — the flag makes that explicit. */
const MODES = ["quack"] as const;
type Mode = (typeof MODES)[number];

/**
 * Which mode to serve in. `--quack` states it, and it is the default, so the
 * flag is optional — but asking for *no* mode (`--quack=false`) fails loudly
 * rather than silently serving something the caller did not ask for.
 */
function resolveMode(flags: Record<string, any>): Mode {
    if (flags.quack === false) {
        throw new CliError("Quack is the only serving mode — drop `--quack=false` (the flag is only there to be explicit)");
    }
    return "quack";
}

/** Release both handles, without letting a close failure mask the real error. */
function closeQuietly(connection: DuckDBConnection, instance: DuckDBInstance): void {
    try {
        connection.closeSync();
    } catch {
        // Already gone.
    }
    try {
        instance.closeSync();
    } catch {
        // Already gone.
    }
}

async function start(flags: Record<string, any>): Promise<void> {
    const mode = resolveMode(flags);

    const token = flags.token ?? Bun.env.QUACK_TOKEN ?? Bun.env.DUCKDB_QUACK_TOKEN;
    if (!token) {
        throw new CliError("A token is required — pass --token, or set QUACK_TOKEN");
    }
    // Quack's own rule, checked here so the failure names the cause instead of
    // surfacing from `quack_serve` with no context.
    const secret = String(token).trim();
    if (secret.length < 4) {
        throw new CliError("A Quack server token must be at least 4 characters — DuckDB refuses anything shorter");
    }

    const host = flags.host ?? "127.0.0.1";
    const port = flags.port ?? DEFAULT_PORT;
    const url = `quack:${host}:${port}`;

    let instance: DuckDBInstance;
    try {
        const options = flags.threads !== undefined ? { threads: String(flags.threads) } : undefined;
        instance = await DuckDBInstance.create(flags.dbPath, options);
    } catch (err: any) {
        throw new CliError(`Cannot open DuckDB — ${firstLine(err?.message ?? err)}`);
    }
    const connection = await instance.connect();

    try {
        // Settings first: they are what `quack_serve` then honours.
        if (flags.fetchBatchChunks !== undefined) {
            await connection.run(`SET GLOBAL quack_fetch_batch_chunks = ${Number(flags.fetchBatchChunks)}`);
        }
        const identity = { name: flags.name, region: flags.region, provider: flags.provider, hostname: flags.hostname };
        const named = Object.entries(identity)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key} := ${quote(String(value))}`);
        if (named.length) await connection.run(`CALL quack_identify(${named.join(", ")})`);

        // Named arguments: `quack_serve(uri, token := …, allow_other_hostname := …, disable_ssl := …)`.
        await connection.run(
            `CALL quack_serve(${[
                quote(url),
                `token := ${quote(secret)}`,
                `allow_other_hostname := ${flags.allowOtherHostname === true}`,
                `disable_ssl := ${flags.disableSsl === true}`,
            ].join(", ")})`,
        );
    } catch (err: any) {
        closeQuietly(connection, instance);
        throw new CliError(`Cannot start the Quack server on ${url} — ${firstLine(err?.message ?? err)}`);
    }

    console.log(banner(url, flags.dbPath, secret, flags.printToken === true, mode));

    // Nothing else keeps the event loop alive: the Quack listener is a native
    // thread, invisible to Bun's scheduler.
    const keepAlive = setInterval(() => { }, 60 * 60 * 1000);

    const shutdown = async (signal: string) => {
        clearInterval(keepAlive);
        console.log(`\n${signal} received — stopping the Quack server…`);
        try {
            await connection.run(`CALL quack_stop(${quote(url)})`);
        } catch {
            // Already gone — closing the instance releases the rest.
        }
        closeQuietly(connection, instance);
        process.exit(0);
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

// ─── Entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const { command, flags } = parse(Bun.argv.slice(2));

    if (flags.help) {
        console.log(USAGE);
        return;
    }
    if (flags.version) {
        console.log(await version());
        return;
    }
    if (command === undefined) {
        console.log(USAGE);
        process.exit(1);
    }

    if (command !== "start") {
        throw new CliError(`Unknown command '${command}'. The only one is 'start'.`);
    }

    await start(flags);
}

try {
    await main();
} catch (err: any) {
    console.error(`error: ${err?.message ?? err}`);
    console.error("\nRun `antq --help` for the options.");
    process.exit(1);
}
