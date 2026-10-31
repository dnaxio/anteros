#!/usr/bin/env bun
// `antd` — the Quack server CLI, shipped by `@anteros/duckdb`.
//
//   antd start --dbPath ./data/analytics.duckdb --port 9494 --token super-secret
//
// One command, because the package does one thing: run a Quack server. The CLI is
// a thin layer over `DuckdbQuackServer` — flag parsing, the banner and the signal
// handling; serving, index creation, keep-alive and shutdown live in the library.

import { join } from "node:path";
import { DuckdbQuackServer, type DuckdbFtsIndex, type DuckdbVssIndex, type DuckdbVssMetric } from "../index";

// ─── Options ──────────────────────────────────────────────────────────────

type OptionSpec = {
    /** Canonical name, as the flag spells it. */
    key: string;
    type: "string" | "number" | "boolean" | "list";
    help: string;
};

/** A full-text index, from `--fts` or `--ftsConfig`. */
type FtsSpec = {
    table: string;
    id: string;
    fields: string[];
    stemmer?: string;
    stopwords?: string;
    ignore?: string;
    stripAccents?: boolean;
    lower?: boolean;
    overwrite?: boolean;
    incremental?: boolean;
};

/** A vector index, from `--vss` or `--vssConfig`. */
type VssSpec = {
    table: string;
    column: string;
    metric?: string;
    efConstruction?: number;
    efSearch?: number;
    m?: number;
    m0?: number;
    name?: string;
    overwrite?: boolean;
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
    { key: "targetBatchBytes", type: "number", help: "Target bytes per wire batch (default 32 MiB)" },
    { key: "sslCertFile", type: "string", help: "TLS certificate file (HTTPS only; Quack generates one otherwise)" },
    { key: "sslKeyFile", type: "string", help: "TLS private key file matching --sslCertFile" },
    { key: "fts", type: "list", help: "Full-text index: table:id:field1,field2 (repeatable, overwrite on)" },
    { key: "ftsConfig", type: "string", help: "JSON file: array of indexes { table, id, fields, ... } (for several tables)" },
    { key: "ftsStemmer", type: "string", help: "Stemmer for --fts indexes (default porter; e.g. french)" },
    { key: "ftsIncremental", type: "boolean", help: "Keep --fts indexes current with triggers (id must be NOT NULL / PRIMARY KEY)" },
    { key: "vss", type: "list", help: "Vector index: table:column[:metric] (repeatable; metric l2sq, cosine or ip)" },
    { key: "vssConfig", type: "string", help: "JSON file: array of vector indexes { table, column, metric, ... }" },
    { key: "vssMetric", type: "string", help: "Default VSS metric: l2sq (default), cosine or ip" },
    { key: "vssPersist", type: "boolean", help: "Experimental HNSW persistence — on by default; --vssPersist=false opts out" },
    { key: "name", type: "string", help: "Node name advertised by whoami()" },
    { key: "region", type: "string", help: "Node region advertised by whoami()" },
    { key: "provider", type: "string", help: "Node provider advertised by whoami()" },
    { key: "hostname", type: "string", help: "Node hostname advertised by whoami()" },
    { key: "printToken", type: "boolean", help: "Show the token in the banner (masked by default)" },
    { key: "debug", type: "boolean", help: "Log every operation and failure to the console" },
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

        if (spec.type === "list") {
            (flags[spec.key] ??= []).push(value);
            continue;
        }

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

const USAGE = `antd — a DuckDB instance served over the Quack protocol

Usage:
  antd start [options]

Options:
${OPTIONS.map((option) => `  --${option.key}${option.type === "boolean" ? "" : " <value>"}`.padEnd(30) + option.help).join("\n")}

Examples:
  antd start --quack --token super-secret
  antd start --dbPath ./data/analytics.duckdb --port 9494 --token super-secret
  antd start --host 0.0.0.0 --allowOtherHostname --token super-secret
  antd start --dbPath ./data/docs.duckdb --fts documents:document_identifier:text_content,author --fts docs:id:body --token super-secret
  antd start --dbPath ./data/docs.duckdb --ftsConfig ./fts.json --token super-secret
  antd start --dbPath ./data/docs.duckdb --fts documents:document_identifier:text_content,author --ftsStemmer french --token super-secret
  antd start --dbPath ./data/vecs.duckdb --vss embeddings:vec:cosine --token super-secret
  antd start --dbPath ./data/vecs.duckdb --vssConfig ./vss.json --token super-secret
`;

// ─── Version ──────────────────────────────────────────────────────────────

async function version(): Promise<string> {
    const manifest = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as { version?: string };
    return manifest.version ?? "0.0.0";
}

// ─── Index specs ──────────────────────────────────────────────────────────

const DEFAULT_PORT = 9494;

function firstLine(message: unknown): string {
    return String(message ?? "").split("\n")[0]!.trim();
}

/** A `--fts` / `--ftsConfig` field list — `'*'` or comma-separated names. */
function ftsFields(value: unknown, origin: string): string[] {
    if (value === "*") return ["*"];
    const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    const fields = parts.map((field) => String(field).trim()).filter((field) => field.length > 0);
    if (!fields.length) {
        throw new CliError(`${origin}: \`fields\` needs a column name, a list, or '*'`);
    }
    return fields;
}

/** Read and validate a `--ftsConfig` JSON file. */
async function readFtsConfig(path: string): Promise<FtsSpec[]> {
    let parsed: unknown;
    try {
        parsed = await Bun.file(path).json();
    } catch (err: any) {
        throw new CliError(`Cannot read --ftsConfig '${path}' — ${firstLine(err?.message ?? err)}`);
    }
    if (!Array.isArray(parsed)) {
        throw new CliError(`--ftsConfig '${path}' must contain a JSON array of indexes`);
    }

    return parsed.map((entry: any, position: number) => {
        const origin = `--ftsConfig '${path}' entry ${position + 1}`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new CliError(`${origin} is not an object`);
        }

        const table = String(entry.table ?? "").trim();
        const id = String(entry.id ?? "").trim();
        if (!table || !id) throw new CliError(`${origin} needs \`table\` and \`id\``);

        for (const key of ["stemmer", "stopwords", "ignore"] as const) {
            if (entry[key] !== undefined && typeof entry[key] !== "string") {
                throw new CliError(`${origin}: \`${key}\` must be a string`);
            }
        }
        for (const key of ["stripAccents", "lower", "overwrite", "incremental"] as const) {
            if (entry[key] !== undefined && typeof entry[key] !== "boolean") {
                throw new CliError(`${origin}: \`${key}\` must be a boolean`);
            }
        }

        return {
            table,
            id,
            fields: ftsFields(entry.fields, origin),
            stemmer: entry.stemmer,
            stopwords: entry.stopwords,
            ignore: entry.ignore,
            stripAccents: entry.stripAccents,
            lower: entry.lower,
            overwrite: entry.overwrite,
            incremental: entry.incremental,
        };
    });
}

