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
    { key: "vssPersist", type: "boolean", help: "Enable experimental HNSW persistence (required for a file database)" },
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

const USAGE = `antq — a DuckDB instance served over the Quack protocol

Usage:
  antq start [options]

Options:
${OPTIONS.map((option) => `  --${option.key}${option.type === "boolean" ? "" : " <value>"}`.padEnd(30) + option.help).join("\n")}

Examples:
  antq start --quack --token super-secret
  antq start --dbPath ./data/analytics.duckdb --port 9494 --token super-secret
  antq start --host 0.0.0.0 --allowOtherHostname --token super-secret
  antq start --dbPath ./data/docs.duckdb --fts documents:document_identifier:text_content,author --fts docs:id:body --token super-secret
  antq start --dbPath ./data/docs.duckdb --ftsConfig ./fts.json --token super-secret
  antq start --dbPath ./data/docs.duckdb --fts documents:document_identifier:text_content,author --ftsStemmer french --token super-secret
  antq start --dbPath ./data/vecs.duckdb --vss embeddings:vec:cosine --vssPersist --token super-secret
  antq start --dbPath ./data/vecs.duckdb --vssConfig ./vss.json --vssPersist --token super-secret
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

/** The `PRAGMA create_fts_index(...)` for one index. */
function ftsArgs(index: FtsSpec, defaults: { stemmer?: string; incremental?: boolean } = {}): string {
    const args = [quote(index.table), quote(index.id), ...index.fields.map(quote)];
    args.push(`overwrite = ${index.overwrite ?? true}`);

    const stemmer = index.stemmer ?? defaults.stemmer;
    if (stemmer !== undefined) args.push(`stemmer = ${quote(stemmer)}`);
    if (index.stopwords !== undefined) args.push(`stopwords = ${quote(index.stopwords)}`);
    if (index.ignore !== undefined) args.push(`ignore = ${quote(index.ignore)}`);
    if (index.stripAccents !== undefined) args.push(`strip_accents = ${index.stripAccents === true}`);
    if (index.lower !== undefined) args.push(`lower = ${index.lower === true}`);

    const incremental = index.incremental ?? defaults.incremental;
    if (incremental !== undefined) args.push(`incremental = ${incremental === true}`);

    return `PRAGMA create_fts_index(${args.join(", ")})`;
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

function masked(token: string): string {
    return `${"*".repeat(Math.min(token.length, 8))} (${token.length} characters)`;
}

/** A SQL identifier, quoted. */
function ident(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

/** A possibly qualified name, each part quoted. */
function identPath(name: string): string {
    return name.split(".").map(ident).join(".");
}

/** A supported VSS metric, defaulting to l2sq. */
function vssMetric(value: unknown, origin: string): string {
    const metric = String(value ?? "l2sq").toLowerCase();
    if (metric !== "l2sq" && metric !== "cosine" && metric !== "ip") {
        throw new CliError(`${origin}: metric must be l2sq, cosine or ip`);
    }
    return metric;
}

/** The default HNSW index name for a column. */
function vssIndexName(table: string, column: string): string {
    const tableName = table.split(".").pop()!;
    return `vss_${tableName}_${column}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
}

/** The index name qualified with the table's schema, for DROP INDEX. */
function vssIndexRef(table: string, index: string): string {
    const parts = table.split(".");
    return parts.length >= 2 ? `${parts[parts.length - 2]}.${index}` : index;
}