/** A supported VSS metric, defaulting to l2sq. */
function vssMetric(value: unknown, origin: string): string {
    const metric = String(value ?? "l2sq").toLowerCase();
    if (metric !== "l2sq" && metric !== "cosine" && metric !== "ip") {
        throw new CliError(`${origin}: metric must be l2sq, cosine or ip`);
    }
    return metric;
}

/** Read and validate a `--vssConfig` JSON file. */
async function readVssConfig(path: string): Promise<VssSpec[]> {
    let parsed: unknown;
    try {
        parsed = await Bun.file(path).json();
    } catch (err: any) {
        throw new CliError(`Cannot read --vssConfig '${path}' — ${firstLine(err?.message ?? err)}`);
    }
    if (!Array.isArray(parsed)) {
        throw new CliError(`--vssConfig '${path}' must contain a JSON array of indexes`);
    }

    return parsed.map((entry: any, position: number) => {
        const origin = `--vssConfig '${path}' entry ${position + 1}`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new CliError(`${origin} is not an object`);
        }

        const table = String(entry.table ?? "").trim();
        const column = String(entry.column ?? "").trim();
        if (!table || !column) throw new CliError(`${origin} needs \`table\` and \`column\``);

        if (entry.metric !== undefined && typeof entry.metric !== "string") {
            throw new CliError(`${origin}: \`metric\` must be a string`);
        }
        if (entry.name !== undefined && typeof entry.name !== "string") {
            throw new CliError(`${origin}: \`name\` must be a string`);
        }
        for (const key of ["efConstruction", "efSearch", "m", "m0"] as const) {
            if (entry[key] !== undefined && !Number.isFinite(Number(entry[key]))) {
                throw new CliError(`${origin}: \`${key}\` must be a number`);
            }
        }
        if (entry.overwrite !== undefined && typeof entry.overwrite !== "boolean") {
            throw new CliError(`${origin}: \`overwrite\` must be a boolean`);
        }

        return {
            table,
            column,
            metric: entry.metric !== undefined ? vssMetric(entry.metric, origin) : undefined,
            efConstruction: entry.efConstruction,
            efSearch: entry.efSearch,
            m: entry.m,
            m0: entry.m0,
            name: entry.name,
            overwrite: entry.overwrite,
        };
    });
}

/** Collect full-text indexes from `--fts` and `--ftsConfig`. */
async function collectFts(flags: Record<string, any>): Promise<FtsSpec[]> {
    const defaults = {
        stemmer: flags.ftsStemmer !== undefined ? String(flags.ftsStemmer) : undefined,
        incremental: flags.ftsIncremental === true ? true : undefined,
    };
    const specs: FtsSpec[] = [];

    for (const spec of flags.fts ?? []) {
        const [rawTable, rawId, fields] = String(spec).split(":");
        const table = (rawTable ?? "").trim();
        const id = (rawId ?? "").trim();
        if (!table || !id || !fields) {
            throw new CliError(`--fts expects table:id:field1,field2 — got '${spec}'`);
        }
        specs.push({
            table,
            id,
            fields: ftsFields(fields, `--fts '${spec}'`),
            stemmer: defaults.stemmer,
            incremental: defaults.incremental,
        });
    }

    if (flags.ftsConfig !== undefined) {
        specs.push(...await readFtsConfig(String(flags.ftsConfig)));
    }
    return specs;
}