/** The CREATE INDEX statement for one vector index. */
function vssSql(index: VssSpec): string {
    const name = index.name ?? vssIndexName(index.table, index.column);
    const options = [`metric = ${quote(index.metric ?? "l2sq")}`];
    for (const [key, option] of [
        ["efConstruction", "ef_construction"],
        ["efSearch", "ef_search"],
        ["m", "M"],
        ["m0", "M0"],
    ] as const) {
        const value = index[key];
        if (value !== undefined) {
            if (!Number.isFinite(Number(value))) throw new CliError(`VSS \`${key}\` must be a number`);
            options.push(`${option} = ${Math.trunc(Number(value))}`);
        }
    }
    return `CREATE INDEX IF NOT EXISTS ${ident(name)} ON ${identPath(index.table)} USING HNSW (${ident(index.column)}) WITH (${options.join(", ")})`;
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

/** Load the vss extension once, installing it when it is missing. */
async function ensureVss(connection: DuckDBConnection): Promise<void> {
    try {
        await connection.run("LOAD vss");
    } catch {
        await connection.run("INSTALL vss");
        await connection.run("LOAD vss");
    }
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

    if ((flags.sslCertFile === undefined) !== (flags.sslKeyFile === undefined)) {
        throw new CliError("--sslCertFile and --sslKeyFile go together — pass both, or neither");
    }
    if (flags.disableSsl === true && flags.sslCertFile !== undefined) {
        throw new CliError("--disableSsl and --sslCertFile are exclusive — a plain-HTTP server cannot serve a certificate");
    }

    let instance: DuckDBInstance;
    try {
        const options = flags.threads !== undefined ? { threads: String(flags.threads) } : undefined;
        instance = await DuckDBInstance.create(flags.dbPath, options);
    } catch (err: any) {
        throw new CliError(`Cannot open DuckDB — ${firstLine(err?.message ?? err)}`);
    }
    const connection = await instance.connect();

    let listenUri = url;
    try {
        // Settings first: they are what `quack_serve` then honours.
        if (flags.targetBatchBytes !== undefined) {
            await connection.run(`SET GLOBAL quack_target_batch_bytes = ${Number(flags.targetBatchBytes)}`);
        }
        const identity = { name: flags.name, region: flags.region, provider: flags.provider, hostname: flags.hostname };
        const named = Object.entries(identity)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key} := ${quote(String(value))}`);
        if (named.length) await connection.run(`CALL quack_identify(${named.join(", ")})`);

        // Full-text indexes — before the port opens, so a client can search at once.
        // `--fts` is for one-offs; `--ftsConfig` carries several indexes with their
        // own options. Global `--ftsStemmer` / `--ftsIncremental` fill the gaps.
        const ftsDefaults = {
            stemmer: flags.ftsStemmer !== undefined ? String(flags.ftsStemmer) : undefined,
            incremental: flags.ftsIncremental === true ? true : undefined,
        };
        const ftsSpecs: FtsSpec[] = [];

        for (const spec of flags.fts ?? []) {
            const [rawTable, rawId, fields] = String(spec).split(":");
            const table = (rawTable ?? "").trim();
            const id = (rawId ?? "").trim();
            if (!table || !id || !fields) {
                throw new CliError(`--fts expects table:id:field1,field2 — got '${spec}'`);
            }
            ftsSpecs.push({
                table,
                id,
                fields: ftsFields(fields, `--fts '${spec}'`),
                stemmer: ftsDefaults.stemmer,
                incremental: ftsDefaults.incremental,
            });
        }
        if (flags.ftsConfig !== undefined) {
            ftsSpecs.push(...await readFtsConfig(String(flags.ftsConfig)));
        }
        for (const index of ftsSpecs) {
            await connection.run(ftsArgs(index, ftsDefaults));
        }

        // Vector indexes — `vss` is not autoloaded: load it once, then build each
        // HNSW index before the port opens.
        const vssSpecs: VssSpec[] = [];
        for (const spec of flags.vss ?? []) {
            const [rawTable, rawColumn, metric] = String(spec).split(":");
            const table = (rawTable ?? "").trim();
            const column = (rawColumn ?? "").trim();
            if (!table || !column) {
                throw new CliError(`--vss expects table:column[:metric] — got '${spec}'`);
            }
            vssSpecs.push({
                table,
                column,
                metric: metric !== undefined ? vssMetric(metric, `--vss '${spec}'`) : undefined,
            });
        }
        if (flags.vssConfig !== undefined) {
            vssSpecs.push(...await readVssConfig(String(flags.vssConfig)));
        }
        if (vssSpecs.length) {
            if (flags.dbPath !== undefined && flags.vssPersist !== true) {
                throw new CliError(
                    "HNSW indexes in a file database need --vssPersist (experimental persistence)",
                );
            }

            await ensureVss(connection);
            if (flags.vssPersist === true) {
                await connection.run("SET GLOBAL hnsw_enable_experimental_persistence = true");
            }

            for (const index of vssSpecs) {
                const resolved: VssSpec = {
                    ...index,
                    metric: vssMetric(index.metric ?? flags.vssMetric, "--vssMetric"),
                };
                if (resolved.overwrite ?? true) {
                    const name = resolved.name ?? vssIndexName(resolved.table, resolved.column);
                    await connection.run(`DROP INDEX IF EXISTS ${identPath(vssIndexRef(resolved.table, name))}`);
                }
                await connection.run(vssSql(resolved));
            }
        }

        // Named arguments: `quack_serve(uri, token := …)`. The transport is only
        // stated when the caller chose one — Quack's default is plain for a local
        // URI and TLS otherwise, while `disable_ssl := false` forces TLS even here.
        const serveArgs = [
            quote(url),
            `token := ${quote(secret)}`,
            `allow_other_hostname := ${flags.allowOtherHostname === true}`,
        ];
        if (flags.disableSsl !== undefined) serveArgs.push(`disable_ssl := ${flags.disableSsl}`);
        if (flags.sslCertFile !== undefined) {
            serveArgs.push(`ssl_cert_file := ${quote(String(flags.sslCertFile))}`);
            serveArgs.push(`ssl_key_file := ${quote(String(flags.sslKeyFile))}`);
        }

        // `quack_serve` returns the URI and URL it actually bound: show those.
        const served = (await connection.runAndReadAll(
            `CALL quack_serve(${serveArgs.join(", ")})`,
        )).getRowObjectsJson() as Array<Record<string, unknown>>;
        if (served[0]?.listen_uri !== undefined) listenUri = String(served[0].listen_uri);
    } catch (err: any) {
        closeQuietly(connection, instance);
        throw new CliError(`Cannot start the Quack server on ${url} — ${firstLine(err?.message ?? err)}`);
    }

    console.log(banner(listenUri, flags.dbPath, secret, flags.printToken === true, mode));

    // Nothing else keeps the event loop alive: the Quack listener is a native
    // thread, invisible to Bun's scheduler.
    const keepAlive = setInterval(() => { }, 60 * 60 * 1000);

    const shutdown = async (signal: string) => {
        clearInterval(keepAlive);
        console.log(`\n${signal} received — stopping the Quack server…`);
        try {
            await connection.run(`CALL quack_stop(${quote(listenUri)})`);
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