/** Collect vector indexes from `--vss` and `--vssConfig`. */
async function collectVss(flags: Record<string, any>): Promise<VssSpec[]> {
    const specs: VssSpec[] = [];

    for (const spec of flags.vss ?? []) {
        const [rawTable, rawColumn, metric] = String(spec).split(":");
        const table = (rawTable ?? "").trim();
        const column = (rawColumn ?? "").trim();
        if (!table || !column) {
            throw new CliError(`--vss expects table:column[:metric] — got '${spec}'`);
        }
        specs.push({
            table,
            column,
            metric: metric !== undefined ? vssMetric(metric, `--vss '${spec}'`) : undefined,
        });
    }

    if (flags.vssConfig !== undefined) {
        specs.push(...await readVssConfig(String(flags.vssConfig)));
    }
    return specs;
}

/** The CLI's specs are the library's, with `'*'` expressed the way it expects. */
function toFtsIndex(spec: FtsSpec): DuckdbFtsIndex {
    return {
        ...spec,
        fields: spec.fields.length === 1 && spec.fields[0] === "*" ? "*" : spec.fields,
    };
}

function toVssIndex(spec: VssSpec, persist: boolean): DuckdbVssIndex {
    return {
        ...spec,
        metric: spec.metric === undefined ? undefined : (spec.metric as DuckdbVssMetric),
        persist,
    };
}

// ─── start ────────────────────────────────────────────────────────────────

function masked(token: string): string {
    return `${"*".repeat(Math.min(token.length, 8))} (${token.length} characters)`;
}

function banner(url: string, dbPath: string | undefined, token: string, showToken: boolean, mode: Mode): string {
    const where = dbPath ?? "in memory (nothing is persisted)";
    return [
        "",
        "  @anteros/duckdb — antd",
        `    mode     ${mode}`,
        `    url      ${url}`,
        `    db       ${where}`,
        `    token    ${showToken ? token : masked(token)}`,
        `    pid      ${process.pid}`,
        "",
        "  Attach from another process:",
        `    new DuckdbQuackInstance({ url: '${url}', token: '…' })`,
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

    if ((flags.sslCertFile === undefined) !== (flags.sslKeyFile === undefined)) {
        throw new CliError("--sslCertFile and --sslKeyFile go together — pass both, or neither");
    }
    if (flags.disableSsl === true && flags.sslCertFile !== undefined) {
        throw new CliError("--disableSsl and --sslCertFile are exclusive — a plain-HTTP server cannot serve a certificate");
    }

    const fts = await collectFts(flags);
    const vss = await collectVss(flags);
    // `--vssMetric` fills what an index did not specify; a per-entry metric wins.
    const vssDefault = flags.vssMetric !== undefined ? vssMetric(flags.vssMetric, "--vssMetric") : undefined;
    const vssIndexes = vss.map((index) => toVssIndex(
        { ...index, metric: index.metric ?? vssDefault },
        true,
    ));

    const identity = { name: flags.name, region: flags.region, provider: flags.provider, hostname: flags.hostname };
    const hasIdentity = Object.values(identity).some((value) => value !== undefined);

    const server = new DuckdbQuackServer({
        port: flags.port ?? DEFAULT_PORT,
        host: flags.host ?? "127.0.0.1",
        token: secret,
        dbPath: flags.dbPath,
        allowOtherHostname: flags.allowOtherHostname === true,
        disableSsl: flags.disableSsl,
        sslCertFile: flags.sslCertFile,
        sslKeyFile: flags.sslKeyFile,
        targetBatchBytes: flags.targetBatchBytes,
        ...(hasIdentity ? { identity } : {}),
        settings: {
            ...(flags.threads !== undefined ? { threads: flags.threads } : {}),
            ...(flags.vssPersist === false ? { hnsw_enable_experimental_persistence: false } : {}),
        },
        ftsIndexes: fts.length ? fts.map(toFtsIndex) : undefined,
        vssIndexes: vssIndexes.length ? vssIndexes : undefined,
        debug: flags.debug === true,
    });

    try {
        await server.start();
    } catch (err: any) {
        throw new CliError(firstLine(err?.message ?? err));
    }

    console.log(banner(server.listenUri, flags.dbPath, secret, flags.printToken === true, mode));

    const shutdown = async (signal: string) => {
        console.log(`\n${signal} received — stopping the Quack server…`);
        await server.stop().catch(() => {});
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
    console.error("\nRun `antd --help` for the options.");
    process.exit(1);
}
