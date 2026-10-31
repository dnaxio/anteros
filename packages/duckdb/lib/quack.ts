import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import type {
    DuckdbColumn,
    DuckdbDocument,
    DuckdbDeleteOptions,
    DuckdbExecOptions,
    DuckdbExecResult,
    DuckdbFtsDropResult,
    DuckdbFtsIndexInfo,
    DuckdbFtsIndexOptions,
    DuckdbFtsSearchOptions,
    DuckdbFtsSearchResult,
    DuckdbIngestOptions,
    DuckdbIngestResult,
    DuckdbPurgeOptions,
    DuckdbPurgeResult,
    DuckdbReplaceOptions,
    DuckdbRetentionHandle,
    DuckdbRetentionOptions,
    DuckdbSchemaChange,
    DuckdbSchemaReport,
    DuckdbTableDeleteResult,
    DuckdbTableInfo,
    DuckdbTableIngestResult,
    DuckdbTableOptions,
    DuckdbTableReplaceResult,
    DuckdbTableUpdateResult,
    DuckdbTransaction,
    DuckdbUpdateOptions,
    DuckdbVssDropResult,
    DuckdbVssIndexInfo,
    DuckdbVssIndexOptions,
    DuckdbVssMetric,
    DuckdbVssSearchOptions,
    DuckdbVssSearchResult,
    DuckdbVariable,
    QuackInstanceOptions,
    QuackServerOptions,
} from "../types/quack";

/** The surface a `DuckdbTable` needs from its instance (wired by `table()`). */
type TableBackend = {
    /** The table name, qualified with the attached catalog when there is one. */
    target: string;
    ensure: () => Promise<void>;
    insert: (rows: Array<Record<string, unknown>>, ts?: string, batchSize?: number) => Promise<void>;
    enqueue: (work: () => Promise<void>) => void;
    flush: () => Promise<void>;
    /** Run a statement where it belongs (the Quack server when attached). */
    query: (sql: string) => Promise<DuckdbExecResult>;
};

/**
 * A **data table** — two columns, `data` (`JSON`) and `ts` (`TIMESTAMP`), and
 * nothing else. Get one with `db.table(name)`.
 *
 * ```ts
 * const tickets = await db.table("tickets", { ts: "createdAt" });
 * await tickets.ingest([{ ref: "A-1", total: 42, createdAt: "2026-10-01T08:30:00Z" }]);
 * await tickets.flush();
 * ```
 *
 * The table is created **in the background** when it does not exist; `ingest()`
 * waits for that creation before it queues the write.
 */
class DuckdbTable {
    /** The table name, as declared. */
    readonly name: string;

    #options: DuckdbTableOptions;
    #backend: TableBackend;
    #ready: Promise<void>;

    constructor(name: string, options: DuckdbTableOptions, backend: TableBackend) {
        this.name = name;
        this.#options = options;
        this.#backend = backend;
        // Creation starts right away, in the background — `ingest()` waits for it.
        this.#ready = backend.ensure();
        this.#ready.catch(() => {});
    }

    /** The table exists (created during construction when it was missing). */
    async ready(): Promise<void> {
        await this.#ready;
    }

    /**
     * Queue documents — one row each: `data` is the document itself, `ts` comes
     * from the field mapped at construction (`{ ts: 'createdAt' }`), from this
     * call's `ts`, or from the ingestion time.
     *
     * A background write, like the instance's `ingest`: `flush()` waits for it.
     */
    async ingest(
        documents: DuckdbDocument | DuckdbDocument[],
        options: DuckdbTableOptions = {},
    ): Promise<DuckdbTableIngestResult> {
        const rows = Array.isArray(documents) ? documents : [documents];
        if (!rows.length) return { table: this.name, queued: 0 };

        await this.#ready;
        this.#backend.enqueue(() => this.#backend.insert(rows, options.ts ?? this.#options.ts, options.insertBatchSize));
        return { table: this.name, queued: rows.length };
    }

    /** Wait for the queued writes of this instance to land. */
    async flush(): Promise<void> {
        await this.#ready.catch(() => {});
        await this.#backend.flush();
    }

    /**
     * Patch the documents matching `where` — `json_merge_patch(data, patch)`.
     *
     * ```ts
     * await tickets.update("data->>'guichet' = 'G1'", { zone: "Z", prix: 999 });
     * ```
     *
     * The filter is **mandatory**: without one, every document would be patched.
     */
    async update(where: string, patch: DuckdbDocument): Promise<DuckdbTableUpdateResult> {
        const predicate = requireWhere(where, "update");
        await this.#ready;

        const result = await this.#backend.query(
            `UPDATE ${this.#backend.target} SET "data" = json_merge_patch("data", ${quoteLiteral(JSON.stringify(patch))}) WHERE ${predicate}`,
        );
        return { table: this.name, updated: affectedRows(result) };
    }

    /**
     * Replace the **whole** document of the rows matching `where` (it is not merged
     * with the previous one).
     *
     * ```ts
     * await tickets.replace("data->>'ref' = 'A-1'", { ref: "A-1", zone: "Z" });
     * ```
     *
     * The filter is **mandatory**.
     */
    async replace(where: string, document: DuckdbDocument): Promise<DuckdbTableReplaceResult> {
        const predicate = requireWhere(where, "replace");
        await this.#ready;

        const result = await this.#backend.query(
            `UPDATE ${this.#backend.target} SET "data" = CAST(${quoteLiteral(JSON.stringify(document))} AS JSON) WHERE ${predicate}`,
        );
        return { table: this.name, replaced: affectedRows(result) };
    }

    /**
     * Delete the documents matching `where`.
     *
     * ```ts
     * await tickets.delete("data->>'guichet' = 'G1'");
     * ```
     *
     * The filter is **mandatory**.
     */
    async delete(where: string): Promise<DuckdbTableDeleteResult> {
        const predicate = requireWhere(where, "delete");
        await this.#ready;

        const result = await this.#backend.query(
            `DELETE FROM ${this.#backend.target} WHERE ${predicate}`,
        );
        return { table: this.name, deleted: affectedRows(result) };
    }
}

/**
 * A DuckDB instance, optionally attached to a **Quack** server.
 *
 * ```ts
 * const db = new DuckdbQuackInstance({
 *   url: 'quack:analytics.internal:9494',
 *   token: process.env.QUACK_TOKEN,
 * });
 *
 * // The remote is the default catalog — the fields of the table are declared here,
 * // and the write goes over the wire.
 * await db.createTable('events', [
 *     { name: 'id', type: 'string' },
 *     { name: 'data', type: 'json' },
 * ]);
 * await db.ingest({ table: 'events', rows: [{ id: 'evt-1', data: { ref: 'A-1' } }] });
 * await db.flush();
 *
 * const { rows } = await db.exec('SELECT * FROM events');       // the server's table
 * const local = await db.exec('SELECT * FROM memory.events');   // the client's own catalog
 *
 * await db.close();
 * ```
 *
 * The client's own database is **in memory** — a workspace for the life of the
 * object. What has to be shared between processes, or survive a restart, belongs
 * on the Quack server. Nothing is opened until the first call (`connect()` is
 * idempotent and implicit), and `close()` releases the instance.
 */
class DuckdbQuackInstance {
    #options: QuackInstanceOptions;
    #opening: Promise<void> | null = null;
    #instance: DuckDBInstance | null = null;
    #connection: DuckDBConnection | null = null;
    #attached = false;
    #closed = false;
    /** The client's own catalog — what `USE` returns to before a re-attach. */
    #localDb: string | null = null;

    /** Writes queued by `ingest`, drained in order (see `flush`). */
    #pending: Promise<void> = Promise.resolve();
    /** The first queued write that failed — `flush()` surfaces it once. */
    #writeError: DuckdbQuackError | null = null;
    /** Tables known to exist — skips the existence check on ingest. */
    #tables = new Set<string>();
    /** Columns of a table, as DuckDB reports them. */
    #columns = new Map<string, Array<{ name: string; sql: string }>>();
    /** Fields of a full-text index, cached per table. */
    #ftsFields = new Map<string, Set<string>>();
    /** Whether `LOAD vss` already ran for this instance. */
    #vssLoaded = false;
    /** Whether `transaction()` is running — nested transactions are refused. */
    #inTransaction = false;
    /** The re-attach in flight — concurrent callers share it (see `reattach`). */
    #reattaching: Promise<void> | null = null;
    /** The background reconciliation of `options.tables` (see `syncSchema`). */
    #schemaSync: Promise<DuckdbSchemaReport> | null = null;

    constructor(options: QuackInstanceOptions = {}) {
        // Quack 2.0 accepts `READ_ONLY` on ATTACH and ignores it: writes still land.
        // A flag that promises protection without providing it is worse than none,
        // so it is refused rather than silently downgraded.
        if (options.readOnly) {
            throw new DuckdbQuackError(
                "Quack 2.0 ignores READ_ONLY on ATTACH — enforce read-only on the server (`authorizationFunction`) instead",
                "DUCKDB_QUACK_READ_ONLY_UNSUPPORTED",
            );
        }
        if (options.db !== undefined && options.url === undefined) {
            throw new DuckdbQuackError(
                "`db` selects a database on a Quack server — pass `url` (or use `ATTACH` locally)",
                "DUCKDB_QUACK_URL_REQUIRED",
            );
        }
        this.#options = options;
    }

    /** One debug line per operation — `debug: true` only, SQL truncated. */
    #debug(message: string, details?: Record<string, unknown>): void {
        if (!this.#options.debug) return;
        console.debug(`[duckdb] ${message}`, details ?? "");
    }

    /** One debug line per failure — the error is still thrown by the caller. */
    #debugError(message: string, err: any, details?: Record<string, unknown>): void {
        if (!this.#options.debug) return;
        console.error(`[duckdb] ${message}`, {
            ...details,
            code: err?.code,
            error: firstLine(err?.message ?? err),
        });
    }

    // ─── State ────────────────────────────────────────────────────────────

    /** The Quack server this instance attaches, when it has one. */
    get url(): string | undefined {
        return this.#options.url;
    }

    /** The catalog the remote is (or will be) attached under. */
    get alias(): string {
        return this.#options.as ?? "quack";
    }

    /** Whether the local instance is open. */
    get isConnected(): boolean {
        return this.#connection !== null;
    }

    /** Whether a remote catalog is attached. */
    get isAttached(): boolean {
        return this.#attached;
    }

    /**
     * The underlying DuckDB handles — the escape hatch.
     *
     * Everything this class does not wrap (the `Appender`, prepared statements,
     * Arrow, extensions, UDFs…) is reachable from here. Use it rather than opening
     * a second instance: the point of this class is that there is **one**.
     */
    async raw(): Promise<{ instance: DuckDBInstance; connection: DuckDBConnection }> {
        await this.connect();
        return { instance: this.#instance!, connection: this.#connection! };
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────

    /** Open the local instance and attach the remote if one is configured. Idempotent. */
    async connect(): Promise<this> {
        if (this.#closed) throw new DuckdbQuackError("This DuckDB instance is closed", "DUCKDB_CLOSED");
        if (!this.#opening) this.#opening = this.#open();
        try {
            await this.#opening;
        } catch (err) {
            // Never keep a failure: the next call deserves a fresh attempt.
            this.#opening = null;
            throw err;
        }
        return this;
    }

    /**
     * Re-attach the remote after the server restarted — or invalidated its database.
     *
     * Quack ties an attached catalog to the server's **database instance**: when
     * that instance goes away (restart, `stop()`, a fatal error), every query fails
     * with `DUCKDB_QUACK_DATABASE_INVALIDATED` until the catalog is detached and
     * attached again. `reattach()` does exactly that, then drops the schema caches
     * (a restart may also have changed the tables).
     *
     * ```ts
     * try {
     *     await db.exec("SELECT …");
     * } catch (err: any) {
     *     if (err.code !== "DUCKDB_QUACK_DATABASE_INVALIDATED") throw err;
     *     await db.reattach();
     *     // retry — a write that failed may or may not have landed, so retry reads
     *     // first; make writes idempotent before retrying them.
     * }
     * ```
     */
    async reattach(): Promise<this> {
        if (this.#closed) throw new DuckdbQuackError("This DuckDB instance is closed", "DUCKDB_CLOSED");
        if (!this.#options.url) {
            throw new DuckdbQuackError("`reattach` needs an attached instance — pass `url`", "DUCKDB_QUACK_URL_REQUIRED");
        }

        // Single-flight: a burst of failed reads (a server restart) all call
        // `reattach()` at once, and two DETACH/ATTACH on the same connection is a
        // race — the second one fails, or leaves the catalog detached. The first
        // caller does the work, the others wait for it and retry afterwards.
        if (!this.#reattaching) {
            const run = this.#doReattach();
            this.#reattaching = run;
            try {
                await run;
            } finally {
                if (this.#reattaching === run) this.#reattaching = null;
            }
            return this;
        }

        await this.#reattaching;
        return this;
    }

    async #doReattach(): Promise<void> {
        await this.connect();
        await this.flush();
        this.#debug("reattach", { url: this.#options.url, as: this.alias });
        const { connection } = await this.raw();
        // DuckDB refuses to detach the catalog currently in use: step back to the
        // client's own database first.
        if (this.#localDb) {
            try {
                await connection.run(`USE ${quoteIdent(this.#localDb)}`);
            } catch {
                // The local catalog is gone — the detach below will tell.
            }
        }
        try {
            await connection.run(`DETACH ${quoteIdent(this.alias)}`);
        } catch {
            // Already gone — the attach below is what matters.
        }
        this.#attached = false;
        this.#tables.clear();
        this.#columns.clear();
        this.#ftsFields.clear();
        await this.#attach();
    }

    async #open(): Promise<void> {
        try {
            // A file when one is asked for (that is what the server does), memory
            // otherwise — a client is a workspace. The folder is created first: a
            // `dbPath` under a missing directory is configuration, not an error.
            if (this.#options.dbPath) await ensureDbDirectory(this.#options.dbPath);
            this.#instance = await DuckDBInstance.create(this.#options.dbPath, settingsOf(this.#options));
            this.#connection = await this.#instance.connect();
            // Remember the client's own catalog: `reattach()` must leave the remote
            // before it can detach it (`USE` is per session, and DuckDB refuses to
            // detach the database in use).
            const local = await this.#connection.runAndReadAll("SELECT current_database() AS db");
            this.#localDb = String((local.getRowObjectsJson()[0] as any)?.db ?? "memory");
            this.#debug("open", { database: this.#localDb, dbPath: this.#options.dbPath ?? "memory" });
            if (this.#options.url) await this.#attach();
        } catch (err) {
            // A failed attach must not leave an open instance behind: the next
            // `connect()` would overwrite the handles, leaking the native instance
            // (and, with a `dbPath`, its file lock) on every retry.
            try {
                this.#connection?.closeSync();
            } catch { /* already gone */ }
            try {
                this.#instance?.closeSync();
            } catch { /* already gone */ }
            this.#connection = null;
            this.#instance = null;
            this.#attached = false;
            this.#localDb = null;
            throw err;
        }
        // The declared tables are reconciled in the background: a first query must
        // not wait for a migration. `syncSchema()` is how you wait for it.
        if (this.#options.tables?.length) this.#startSchemaSync();
    }

    async #attach(): Promise<void> {
        const quack = this.#options;
        const token = quack.token ?? Bun.env?.DUCKDB_QUACK_TOKEN ?? process.env?.DUCKDB_QUACK_TOKEN;
        if (!token) {
            throw new DuckdbQuackError(
                "A Quack url was given but no token — pass `token`, or set DUCKDB_QUACK_TOKEN",
                "DUCKDB_QUACK_TOKEN_REQUIRED",
            );
        }

        const secret = quoteIdent(quack.secret ?? "anteros_quack");

        // ATTACH options are validated before the secret is created: a bad client id
        // should name the cause, not surface as an attach failure.
        const clientId = quack.clientId?.trim();
        if (clientId !== undefined && clientId.length < 4) {
            throw new DuckdbQuackError(
                "A Quack client id must be at least 4 characters",
                "DUCKDB_QUACK_CLIENT_ID_INVALID",
            );
        }
        if (quack.heartbeatTimeout !== undefined && !(Number.isFinite(quack.heartbeatTimeout) && quack.heartbeatTimeout >= 1)) {
            throw new DuckdbQuackError(
                "`heartbeatTimeout` must be a number of seconds, at least 1",
                "DUCKDB_QUACK_HEARTBEAT_INVALID",
            );
        }

        try {
            // The secret first: the ATTACH resolves it by type. `SCOPE` pins it to
            // this server, so another quack URI in the session cannot pick the token up.
            await this.#connection!.run(
                `CREATE OR REPLACE SECRET ${secret} (TYPE quack, TOKEN ${quoteLiteral(token)}, SCOPE ${quoteLiteral(quack.url!)})`,
            );

            // `DISABLE_SSL` is the one ATTACH transport option still honoured. It is
            // only spelled out when the caller states it: Quack's default is plain
            // for a local URI and TLS otherwise, and an explicit `false` forces TLS.
            const attachOptions: string[] = [];
            if (quack.disableSsl !== undefined) attachOptions.push(`DISABLE_SSL ${quack.disableSsl}`);
            if (quack.sslFingerprint !== undefined) attachOptions.push(`SSL_FINGERPRINT ${quoteLiteral(quack.sslFingerprint)}`);
            if (clientId !== undefined) attachOptions.push(`CLIENT_ID ${quoteLiteral(clientId)}`);
            if (quack.heartbeatTimeout !== undefined) attachOptions.push(`HEARTBEAT_TIMEOUT ${Math.trunc(quack.heartbeatTimeout)}`);
            const suffix = attachOptions.length ? ` (${attachOptions.join(", ")})` : "";

            await this.#connection!.run(
                `ATTACH ${quoteLiteral(quack.url!)} AS ${quoteIdent(this.alias)}${suffix}`,
            );
            // The remote is what this instance is for: make it the default catalog, so
            // an unqualified `events` means the *server's* table. The client's own
            // memory catalog stays reachable, qualified (`memory.…`).
            await this.#connection!.run(`USE ${quoteIdent(this.alias)}`);
            this.#attached = true;
            this.#debug("attached", { url: quack.url, as: this.alias });

            // Select a database inside the server when it exposes several. The
            // statement runs on the server (the attachment's session), not on the
            // client's own catalog. `USE` is per client session.
            if (quack.db !== undefined) {
                const database = normaliseName(quack.db);
                try {
                    await this.#connection!.runAndReadAll(
                        `SELECT * FROM quack_query_by_name($1, $2)`,
                        [this.alias, `USE ${quoteIdent(database)}`],
                    );
                } catch (err: any) {
                    this.#attached = false;
                    throw new DuckdbQuackError(
                        `Cannot select database '${database}' on '${quack.url}' — ${firstLine(err?.message)}`,
                        "DUCKDB_QUACK_DATABASE_FAILED",
                        err,
                    );
                }
            }
        } catch (err: any) {
            this.#debugError("attach failed", err, { url: quack.url });
            if (err instanceof DuckdbQuackError && err.code === "DUCKDB_QUACK_DATABASE_FAILED") throw err;
            throw new DuckdbQuackError(
                `Cannot attach the Quack remote '${quack.url}' — ${firstLine(err?.message)}`,
                "DUCKDB_QUACK_ATTACH_FAILED",
                err,
            );
        }
    }

    /** Close the instance. Every later call is refused. */
    async close(): Promise<void> {
        // A queued write that failed must not keep the instance open: surface it
        // after the connection is released.
        let failure: unknown;
        try {
            await this.flush();
        } catch (err) {
            failure = err;
        }
        // A migration in flight must finish before the connection goes away.
        if (this.#schemaSync) await this.#schemaSync.catch(() => {});
        this.#closed = true;

        try {
            this.#connection?.closeSync();
            this.#instance?.closeSync();
        } finally {
            this.#connection = null;
            this.#instance = null;
            this.#attached = false;
            this.#opening = null;
            this.#tables.clear();
            this.#columns.clear();
            this.#ftsFields.clear();
            this.#vssLoaded = false;
            this.#inTransaction = false;
            this.#schemaSync = null;
        }
        if (failure) throw failure;
    }

    // ─── Declared schema ──────────────────────────────────────────────────

    /**
     * Reconcile the tables declared at initialization (`tables`): create a missing
     * table, add the fields it lacks, retype the ones whose declared type differs —
     * and **never drop** a field the declaration does not know about.
     *
     * It runs **in the background** as soon as the instance opens; `syncSchema()`
     * is how you wait for it (and see what it changed). Idempotent: a table already
     * in sync produces an empty report.
     */
    async syncSchema(): Promise<DuckdbSchemaReport> {
        await this.connect();
        if (!this.#schemaSync) this.#startSchemaSync();
        return this.#schemaSync!;
    }

    /** Start the reconciliation, reporting a failure through `onError`. */
    #startSchemaSync(): void {
        const sync = this.#applySchema();
        this.#schemaSync = sync;

        // A background failure is reported, never thrown at the next query.
        sync.catch((err: any) => {
            const error = err instanceof DuckdbQuackError
                ? err
                : new DuckdbQuackError(`DuckDB: ${firstLine(err?.message ?? err)}`, "DUCKDB_SCHEMA_SYNC_FAILED", err);
            if (this.#options.onError) this.#options.onError(error);
            else console.error(error.message);
        });

        // Forget it once it settles: the next `syncSchema()` reconciles again
        // (which is idempotent — a table already in sync changes nothing).
        const settle = () => {
            if (this.#schemaSync === sync) this.#schemaSync = null;
        };
        sync.then(settle, settle);
    }

    async #applySchema(): Promise<DuckdbSchemaReport> {
        const report: DuckdbSchemaReport = { tables: [] };
        const declared = this.#options.tables ?? [];

        for (const table of declared) {
            const name = normaliseName(table?.name);
            const fields = table?.fields ?? [];
            const change: DuckdbSchemaChange = { table: name, created: false, added: [], retyped: [] };

            const actual = await this.#readColumns(name);
            if (!actual) {
                await this.#run(`CREATE TABLE IF NOT EXISTS ${this.#targeted(name)} (${fields.map(columnSql).join(", ")})`);
                this.#tables.add(name);
                this.#columns.delete(name);
                change.created = true;
                report.tables.push(change);
                continue;
            }

            const declared = new Map(fields.map((field) => [normaliseName(field.name).toLowerCase(), field]));
            const plan: ColumnPlan[] = actual.map((column) => {
                const field = declared.get(column.name.toLowerCase());
                return {
                    name: column.name,
                    sql: field ? declaredType(field) : column.sql, // never drop: keep the unknown ones
                    actualSql: column.sql,
                    existing: true,
                };
            });

            for (const field of fields) {
                const fieldName = normaliseName(field.name);
                if (actual.some((column) => column.name.toLowerCase() === fieldName.toLowerCase())) continue;
                plan.push({ name: fieldName, sql: declaredType(field), actualSql: null, existing: false });
                change.added.push(fieldName);
            }

            change.retyped = actual
                .filter((column) => {
                    const field = declared.get(column.name.toLowerCase());
                    return field !== undefined && normaliseType(declaredType(field)) !== normaliseType(column.sql);
                })
                .map((column) => column.name);

            if (change.added.length || change.retyped.length) {
                if (this.#options.url) await this.#rebuild(name, plan, actual);
                else await this.#alter(name, plan, change);
            }

            this.#columns.delete(name);
            report.tables.push(change);
        }

        return report;
    }

    /**
     * Apply a migration **in place** — the local instance supports `ALTER TABLE`.
     */
    async #alter(table: string, plan: ColumnPlan[], change: DuckdbSchemaChange): Promise<void> {
        for (const column of plan) {
            if (!column.existing) {
                // `required`/`primaryKey` only apply at creation: a column added to a
                // non-empty table cannot be NOT NULL without a default.
                await this.#run(
                    `ALTER TABLE ${this.#targeted(table)} ADD COLUMN ${quoteIdent(column.name)} ${column.sql}`,
                );
            } else if (normaliseType(column.sql) !== normaliseType(column.actualSql!)) {
                await this.#run(
                    `ALTER TABLE ${this.#targeted(table)} ALTER COLUMN ${quoteIdent(column.name)} SET DATA TYPE ${column.sql}`,
                );
            }
        }
    }

    /**
     * Apply a migration on an **attached remote**, which does not implement
     * `ALTER TABLE`. The rows are copied into a temp table, the table is recreated
     * with the reconciled schema and the rows are copied back — every existing
     * column is carried over, including the ones the declaration does not name.
     *
     * The copy is the safety net: if anything fails after the `DROP`, the original
     * table (its columns **and** its rows) is put back from it.
     *
     * ⚠️ The rows travel through the client's temp catalog: it is a startup
     * reconciliation, not an online migration (and not atomic).
     */
    async #rebuild(
        table: string,
        plan: ColumnPlan[],
        actual: Array<{ name: string; sql: string }>,
    ): Promise<void> {
        const target = this.#targeted(table);
        const copy = `${quoteIdent("temp")}.${quoteIdent(`__anteros_schema_${table}`)}`;

        await this.#run(`CREATE OR REPLACE TEMP TABLE ${copy} AS SELECT * FROM ${target}`);

        let dropped = false;
        try {
            await this.#run(`DROP TABLE ${target}`);
            dropped = true;
            await this.#run(
                `CREATE TABLE ${target} (${plan.map((column) => `${quoteIdent(column.name)} ${column.sql}`).join(", ")})`,
            );

            const values = plan.map((column) => {
                const value = !column.existing
                    ? `CAST(NULL AS ${column.sql})`
                    : normaliseType(column.sql) !== normaliseType(column.actualSql!)
                      ? `CAST(${quoteIdent(column.name)} AS ${column.sql})`
                      : quoteIdent(column.name);
                return `${value} AS ${quoteIdent(column.name)}`;
            });
            await this.#run(`INSERT INTO ${target} SELECT ${values.join(", ")} FROM ${copy}`);
        } catch (err) {
            if (dropped) {
                // Put the table back as it was — old columns first, then the rows.
                try {
                    await this.#run(`DROP TABLE IF EXISTS ${target}`);
                    await this.#run(
                        `CREATE TABLE ${target} (${actual.map((column) => `${quoteIdent(column.name)} ${column.sql}`).join(", ")})`,
                    );
                    await this.#run(`INSERT INTO ${target} SELECT * FROM ${copy}`);
                } catch {
                    // Leave the temp copy behind: the rows are still there, not lost.
                    throw new DuckdbQuackError(
                        `Migration of '${table}' failed and could not be rolled back — the rows are kept in '${copy}'`,
                        "DUCKDB_MIGRATION_ROLLBACK_FAILED",
                        err,
                    );
                }
            }
            throw err;
        } finally {
            await this.#run(`DROP TABLE IF EXISTS ${copy}`).catch(() => {});
        }
    }

    /** The columns of a table, or `null` when it does not exist. */
    async #readColumns(table: string): Promise<Array<{ name: string; sql: string }> | null> {
        const { connection } = await this.raw();
        try {
            return await this.#columnsOf(connection, table);
        } catch {
            return null;
        }
    }

    /** Run a statement whose SQL this class built itself (schema changes). */
    async #run(sql: string): Promise<void> {
        const { connection } = await this.raw();
        await connection.run(sql);
    }

    /** A table name, qualified with the attached catalog when there is one. */
    #targeted(table: string): string {
        return this.#options.url ? `${quoteIdent(this.alias)}.${quoteIdent(table)}` : quoteIdent(table);
    }

    // ─── Data tables (JSON documents) ─────────────────────────────────────

    /**
     * A table of **JSON documents** — two columns, `data` (`JSON`) and `ts`
     * (`TIMESTAMP`), and nothing else. It is created **in the background** when it
     * does not exist yet; `ingest()` waits for that creation.
     *
     * ```ts
     * const tickets = await db.table("tickets", { ts: "createdAt" });
     * await tickets.ingest([
     *     { ref: "A-1", total: 42, createdAt: "2026-10-01T08:30:00Z" },
     * ]);
     * await tickets.flush();
     *
     * const { rows } = await db.exec("SELECT ts, data->>'ref' AS ref FROM tickets");
     * ```
     *
     * `data` holds the document as it was given; `ts` defaults to the ingestion
     * time, or to the field named by `options.ts` (`createdAt`, `date`…).
     */
    async table(name: string, options: DuckdbTableOptions = {}): Promise<DuckdbTable> {
        const tableName = normaliseName(name);
        return new DuckdbTable(tableName, options, {
            // update/replace run on the server, where the table has no catalog prefix.
            target: quoteIdent(tableName),
            ensure: () => this.#ensureDataTable(tableName),
            insert: (rows, ts, batchSize) => this.#insertDocuments(tableName, rows, ts, batchSize),
            enqueue: (work) => this.#enqueueWrite(work),
            flush: () => this.flush(),
            query: (sql) => this.exec(sql),
        });
    }

    /**
     * Patch the documents matching `where` — **the predicate is mandatory**.
     *
     * ```ts
     * await db.update({
     *     table: "tickets",
     *     where: "data->>'ref' = 'A-1'",
     *     set: { total: 43, zone: "Z" },
     * });
     * ```
     *
     * `set` is a **JSON merge patch**: the named fields are merged into each
     * document, the others are left as they are.
     *
     * With `upsert: true`, a `where` that matches nothing inserts `set` as a new
     * document instead — `{ table, updated: 0, inserted: 1 }`. `set` then has to be
     * the whole document, identifying fields included; the `ts` column gets the
     * ingestion time.
     *
     * An **array** runs the updates in order and returns their results in the same
     * order. The batch is atomic: it opens a transaction when none is open (and
     * joins the caller's transaction otherwise), so a failure leaves nothing behind.
     */
    async update(options: DuckdbUpdateOptions): Promise<DuckdbTableUpdateResult>;
    async update(options: DuckdbUpdateOptions[]): Promise<DuckdbTableUpdateResult[]>;
    async update(
        options: DuckdbUpdateOptions | DuckdbUpdateOptions[],
    ): Promise<DuckdbTableUpdateResult | DuckdbTableUpdateResult[]> {
        if (!Array.isArray(options)) return this.#updateOne(options);
        return this.#batchWrites(options, (one) => this.#updateOne(one));
    }

    /** One `update` — the single-request implementation, transaction-aware. */
    async #updateOne(options: DuckdbUpdateOptions): Promise<DuckdbTableUpdateResult> {
        const table = normaliseName(options?.table);
        const predicate = requireWhere(options?.where, "update");
        const patch = options?.set;
        const upsert = options?.upsert === true;
        if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
            throw new DuckdbQuackError(
                "`update` needs `set` — an object of fields to merge into each document",
                "DUCKDB_SET_REQUIRED",
            );
        }

        if (this.#inTransaction && this.#options.url !== undefined) {
            const result = await this.#execOnRemote(
                `UPDATE ${quotePath(this.#serverTable(table))} SET "data" = json_merge_patch("data", ${quoteLiteral(JSON.stringify(patch))}) WHERE ${predicate}`,
            );
            const updated = affectedRows(result);
            if (updated === 0 && upsert) {
                // The UPDATE got past the binder, so the table exists: its columns
                // are read server-side, inside the open transaction. `#insertRemote`
                // takes rows keyed by column, not documents — `set` is the `data`.
                await this.#insertRemote(table, await this.#remoteColumns(table), [{ data: patch }]);
                return { table, updated: 0, inserted: 1 };
            }
            return { table, updated };
        }

        const handle = await this.table(table);
        const { updated } = await handle.update(predicate, patch);
        if (updated === 0 && upsert) {
            await this.#insertDocuments(table, [patch]);
            return { table, updated: 0, inserted: 1 };
        }
        return { table, updated };
    }

    /**
     * Replace the **whole** document of the rows matching `where` — it is not
     * merged with the previous one. The predicate is mandatory.
     *
     * ```ts
     * await db.replace({
     *     table: "tickets",
     *     where: "data->>'ref' = 'A-1'",
     *     set: { ref: "A-1", total: 43 },
     * });
     * ```
     *
     * An **array** runs the replacements in order and returns their results in the
     * same order, as one atomic batch (see `update`).
     */
    async replace(options: DuckdbReplaceOptions): Promise<DuckdbTableReplaceResult>;
    async replace(options: DuckdbReplaceOptions[]): Promise<DuckdbTableReplaceResult[]>;
    async replace(
        options: DuckdbReplaceOptions | DuckdbReplaceOptions[],
    ): Promise<DuckdbTableReplaceResult | DuckdbTableReplaceResult[]> {
        if (!Array.isArray(options)) return this.#replaceOne(options);
        return this.#batchWrites(options, (one) => this.#replaceOne(one));
    }

    /** One `replace` — the single-request implementation, transaction-aware. */
    async #replaceOne(options: DuckdbReplaceOptions): Promise<DuckdbTableReplaceResult> {
        const table = normaliseName(options?.table);
        const predicate = requireWhere(options?.where, "replace");
        const document = options?.set;
        if (document === null || typeof document !== "object" || Array.isArray(document)) {
            throw new DuckdbQuackError(
                "`replace` needs `set` — the whole object to store",
                "DUCKDB_SET_REQUIRED",
            );
        }

        if (this.#inTransaction && this.#options.url !== undefined) {
            const result = await this.#execOnRemote(
                `UPDATE ${quotePath(this.#serverTable(table))} SET "data" = CAST(${quoteLiteral(JSON.stringify(document))} AS JSON) WHERE ${predicate}`,
            );
            return { table, replaced: affectedRows(result) };
        }
        return (await this.table(table)).replace(predicate, document);
    }

    /**
     * Delete the rows matching `where` — **the predicate is mandatory**.
     *
     * ```ts
     * await db.delete({ table: "tickets", where: "data->>'ref' = 'A-2'" });
     * ```
     *
     * An **array** runs the deletes in order and returns their results in the same
     * order, as one atomic batch (see `update`).
     */
    async delete(options: DuckdbDeleteOptions): Promise<DuckdbTableDeleteResult>;
    async delete(options: DuckdbDeleteOptions[]): Promise<DuckdbTableDeleteResult[]>;
    async delete(
        options: DuckdbDeleteOptions | DuckdbDeleteOptions[],
    ): Promise<DuckdbTableDeleteResult | DuckdbTableDeleteResult[]> {
        if (!Array.isArray(options)) return this.#deleteOne(options);
        return this.#batchWrites(options, (one) => this.#deleteOne(one));
    }

    /** One `delete` — the single-request implementation, transaction-aware. */
    async #deleteOne(options: DuckdbDeleteOptions): Promise<DuckdbTableDeleteResult> {
        const table = normaliseName(options?.table);
        const predicate = requireWhere(options?.where, "delete");

        if (this.#inTransaction && this.#options.url !== undefined) {
            const result = await this.#execOnRemote(
                `DELETE FROM ${quotePath(this.#serverTable(table))} WHERE ${predicate}`,
            );
            return { table, deleted: affectedRows(result) };
        }
        return (await this.table(table)).delete(predicate);
    }

    /**
     * Run a write for each entry, **in order**, as one unit: the batch opens a
     * transaction when none is open and joins the caller's otherwise. An empty
     * list runs nothing; a failing entry rolls the whole batch back.
     */
    async #batchWrites<T, O>(options: O[], work: (one: O) => Promise<T>): Promise<T[]> {
        if (!options.length) return [];
        if (this.#inTransaction) {
            const results: T[] = [];
            for (const one of options) results.push(await work(one));
            return results;
        }
        return this.transaction(async () => {
            const results: T[] = [];
            for (const one of options) results.push(await work(one));
            return results;
        });
    }

    // ─── Retention (TTL) ──────────────────────────────────────────────────

    /**
     * Delete the rows older than a retention window — DuckDB has **no native
     * TTL**, so this is the mechanism: one `DELETE` per batch, on the server when
     * the instance is attached.
     *
     * ```ts
     * await db.purge({ table: "events", column: "ts", ttl: "30d" });
     * // → { table: "events", deleted: 12_430 }
     * ```
     *
     * `ttl` is a duration (`'30d'`, `'24h'`, `'90m'`, `'3600s'`, `'2w'`) or a
     * `Date`; `where` narrows it further. The column is cast to `TIMESTAMP`, so a
     * `DATE` or an ISO string works as well as a `TIMESTAMP`. A `batch`-sized
     * `DELETE` loops until the table is clean — no giant single statement.
     */
    async purge(options: DuckdbPurgeOptions): Promise<DuckdbPurgeResult> {
        const table = normaliseName(options?.table);
        const column = normaliseName(options?.column);
        if (options?.ttl === undefined) {
            throw new DuckdbQuackError(
                "`purge` needs `ttl` — a duration ('30d', '24h') or a Date",
                "DUCKDB_RETENTION_INVALID",
            );
        }
        const predicate = retentionPredicate(
            column,
            options.ttl,
            options.where === undefined ? undefined : requireWhere(options.where, "purge"),
        );
        const batch = Math.max(1, Math.trunc(options.batch ?? RETENTION_BATCH));
        const target = quotePath(this.#serverTable(table));

        let deleted = 0;
        for (;;) {
            const result = await this.exec(
                `DELETE FROM ${target} WHERE rowid IN (SELECT rowid FROM ${target} WHERE ${predicate} LIMIT ${batch})`,
            );
            const rows = affectedRows(result);
            deleted += rows;
            if (rows < batch) break;
        }
        this.#debug("purge", { table, ttl: String(options.ttl), deleted });
        return { table, deleted };
    }

    /**
     * Purge a table on a timer — the scheduled form of `purge`.
     *
     * ```ts
     * const job = db.retention({ table: "events", column: "ts", ttl: "30d", every: "1h" });
     * // … later
     * job.stop();
     * ```
     *
     * The timer is **unref'd**: a cleanup job never keeps the Bun process alive on
     * its own. A run is skipped while a transaction is open (the same connection is
     * shared), and failures go to `onError` — the timer keeps going.
     */
    retention(options: DuckdbRetentionOptions): DuckdbRetentionHandle {
        const table = normaliseName(options?.table);
        const column = normaliseName(options?.column);
        if (options?.ttl === undefined) {
            throw new DuckdbQuackError(
                "`retention` needs `ttl` — a duration ('30d', '24h') or a Date",
                "DUCKDB_RETENTION_INVALID",
            );
        }
        // Validate eagerly: a bad window should fail at declaration, not at 3 a.m.
        retentionPredicate(
            column,
            options.ttl,
            options.where === undefined ? undefined : requireWhere(options.where, "retention"),
        );
        const everyMs = retentionMs(options.every);
        if (everyMs < 1_000) {
            throw new DuckdbQuackError(
                "`retention` needs `every` of at least one second ('1s', '1h')",
                "DUCKDB_RETENTION_INVALID",
            );
        }

        const report = options.onError
            ?? this.#options.onError
            ?? ((error: Error) => console.error(error.message));

        let stopped = false;
        let inFlight = false;

        const run = async (): Promise<DuckdbPurgeResult> => {
            if (stopped || inFlight || this.#inTransaction) return { table, deleted: 0 };
            inFlight = true;
            try {
                return await this.purge(options);
            } catch (err: any) {
                report(err instanceof Error ? err : new Error(String(err)));
                return { table, deleted: 0 };
            } finally {
                inFlight = false;
            }
        };

        const timer = setInterval(() => { void run(); }, everyMs);
        // A cleanup job must not be the reason the process stays up.
        timer.unref?.();

        if (options.runOnStart !== false) void run();

        return {
            run,
            stop: () => {
                stopped = true;
                clearInterval(timer);
            },
            get running() {
                return !stopped;
            },
        };
    }

    /**
     * A data table has exactly two columns — `data` (`JSON`) and `ts`
     * (`TIMESTAMP`). It is created when missing; an existing table with another
     * shape is refused rather than written into blindly.
     */
    async #ensureDataTable(table: string): Promise<void> {
        const { connection } = await this.raw();

        if (!(await this.#exists(connection, table))) {
            await this.#run(
                `CREATE TABLE IF NOT EXISTS ${this.#targeted(table)} (${quoteIdent("data")} JSON, ${quoteIdent("ts")} TIMESTAMP)`,
            );
            this.#tables.add(table);
            this.#columns.delete(table);
            return;
        }

        const columns = await this.#columnsOf(connection, table);
        const names = new Set(columns.map((column) => column.name.toLowerCase()));
        if (!names.has("data") || !names.has("ts")) {
            throw new DuckdbQuackError(
                `Table '${table}' exists but is not a data table — expected the columns data (JSON) and ts (TIMESTAMP)`,
                "DUCKDB_TABLE_SHAPE_INVALID",
            );
        }
    }

    /** Write documents into a data table — one `data` value and one `ts` per row. */
    async #insertDocuments(
        table: string,
        rows: Array<Record<string, unknown>>,
        tsField?: string,
        batchSize?: number,
    ): Promise<void> {
        const target = this.#targeted(table);
        // Against an attached catalog, Quack 2.0 cannot take bind parameters: the
        // document and the timestamp travel as literals.
        const remote = this.#options.url !== undefined;

        await this.#insertIsolated(table, rows, batchSizeOf(batchSize), async (batch) => {
            const params: any[] = [];
            const tuples = batch.map((row) => {
                const ts = tsField !== undefined && row[tsField] !== undefined
                    ? toWallClock(row[tsField])
                    : formatTimestamp();
                if (remote) return `(CAST(${sqlLiteral(row)} AS JSON), CAST(${quoteLiteral(ts)} AS TIMESTAMP))`;
                params.push(bindable(row));
                params.push(ts);
                return `(CAST($${params.length - 1} AS JSON), CAST($${params.length} AS TIMESTAMP))`;
            });

            await this.#runWithParams(
                `INSERT INTO ${target} ("data", "ts") VALUES ${tuples.join(", ")}`,
                remote ? undefined : params,
            );
        });
    }

    /** Record a background write failure: `flush()` throws it once, `onError` sees it now. */
    #recordWriteError(err: any): void {
        const error = err instanceof DuckdbQuackError ? err : wrapEngineError("DuckDB:", err);
        if (!this.#writeError) this.#writeError = error;
        if (this.#options.debug) this.#debugError("background write failed", error);
        if (this.#options.onError) this.#options.onError(error);
        else if (!this.#options.debug) console.error(error.message);
    }

    /** Queue a write behind the ones already queued, recording a failure for `flush()`. */
    #enqueueWrite(work: () => Promise<void>): void {
        const next = this.#pending.then(work, work);
        // Attach the recorder first: `flush()` awaits `#pending`, and this callback
        // must have run by then.
        next.catch((err: any) => this.#recordWriteError(err));
        this.#pending = next.catch(() => {});
    }

    /** Run a statement with bound values — the SQL this class builds itself. */
    async #runWithParams(sql: string, values?: any[]): Promise<void> {
        const { connection } = await this.raw();
        await connection.run(sql, values);
    }

    // ─── Query ────────────────────────────────────────────────────────────

    /**
     * Run one statement and return its rows.
     *
     * On an attached instance it runs **on the Quack server**
     * (`quack_query_by_name`): the remote computes, and only the result crosses
     * the wire. A statement with bound `values` runs in the **client's** engine —
     * Quack 2.0 cannot carry parameters to a remote catalog, so the values are
     * inlined as SQL literals before the statement is sent.
     *
     * ```ts
     * await db.exec("SELECT SUM(CAST(data.prix AS INT)) AS total FROM tickets");  // server
     * await db.exec("SELECT * FROM tickets WHERE id = $1", ["a-1"]);              // client (values)
     * ```
     */
    async exec(
        sql: string,
        valuesOrOptions?: any[] | Record<string, any> | DuckdbExecOptions,
    ): Promise<DuckdbExecResult> {
        if (typeof sql !== "string" || !sql.trim()) {
            throw new DuckdbQuackError("`exec` needs a SQL statement", "DUCKDB_SQL_REQUIRED");
        }

        const { values } = splitExecArguments(valuesOrOptions);
        try {
            return await this.#execute(sql, values);
        } catch (err: any) {
            // A restarted server invalidates the attachment. `autoReattach` decides
            // whether this call re-attaches and runs again: reads by default, any
            // statement with `'always'`, never with `false`.
            if (!this.#shouldReattachAfter(err, sql)) throw err;
            await this.reattach();
            return this.#execute(sql, values);
        }
    }

    /** One execution on the right engine — `exec` retries it once after a re-attach. */
    async #execute(sql: string, values?: any[] | Record<string, any>): Promise<DuckdbExecResult> {
        // Without values the statement is shipped to the server as text. Values
        // force the client engine (the server cannot take parameters), where they
        // are inlined first — see `#execOnClient`.
        if (this.#options.url !== undefined && values === undefined) {
            return this.#execOnRemote(sql);
        }

        return this.#execOnClient(sql, values);
    }

    /** Whether `exec` may re-attach and retry this statement — see `autoReattach`. */
    #shouldReattachAfter(err: any, sql: string): boolean {
        if (err?.code !== "DUCKDB_QUACK_DATABASE_INVALIDATED") return false;
        if (this.#options.url === undefined || this.#inTransaction) return false;
        const mode = this.#options.autoReattach ?? "reads";
        if (mode === false) return false;
        return mode === true || mode === "always" || looksReadOnly(sql);
    }

    /**
     * Run the statement in the client's DuckDB engine.
     *
     * On an attached instance the values are inlined as SQL literals first: Quack
     * 2.0 prepares the statement on the remote catalog and does not carry bind
     * parameters over the wire, so `$1` would fail with "Values were not provided"
     * even for a purely local expression.
     */
    async #execOnClient(sql: string, values?: any[] | Record<string, any>): Promise<DuckdbExecResult> {
        const { connection } = await this.raw();
        const inlined = this.#options.url !== undefined && values !== undefined;
        const statement = inlined ? inlineParameters(sql, values) : sql;
        const params = inlined ? undefined : values;
        const started = performance.now();
        try {
            const reader = await connection.runAndReadAll(statement, params);
            const result = {
                columns: reader.columnNames(),
                types: reader.columnTypes().map((type) => String(type)),
                rows: reader.getRowObjectsJson() as Record<string, unknown>[],
            };
            const duration = performance.now() - started;
            this.#debug("client", { sql: preview(sql), ms: Math.round(duration), rows: result.rows.length });
            return { ...result, duration_ms: duration };
        } catch (err: any) {
            this.#debugError("client failed", err, { sql: preview(sql) });
            throw wrapEngineError("DuckDB:", err);
        }
    }

    /**
     * Run the statement on the attached Quack server — `quack_query_by_name`
     * carries the SQL, so the attachment's connection, token and transport options
     * are reused instead of being restated on every call.
     */
    async #execOnRemote(sql: string): Promise<DuckdbExecResult> {
        const { connection } = await this.raw();
        const started = performance.now();
        try {
            const reader = await connection.runAndReadAll(
                `SELECT * FROM quack_query_by_name($1, $2)`,
                [this.alias, sql],
            );
            const result = {
                columns: reader.columnNames(),
                types: reader.columnTypes().map((type) => String(type)),
                rows: reader.getRowObjectsJson() as Record<string, unknown>[],
            };
            const duration = performance.now() - started;
            this.#debug("server", { sql: preview(sql), ms: Math.round(duration), rows: result.rows.length });
            return { ...result, duration_ms: duration };
        } catch (err: any) {
            this.#debugError("server failed", err, { sql: preview(sql) });
            throw wrapEngineError("DuckDB (server):", err);
        }
    }

    /**
     * Run `work` inside a transaction — `BEGIN TRANSACTION` / `COMMIT`, and
     * `ROLLBACK` when `work` throws.
     *
     * On an attached instance the transaction lives **on the Quack server**, and
     * `tx.exec` stays there (values are inlined). `ingest` joins it too — provided
     * the table already exists — as do the instance-level `update`, `replace` and
     * `delete`. `createTable` and `deleteTable` run in the client engine and do
     * **not** join: create the table before the transaction, or with
     * `tx.exec("CREATE TABLE …")`.
     *
     * ```ts
     * await db.transaction(async (tx) => {
     *     await tx.exec("INSERT INTO orders VALUES ($1, $2)", ["A-1", 42]);
     *     await tx.exec("UPDATE stock SET qty = qty - 1 WHERE sku = 'A-1'");
     * });
     * ```
     *
     * Nested transactions are refused (`DUCKDB_TRANSACTION_NESTED`). The connection
     * is shared: do not run concurrent queries on the same instance while it runs.
     */
    async transaction<T>(work: (tx: DuckdbTransaction) => Promise<T>): Promise<T> {
        if (this.#inTransaction) {
            throw new DuckdbQuackError(
                "Nested transactions are not supported — one at a time per instance",
                "DUCKDB_TRANSACTION_NESTED",
            );
        }

        this.#inTransaction = true;
        // Catalog caches learn about tables created inside the transaction; a
        // rollback removes them from DuckDB too, so the caches go back as well.
        const tables = new Set(this.#tables);
        const columns = new Map(this.#columns);
        try {
            await this.exec("BEGIN TRANSACTION");
            try {
                const result = await work({
                    exec: (sql, values) => this.#execInTransaction(sql, values),
                });
                await this.exec("COMMIT");
                return result;
            } catch (err) {
                await this.exec("ROLLBACK").catch(() => {});
                this.#tables = tables;
                this.#columns = columns;
                throw err;
            }
        } finally {
            this.#inTransaction = false;
        }
    }

    /**
     * `exec` for an open transaction: always server-side when attached, with the
     * values inlined, so client-side writes cannot break the transaction.
     */
    async #execInTransaction(
        sql: string,
        values?: any[] | Record<string, any>,
    ): Promise<DuckdbExecResult> {
        if (typeof sql !== "string" || !sql.trim()) {
            throw new DuckdbQuackError("`exec` needs a SQL statement", "DUCKDB_SQL_REQUIRED");
        }

        if (this.#options.url === undefined) return this.#execOnClient(sql, values);

        const statement = values === undefined ? sql : inlineParameters(sql, values);
        return this.#execOnRemote(statement);
    }

    // ─── Schema ───────────────────────────────────────────────────────────

    /** Create a table if it is not there yet; columns default to the instance's. */
    async createTable(table: string, columns?: DuckdbColumn[]): Promise<DuckdbTableInfo> {
        const { connection } = await this.raw();
        const name = normaliseName(table);
        const cols = this.#columnsFor(columns);

        try {
            const existed = await this.#exists(connection, name);
            await connection.run(
                `CREATE TABLE IF NOT EXISTS ${this.#targeted(name)} (${cols.map(columnSql).join(", ")})`,
            );
            this.#tables.add(name);
            this.#columns.delete(name);
            this.#debug("create table", { table: name, columns: cols.map((column) => column.name), created: !existed });
            return { table: name, columns: cols.map((column) => column.name), created: !existed };
        } catch (err: any) {
            this.#debugError("create table failed", err, { table: name });
            throw new DuckdbQuackError(`DuckDB: ${firstLine(err?.message)}`, "DUCKDB_ERROR", err);
        }
    }

    /** Drop a table — no error when it was not there. */
    async deleteTable(table: string): Promise<DuckdbTableInfo> {
        const { connection } = await this.raw();
        const name = normaliseName(table);

        try {
            const existed = await this.#exists(connection, name);
            await connection.run(`DROP TABLE IF EXISTS ${this.#targeted(name)}`);
            this.#tables.delete(name);
            this.#columns.delete(name);
            this.#debug("delete table", { table: name, dropped: existed });
            return { table: name, columns: [], created: false, dropped: existed };
        } catch (err: any) {
            this.#debugError("delete table failed", err, { table: name });
            throw new DuckdbQuackError(`DuckDB: ${firstLine(err?.message)}`, "DUCKDB_ERROR", err);
        }
    }

    /**
     * Every table of the attached remote, or of the local catalog when the
     * instance is not attached.
     */
    async listTables(): Promise<string[]> {
        if (this.#options.url) {
            const { connection } = await this.raw();
            try {
                // `information_schema` only describes the local catalog, so the
                // remote's own `duckdb_tables()` is asked through the attachment.
                const reader = await connection.runAndReadAll(
                    `SELECT table_name FROM quack_query_by_name($1, $2) ORDER BY 1`,
                    [this.alias, "SELECT table_name FROM duckdb_tables() WHERE database_name = current_database()"],
                );
                return (reader.getRowObjectsJson() as any[]).map((row) => String(row.table_name));
            } catch (err: any) {
                throw new DuckdbQuackError(
                    `Cannot list the tables of '${this.#options.url}' — ${firstLine(err?.message)}`,
                    "DUCKDB_ERROR",
                    err,
                );
            }
        }

        const { rows } = await this.#execOnClient(
            `SELECT table_name FROM information_schema.tables WHERE table_catalog = current_database() ORDER BY table_name`,
        );
        return rows.map((row) => String(row.table_name));
    }

    // ─── Full-text search ─────────────────────────────────────────────────

    /**
     * Build (or rebuild) a full-text index with DuckDB's `fts` extension.
     *
     * On an attached instance the `PRAGMA` runs **on the Quack server**, next to
     * the table it indexes; the search macro lives in the schema it returns
     * (`fts_main_<table>`). The extension is autoloaded on first use.
     *
     * `overwrite: false` keeps an existing index as it is, and creates it only
     * when missing — what a restart wants; the default (`true`) rebuilds it.
     *
     * ```ts
     * await db.createFtsIndex("documents", {
     *     id: "document_identifier",
     *     fields: ["text_content", "author"],
     *     stemmer: "english",
     * });
     * ```
     */
    async createFtsIndex(table: string, options: DuckdbFtsIndexOptions): Promise<DuckdbFtsIndexInfo> {
        const name = this.#serverTable(table);
        const id = normaliseName(options?.id);
        const fields = options?.fields;
        const indexed = fields === "*"
            ? ["*"]
            : typeof fields === "string"
                ? [normaliseName(fields)]
                : Array.isArray(fields)
                    ? fields.map((field) => normaliseName(field))
                    : [];

        if (!indexed.length) {
            throw new DuckdbQuackError(
                "`createFtsIndex` needs `fields` — one column name, a list, or '*'",
                "DUCKDB_FTS_FIELDS_REQUIRED",
            );
        }

        const index = ftsSchemaName(name);
        const overwrite = options.overwrite ?? true;

        // `overwrite: false` means "keep what is there": DuckDB itself would error
        // on an existing index instead of skipping it.
        if (!overwrite && await this.#ftsIndexExists(index)) {
            this.#ftsFields.delete(name);
            return { table: name, index };
        }

        // PRAGMA arguments are literals; named ones use `=`, not `:=`.
        const args = [quoteLiteral(name), quoteLiteral(id), ...indexed.map(quoteLiteral)];
        args.push(`overwrite = ${overwrite}`);

        if (options.stemmer !== undefined) args.push(`stemmer = ${quoteLiteral(options.stemmer)}`);
        if (options.stopwords !== undefined) args.push(`stopwords = ${quoteLiteral(options.stopwords)}`);
        if (options.ignore !== undefined) args.push(`ignore = ${quoteLiteral(options.ignore)}`);
        if (options.stripAccents !== undefined) args.push(`strip_accents = ${options.stripAccents === true}`);
        if (options.lower !== undefined) args.push(`lower = ${options.lower === true}`);
        if (options.incremental !== undefined) args.push(`incremental = ${options.incremental === true}`);

        await this.exec(`PRAGMA create_fts_index(${args.join(", ")})`);
        this.#ftsFields.delete(name);
        return { table: name, index };
    }

    /** Drop the full-text index of a table; `dropped: false` when there was none. */
    async dropFtsIndex(table: string): Promise<DuckdbFtsDropResult> {
        const name = this.#serverTable(table);
        try {
            await this.exec(`PRAGMA drop_fts_index(${quoteLiteral(name)})`);
            this.#ftsFields.delete(name);
            return { table: name, dropped: true };
        } catch (err: any) {
            if (/does not exist/i.test(String(err?.message ?? ""))) {
                this.#ftsFields.delete(name);
                return { table: name, dropped: false };
            }
            throw err;
        }
    }

    /**
     * Search a full-text index, best match first — `score` is the BM25 score.
     *
     * ```ts
     * const { rows } = await db.searchFts("documents", "small cats", {
     *     id: "document_identifier",
     *     limit: 10,
     * });
     * ```
     *
     * On an attached instance the search runs **on the Quack server**, where the
     * index lives. `match_bm25` takes the identifier **column**, not its name as a
     * string — the method quotes the column for you.
     *
     * `fields` is validated against the index's own field list, so a typo fails
     * with `DUCKDB_FTS_FIELD_UNKNOWN` instead of an empty result.
     */
    async searchFts(table: string, query: string, options: DuckdbFtsSearchOptions): Promise<DuckdbFtsSearchResult> {
        const name = this.#serverTable(table);
        const id = normaliseName(options?.id);
        const text = String(query ?? "").trim();
        if (!text) {
            throw new DuckdbQuackError("`searchFts` needs a query string", "DUCKDB_FTS_QUERY_REQUIRED");
        }

        const match = [quoteIdent(id), quoteLiteral(text)];

        if (options.fields !== undefined) {
            const requested = fieldList(options.fields);
            if (!requested.length) {
                throw new DuckdbQuackError("`searchFts` got an empty `fields` option", "DUCKDB_FTS_OPTION_INVALID");
            }

            // `fields: '*'` means "all indexed fields" — no `fields` argument and
            // no validation. Anything else must be one of the indexed columns.
            if (!(requested.length === 1 && requested[0] === "*")) {
                const indexed = await this.#ftsFieldsFor(name, ftsSchemaName(name));
                const unknown = requested.filter((field) => !indexed.has(field));
                if (unknown.length) {
                    throw new DuckdbQuackError(
                        `Unknown full-text field(s) ${unknown.map((field) => `'${field}'`).join(", ")} — indexed: ${[...indexed].join(", ")}`,
                        "DUCKDB_FTS_FIELD_UNKNOWN",
                    );
                }
                match.push(`fields := ${quoteLiteral(requested.join(", "))}`);
            }
        }

        if (options.k !== undefined) match.push(`k := ${finiteNumber(options.k, "k")}`);
        if (options.b !== undefined) match.push(`b := ${finiteNumber(options.b, "b")}`);
        if (options.conjunctive !== undefined) match.push(`conjunctive := ${options.conjunctive === true}`);

        if (options.select !== undefined && !Array.isArray(options.select)) {
            throw new DuckdbQuackError("`select` takes an array of column names", "DUCKDB_FTS_OPTION_INVALID");
        }
        const selected = (options.select ?? []).map((column) => normaliseName(column));
        let projection: string;
        if (selected.length === 0 || selected.includes("*")) {
            projection = "*";
        } else {
            // `score` is always appended; listing it would produce `score, score`.
            const columns = selected.filter((column) => column.toLowerCase() !== "score");
            projection = columns.length
                ? `${columns.map((column) => quoteIdent(column)).join(", ")}, score`
                : "score";
        }

        const conditions = ["score IS NOT NULL"];
        if (options.where !== undefined && String(options.where).trim()) {
            // A raw SQL predicate by design: callers must not pass untrusted input.
            conditions.push(`(${String(options.where).trim()})`);
        }

        const requestedLimit = options.limit === undefined ? FTS_DEFAULT_LIMIT : finiteNumber(options.limit, "limit");
        if (requestedLimit < 0) {
            throw new DuckdbQuackError("`limit` cannot be negative", "DUCKDB_FTS_OPTION_INVALID");
        }
        const limit = requestedLimit > 0 ? ` LIMIT ${Math.trunc(requestedLimit)}` : "";

        // The index schema and the table are server-side names: run the search
        // through `exec` (which goes to the server when attached).
        const sql = `SELECT ${projection}
                       FROM (
                         SELECT *, ${quoteIdent(ftsSchemaName(name))}.match_bm25(${match.join(", ")}) AS score
                           FROM ${quotePath(name)}
                       ) sq
                      WHERE ${conditions.join(" AND ")}
                      ORDER BY score DESC${limit}`;

        const { rows, duration_ms } = await this.exec(sql);
        return { table: name, query: text, rows, duration_ms };
    }

    /** The fields of an index, cached — read from the FTS schema DuckDB created. */
    async #ftsFieldsFor(table: string, index: string): Promise<Set<string>> {
        const cached = this.#ftsFields.get(table);
        if (cached) return cached;

        let rows: Record<string, unknown>[];
        try {
            ({ rows } = await this.exec(`SELECT field FROM ${quoteIdent(index)}.fields`));
        } catch (err: any) {
            throw new DuckdbQuackError(
                `No full-text index on '${table}' — create it with \`createFtsIndex\``,
                "DUCKDB_FTS_INDEX_MISSING",
                err,
            );
        }

        const fields = new Set(rows.map((row) => String(row.field)));
        this.#ftsFields.set(table, fields);
        return fields;
    }

    /** Whether the FTS schema exists — on the server when attached. */
    async #ftsIndexExists(index: string): Promise<boolean> {
        const { rows } = await this.exec(
            `SELECT count(*) AS n FROM duckdb_schemas() WHERE schema_name = ${quoteLiteral(index)}`,
        );
        return Number(rows[0]?.n ?? 0) > 0;
    }

    /** The table name as the **server** knows it: the client alias is stripped. */
    #serverTable(table: string): string {
        const parts = parsePath(table);
        if (this.#options.url !== undefined && parts.length >= 2 && parts[0] === this.alias) {
            parts.shift();
        }
        return parts.join(".");
    }

    // ─── Vector similarity search ─────────────────────────────────────────

    /**
     * Build (or rebuild) an HNSW index on a `FLOAT[N]` column.
     *
     * `vss` is **not autoloaded** like `fts`: the first call runs `LOAD vss`
     * (installing it if needed) on the instance — on the Quack server when
     * attached. Experimental persistence is enabled by default
     * (`hnsw_enable_experimental_persistence`); `persist` is only needed if it was
     * explicitly disabled.
     *
     * ```ts
     * await db.createVssIndex("embeddings", { column: "vec", metric: "cosine" });
     * ```
     */
    async createVssIndex(table: string, options: DuckdbVssIndexOptions): Promise<DuckdbVssIndexInfo> {
        const name = this.#serverTable(table);
        const column = normaliseName(options?.column);
        const metric = vssMetric(options?.metric);
        const index = normaliseName(options?.name ?? vssIndexName(name, column));
        const overwrite = options.overwrite ?? true;

        await this.#ensureVss();
        if (options.persist) {
            // `SET GLOBAL` so the statement that builds the index sees it, including
            // through `quack_query_by_name`.
            await this.exec("SET GLOBAL hnsw_enable_experimental_persistence = true");
        }

        if (!overwrite && await this.#vssIndexExists(name, index)) {
            return { table: name, index, metric };
        }
        if (overwrite) {
            await this.exec(`DROP INDEX IF EXISTS ${quotePath(vssIndexRef(name, index))}`);
        }

        const withOptions = [`metric = ${quoteLiteral(metric)}`];
        if (options.efConstruction !== undefined) {
            withOptions.push(`ef_construction = ${Math.trunc(finiteNumber(options.efConstruction, "efConstruction"))}`);
        }
        if (options.efSearch !== undefined) {
            withOptions.push(`ef_search = ${Math.trunc(finiteNumber(options.efSearch, "efSearch"))}`);
        }
        if (options.m !== undefined) {
            withOptions.push(`M = ${Math.trunc(finiteNumber(options.m, "m"))}`);
        }
        if (options.m0 !== undefined) {
            withOptions.push(`M0 = ${Math.trunc(finiteNumber(options.m0, "m0"))}`);
        }

        await this.exec(
            `CREATE INDEX ${quoteIdent(index)} ON ${quotePath(name)} USING HNSW (${quoteIdent(column)}) WITH (${withOptions.join(", ")})`,
        );
        return { table: name, index, metric };
    }

    /**
     * Drop an HNSW index. Give its `name`, or its `column` — the default name is
     * derived from both.
     */
    async dropVssIndex(
        table: string,
        options: { column?: string; name?: string } = {},
    ): Promise<DuckdbVssDropResult> {
        const name = this.#serverTable(table);
        if (options.name === undefined && options.column === undefined) {
            throw new DuckdbQuackError(
                "`dropVssIndex` needs the index `name`, or the indexed `column`",
                "DUCKDB_VSS_INDEX_REQUIRED",
            );
        }
        const index = normaliseName(options.name ?? vssIndexName(name, normaliseName(options.column!)));

        await this.#ensureVss();
        const existed = await this.#vssIndexExists(name, index);
        if (existed) await this.exec(`DROP INDEX IF EXISTS ${quotePath(vssIndexRef(name, index))}`);
        return { table: name, index, dropped: existed };
    }

    /**
     * Nearest neighbours of `vector`, closest first — `distance` is appended to
     * every row.
     *
     * ```ts
     * const { rows } = await db.searchVss("embeddings", [0.1, 0.2, 0.3], {
     *     column: "vec",
     *     metric: "cosine",
     *     limit: 5,
     * });
     * ```
     *
     * The HNSW index accelerates the query only when the metric matches the index,
     * and the shape is `ORDER BY <distance>(col, constant) LIMIT n`. A `where`
     * predicate is allowed but may make the planner fall back to a scan.
     */
    async searchVss(
        table: string,
        vector: number[],
        options: DuckdbVssSearchOptions,
    ): Promise<DuckdbVssSearchResult> {
        const name = this.#serverTable(table);
        const column = normaliseName(options?.column);
        const metric = vssMetric(options?.metric);
        const sqlVector = vssVector(vector);
        const distance = `${vssDistanceFunction(metric)}(${quoteIdent(column)}, ${sqlVector})`;

        const limit = options.limit === undefined ? VSS_DEFAULT_LIMIT : Math.trunc(finiteNumber(options.limit, "limit"));
        if (limit <= 0) {
            throw new DuckdbQuackError("`limit` must be greater than 0", "DUCKDB_VSS_OPTION_INVALID");
        }

        if (options.select !== undefined && !Array.isArray(options.select)) {
            throw new DuckdbQuackError("`select` takes an array of column names", "DUCKDB_VSS_OPTION_INVALID");
        }
        const selected = (options.select ?? []).map((columnName) => normaliseName(columnName));
        let projection: string;
        if (selected.length === 0 || selected.includes("*")) {
            projection = "*";
        } else {
            const columns = selected.filter((columnName) => columnName.toLowerCase() !== "distance");
            projection = columns.length
                ? `${columns.map((columnName) => quoteIdent(columnName)).join(", ")}, ${distance} AS distance`
                : `${distance} AS distance`;
        }
        // `*` already carries the source columns; append the distance once.
        if (projection === "*") projection = `*, ${distance} AS distance`;

        const conditions: string[] = [];
        if (options.where !== undefined && String(options.where).trim()) {
            // A raw SQL predicate by design: callers must not pass untrusted input.
            conditions.push(`(${String(options.where).trim()})`);
        }

        await this.#ensureVss();

        const sql = `SELECT ${projection}
                       FROM ${quotePath(name)}
                      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
                      ORDER BY ${distance}
                      LIMIT ${limit}`;

        const { rows, duration_ms } = await this.exec(sql);
        return { table: name, column, metric, rows, duration_ms };
    }

    /** Load `vss` once per instance — installing it if it is not there. */
    async #ensureVss(): Promise<void> {
        if (this.#vssLoaded) return;
        try {
            await this.exec("LOAD vss");
        } catch {
            await this.exec("INSTALL vss");
            await this.exec("LOAD vss");
        }
        this.#vssLoaded = true;
    }

    /** Whether an index with that name exists in the table's schema. */
    async #vssIndexExists(table: string, index: string): Promise<boolean> {
        const parts = parsePath(table);
        const schema = parts.length >= 2 ? parts[parts.length - 2]! : "main";
        const { rows } = await this.exec(
            `SELECT count(*) AS n FROM duckdb_indexes() WHERE index_name = ${quoteLiteral(index)} AND schema_name = ${quoteLiteral(schema)}`,
        );
        return Number(rows[0]?.n ?? 0) > 0;
    }

    // ─── Session variables ────────────────────────────────────────────────

    /**
     * Set a session variable (`SET VARIABLE name = value`).
     *
     * Scalars are passed as SQL literals: string, number, boolean, `null`, and
     * `Date` (as `TIMESTAMP`). For a DuckDB list, map or a query result, run the
     * statement yourself — `db.exec("SET VARIABLE files = (SELECT list(...) …)")`.
     *
     * On an attached instance the statement runs **on the Quack server**, and the
     * variable stays for the following `exec` calls (session scope).
     */
    async setVar(name: string, value: unknown): Promise<{ name: string }> {
        const variable = normaliseName(name);
        await this.exec(`SET VARIABLE ${quoteIdent(variable)} = ${variableLiteral(value)}`);
        return { name: variable };
    }

    /** Read a session variable; `null` when it is not set (`getvariable`). */
    async getVar(name: string): Promise<unknown> {
        const variable = normaliseName(name);
        const { rows } = await this.exec(`SELECT getvariable(${quoteLiteral(variable)}) AS value`);
        return rows[0]?.value ?? null;
    }

    /** Unset a session variable (`RESET VARIABLE`). */
    async resetVar(name: string): Promise<{ name: string }> {
        const variable = normaliseName(name);
        await this.exec(`RESET VARIABLE ${quoteIdent(variable)}`);
        return { name: variable };
    }

    /** Every session variable with its type (`duckdb_variables()`). */
    async listVars(): Promise<DuckdbVariable[]> {
        const { rows } = await this.exec(
            "SELECT name, value, type FROM duckdb_variables() ORDER BY name",
        );
        return rows.map((row) => ({
            name: String(row.name),
            value: row.value === null || row.value === undefined ? null : String(row.value),
            type: String(row.type),
        }));
    }

    /**
     * Run a read-only catalog probe, re-attaching once when the server invalidated
     * the attachment. Probes bypass `exec`, so `autoReattach` is applied here too.
     */
    async #probeRead<T>(work: () => Promise<T>): Promise<T> {
        try {
            return await work();
        } catch (err: any) {
            const wrapped = wrapEngineError("DuckDB:", err);
            if (wrapped.code !== "DUCKDB_QUACK_DATABASE_INVALIDATED") throw wrapped;
            if (this.#options.url === undefined || this.#inTransaction) throw wrapped;
            if ((this.#options.autoReattach ?? "reads") === false) throw wrapped;
            await this.reattach();
            try {
                return await work();
            } catch (err2: any) {
                throw wrapEngineError("DuckDB:", err2);
            }
        }
    }

    async #exists(connection: DuckDBConnection, table: string): Promise<boolean> {
        if (this.#options.url) {
            // `information_schema` only describes the *local* catalog, so the remote
            // is probed with a zero-row select instead. A missing table is `false`;
            // an invalidated attachment is retried by `#probeRead`.
            return this.#probeRead(async () => {
                try {
                    await connection.runAndReadAll(`SELECT * FROM ${this.#targeted(table)} LIMIT 0`);
                    return true;
                } catch (err: any) {
                    if (isInvalidated(err)) throw err;
                    return false;
                }
            });
        }

        const reader = await connection.runAndReadAll(
            `SELECT count(*) AS n FROM information_schema.tables WHERE table_name = $1 AND table_catalog = current_database()`,
            [table],
        );
        const [row] = reader.getRowObjectsJson() as any[];
        return Number(row?.n ?? 0) > 0;
    }

    /** The columns of an existing table, as DuckDB reports them. */
    async #columnsOf(connection: DuckDBConnection, table: string): Promise<Array<{ name: string; sql: string }>> {
        const cached = this.#columns.get(table);
        if (cached) return cached;

        if (this.#options.url) {
            // The remote's own `information_schema` is not attached — a zero-row
            // select is what reports the columns it actually has. The probe is a
            // read, so a restarted server is retried (`autoReattach: 'reads'`).
            try {
                const reader = await this.#probeRead(async () =>
                    connection.runAndReadAll(`SELECT * FROM ${this.#targeted(table)} LIMIT 0`));
                const types = reader.columnTypes().map((type) => String(type));
                const columns = reader.columnNames().map((name, index) => ({ name, sql: types[index] ?? "VARCHAR" }));
                if (!columns.length) throw new Error("no columns");
                this.#columns.set(table, columns);
                return columns;
            } catch (err: any) {
                if (err instanceof DuckdbQuackError && err.code === "DUCKDB_QUACK_DATABASE_INVALIDATED") throw err;
                throw new DuckdbQuackError(
                    `Table '${table}' does not exist on the remote '${this.#options.url}'`,
                    "DUCKDB_TABLE_NOT_FOUND",
                    err,
                );
            }
        }

        const reader = await connection.runAndReadAll(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND table_catalog = current_database() ORDER BY ordinal_position`,
            [table],
        );
        const columns = (reader.getRowObjectsJson() as any[]).map((row) => ({
            name: String(row.column_name),
            sql: String(row.data_type),
        }));
        if (!columns.length) throw new DuckdbQuackError(`Table '${table}' does not exist`, "DUCKDB_TABLE_NOT_FOUND");

        this.#columns.set(table, columns);
        return columns;
    }

    #columnsFor(columns?: DuckdbColumn[]): DuckdbColumn[] {
        if (columns?.length) return columns;
        return this.#options.columns?.length ? this.#options.columns : DEFAULT_COLUMNS;
    }

    /**
     * Columns of an existing table, read **on the server** — the probes used
     * outside a transaction would run in the client engine and cannot see it.
     */
    async #remoteColumns(table: string): Promise<Array<{ name: string; sql: string }>> {
        const target = quotePath(this.#serverTable(table));
        const probe = await this.#execOnRemote(`SELECT * FROM ${target} LIMIT 0`);
        return probe.columns.map((name, index) => ({ name, sql: probe.types[index] ?? "VARCHAR" }));
    }

    // ─── Ingest ───────────────────────────────────────────────────────────

    /**
     * Queue rows into a table — **in the background**.
     *
     * The call returns as soon as the rows are queued: the table is created if it
     * is missing, then the batch is written by the drain loop. Await `flush()` when
     * the write has to be over before you move on (a script that exits, a test, the
     * shutdown path). A failure is reported through `onError` **and** thrown by the
     * next `flush()` — the rows did not land, and the caller must know.
     */
    async ingest(options: DuckdbIngestOptions): Promise<DuckdbIngestResult> {
        const table = normaliseName(options?.table);
        const rows = options?.rows;
        if (!Array.isArray(rows)) {
            throw new DuckdbQuackError("`ingest` needs `rows` to be an array", "DUCKDB_ROWS_REQUIRED");
        }
        if (!rows.length) return { table, queued: 0 };

        // The schema is resolved now, not in the drain: a wrong table name should
        // fail while the caller is still there to see it.
        const { connection } = await this.raw();
        const inTransaction = this.#inTransaction;
        const remote = this.#options.url !== undefined;
        const batchSize = batchSizeOf(options.insertBatchSize);

        // Inside a server transaction, resolve the columns server-side: client-side
        // catalog probes do not see the open transaction and can end it.
        if (inTransaction && remote) {
            let columns: Array<{ name: string; sql: string }>;
            try {
                columns = await this.#remoteColumns(table);
            } catch (err: any) {
                throw new DuckdbQuackError(
                    `\`ingest\` inside a transaction needs an existing table '${table}' — ${firstLine(err?.message)}`,
                    "DUCKDB_TRANSACTION_TABLE_REQUIRED",
                    err,
                );
            }
            await this.#insertRemote(table, columns, rows as Array<Record<string, unknown>>, batchSize);
            return { table, queued: rows.length };
        }

        if (!this.#tables.has(table)) {
            const exists = await this.#exists(connection, table);
            if (!exists) {
                await this.createTable(table, options.columns);
            } else {
                this.#tables.add(table);
            }
        }
        const columns = await this.#columnsOf(connection, table);

        if (inTransaction) {
            // Local instance: same connection, so the write is transactional.
            await this.#insert(connection, table, columns, rows as Array<Record<string, unknown>>, batchSize);
            return { table, queued: rows.length };
        }

        this.#enqueueWrite(async () => {
            try {
                await this.#insert(connection, table, columns, rows as Array<Record<string, unknown>>, batchSize);
            } catch (err: any) {
                if (err instanceof DuckdbQuackError) {
                    throw new DuckdbQuackError(`DuckDB ingest into '${table}' failed: ${firstLine(err.message)}`, err.code, err);
                }
                throw wrapEngineError(`DuckDB ingest into '${table}' failed:`, err);
            }
        });

        return { table, queued: rows.length };
    }

    /**
     * Write rows in batches; when a batch fails, replay it **row by row** so the
     * error names the offending row. Skipped for a dead attachment or an internal
     * error: the whole database is gone, every replay would blame the first row.
     */
    async #insertIsolated(
        table: string,
        rows: Array<Record<string, unknown>>,
        batchSize: number,
        write: (batch: Array<Record<string, unknown>>) => Promise<void>,
    ): Promise<void> {
        for (let offset = 0; offset < rows.length; offset += batchSize) {
            const batch = rows.slice(offset, offset + batchSize);
            this.#debug("insert", { table, rows: batch.length, offset, batchSize });
            try {
                await write(batch);
            } catch (err: any) {
                this.#debugError("insert failed", err, { table, rows: batch.length, offset });
                if (batch.length <= 1 || isInvalidated(err) || INTERNAL_ERROR.test(String(err?.message ?? err))) {
                    throw err;
                }
                for (let index = 0; index < batch.length; index += 1) {
                    try {
                        await write([batch[index]!]);
                    } catch (rowErr: any) {
                        this.#debugError("row failed", rowErr, {
                            table,
                            row: offset + index,
                            id: rowId(batch[index]!),
                        });
                        throw new DuckdbQuackError(
                            `ingest into '${table}' failed on row ${offset + index} (id=${rowId(batch[index]!)}): ${firstLine(rowErr?.message ?? rowErr)}`,
                            "DUCKDB_ROW_FAILED",
                            rowErr,
                        );
                    }
                }
                // Every row passed on its own: the batch-level failure was transient
                // and the rows are written — the write succeeds.
            }
        }
    }

    async #insert(
        connection: DuckDBConnection,
        table: string,
        columns: Array<{ name: string; sql: string }>,
        rows: Array<Record<string, unknown>>,
        batchSize?: number,
    ): Promise<void> {
        const names = columns.map((column) => quoteIdent(column.name)).join(", ");
        // Against an attached catalog, Quack 2.0 cannot take bind parameters: the
        // values travel as literals, cast to the column's type.
        const remote = this.#options.url !== undefined;

        await this.#insertIsolated(table, rows, batchSizeOf(batchSize), async (batch) => {
            const params: any[] = [];
            const tuples = batch.map((row) => `(${columns.map((column) => {
                let value = row[column.name];
                // The event-log defaults: a row may omit the time and the id.
                if (value === undefined && column.name === "ts") value = formatTimestamp();
                if (value === undefined && column.name === "id") value = crypto.randomUUID();
                if (remote) return `CAST(${sqlLiteral(value)} AS ${column.sql})`;
                params.push(bindable(value, column.sql));
                return `CAST($${params.length} AS ${column.sql})`;
            }).join(", ")})`);

            await connection.run(
                `INSERT INTO ${this.#targeted(table)} (${names}) VALUES ${tuples.join(", ")}`,
                remote ? undefined : params,
            );
        });
    }

    /**
     * Wait for every queued write, then **throw the first failure** (once). The
     * `onError` hook still sees it immediately; `flush()` is what lets a caller know
     * that the rows it queued did not land.
     */
    async flush(): Promise<void> {
        await this.#pending.catch(() => {});
        const error = this.#writeError;
        if (error) {
            this.#writeError = null;
            throw error;
        }
    }

    /**
     * The `ingest` write for an open transaction — server-side, values as literals,
     * so it joins the transaction instead of running in the client engine.
     */
    async #insertRemote(
        table: string,
        columns: Array<{ name: string; sql: string }>,
        rows: Array<Record<string, unknown>>,
        batchSize?: number,
    ): Promise<void> {
        const names = columns.map((column) => quoteIdent(column.name)).join(", ");
        const target = quotePath(this.#serverTable(table));

        await this.#insertIsolated(table, rows, batchSizeOf(batchSize), async (batch) => {
            const tuples = batch.map((row) => `(${columns.map((column) => {
                let value = row[column.name];
                if (value === undefined && column.name === "ts") value = formatTimestamp();
                if (value === undefined && column.name === "id") value = crypto.randomUUID();
                return `CAST(${sqlLiteral(value)} AS ${column.sql})`;
            }).join(", ")})`);

            await this.#execOnRemote(
                `INSERT INTO ${target} (${names}) VALUES ${tuples.join(", ")}`,
            );
        });
    }
}

/**
 * A **Quack server** — a DuckDB instance that accepts clients over the protocol.
 *
 * It is the other half of `DuckdbQuackInstance`: the server owns the data, the
 * clients attach it and query it as a catalog.
 *
 * ```ts
 * const server = new DuckdbQuackServer({ port: 9494, token: process.env.QUACK_TOKEN! });
 * await server.start();
 *
 * await server.db.createTable('orders');                       // the server's own data
 * await server.db.ingest({ table: 'orders', rows: [{ data: { ref: 'A-1' } }] });
 * await server.db.flush();
 *
 * // elsewhere, another process:
 * //   const client = new DuckdbQuackInstance({ url: server.url, token: … });
 * //   await client.exec('SELECT * FROM quack.orders');
 *
 * await server.stop();
 * ```
 *
 * The server's database is **in memory**: it serves every client attached to this
 * process, and it is gone when the process ends. Give the process a reason to stay
 * up (or rebuild the tables at boot, from Mongo) — Quack makes running *one* owner
 * easy, it does not make the data durable on its own.
 *
 * `start()` runs `CALL quack_serve(…)`; the `quack` extension is auto-installed and
 * auto-loaded by DuckDB on first use. ⚠️ Quack is **experimental** in DuckDB 1.x.
 */
class DuckdbQuackServer {
    #options: QuackServerOptions;
    #db: DuckdbQuackInstance | null = null;
    #running = false;
    /** The `start()` in flight — concurrent callers share it (see `start`). */
    #starting: Promise<this> | null = null;
    #listenUri: string | null = null;
    #listenUrl: string | null = null;
    /**
     * Keeps the Bun process alive while serving. The Quack listener is a native
     * thread, invisible to the event loop — without a ref'd timer a script exits
     * as soon as `start()` resolves. Cleared by `stop()`.
     */
    #keepAlive: ReturnType<typeof setInterval> | null = null;

    constructor(options: QuackServerOptions) {
        const token = String(options?.token ?? "");
        if (!token.trim()) {
            throw new DuckdbQuackError(
                "A Quack server needs a token — a client presents it to attach",
                "DUCKDB_QUACK_TOKEN_REQUIRED",
            );
        }
        // Quack's own rule, checked here so the failure names the cause instead of
        // surfacing from `quack_serve` with no context.
        if (token.trim().length < 4) {
            throw new DuckdbQuackError(
                "A Quack server token must be at least 4 characters — DuckDB refuses anything shorter",
                "DUCKDB_QUACK_TOKEN_TOO_SHORT",
            );
        }
        if ((options.sslCertFile === undefined) !== (options.sslKeyFile === undefined)) {
            throw new DuckdbQuackError(
                "`sslCertFile` and `sslKeyFile` go together — pass both, or neither",
                "DUCKDB_QUACK_SSL_INCOMPLETE",
            );
        }
        if (options.disableSsl === true && options.sslCertFile !== undefined) {
            throw new DuckdbQuackError(
                "A plain-HTTP server cannot serve a certificate — drop `disableSsl`, or drop the TLS files",
                "DUCKDB_QUACK_SSL_CONFLICT",
            );
        }

        this.#options = options;
    }

    /**
     * The local instance being served — the tables the clients see live here.
     *
     * Released by `stop()`, and recreated by the next `start()`: a reference taken
     * before a restart points at a **closed** instance.
     */
    get db(): DuckdbQuackInstance {
        if (!this.#db) {
            // The server is a client that attaches nothing: same engine, same SQL.
            this.#db = new DuckdbQuackInstance({
                // A Quack server owns its database — the one place a file is right.
                dbPath: this.#options.dbPath,
                settings: this.#options.settings,
                columns: this.#options.columns,
                tables: this.#options.tables,
                onError: this.#options.onError,
                debug: this.#options.debug,
            });
        }
        return this.#db;
    }

    /** One debug line per server operation — `debug: true` only. */
    #debug(message: string, details?: Record<string, unknown>): void {
        if (!this.#options.debug) return;
        console.debug(`[quack] ${message}`, details ?? "");
    }

    /** One debug line per failure — the error is still thrown. */
    #debugError(message: string, err: any, details?: Record<string, unknown>): void {
        if (!this.#options.debug) return;
        console.error(`[quack] ${message}`, {
            ...details,
            code: err?.code,
            error: firstLine(err?.message ?? err),
        });
    }

    /** The port it listens on (default `9494`). */
    get port(): number {
        return this.#options.port ?? DEFAULT_PORT;
    }

    /** The interface it binds (default `'127.0.0.1'`). */
    get host(): string {
        return this.#options.host ?? "127.0.0.1";
    }

    /**
     * The protocol URI the server actually listens on — what `quack_serve`
     * returned, or `'quack:host:port'` before it starts.
     */
    get listenUri(): string {
        return this.#listenUri ?? `quack:${this.host}:${this.port}`;
    }

    /** The HTTP(S) URL behind the protocol, once the server is running. */
    get listenUrl(): string | undefined {
        return this.#listenUrl ?? undefined;
    }

    /** What a client hands to `DuckdbQuackInstance` — `'quack:host:port'`. */
    get url(): string {
        return this.listenUri;
    }

    /** The token clients must present. */
    get token(): string {
        return this.#options.token;
    }

    /** Whether the server is accepting connections. */
    get isRunning(): boolean {
        return this.#running;
    }

    /** The database file this server owns, when it was given one. */
    get dbPath(): string | undefined {
        return this.#options.dbPath;
    }

    /**
     * Open the instance, apply the settings, and start serving.
     *
     * Idempotent, **including under concurrency**: two `start()` calls share one
     * attempt, because a second `quack_serve` on the same instance fails and used
     * to close the database of the server that was already running. A failed
     * `start()` releases what it opened, so the next call is a real retry (and a
     * server can be stopped and started again).
     */
    async start(): Promise<this> {
        if (this.#running) return this;
        if (!this.#starting) this.#starting = this.#start();
        try {
            return await this.#starting;
        } finally {
            this.#starting = null;
        }
    }

    async #start(): Promise<this> {
        this.#debug("starting", {
            port: this.port,
            host: this.host,
            dbPath: this.dbPath ?? "memory",
        });

        // Quack binds with SO_REUSEPORT: a second server on the same port does not
        // fail, it steals the traffic — and the first server's clients then fail
        // with "Authentication failed" while it still reports `isRunning: true`.
        // Refuse before opening anything.
        if (await portAnswers(probeHost(this.host), this.port)) {
            throw new DuckdbQuackError(
                `Something already answers on ${this.url} — another Quack server owns that port. ` +
                `Quack binds with SO_REUSEPORT, so a second server would silently steal its clients ` +
                `(they fail with "Authentication failed") instead of failing to bind. ` +
                `Stop the other server, or choose another port.`,
                "DUCKDB_QUACK_PORT_IN_USE",
            );
        }

        const db = this.db;
        await db.connect();
        try {
            await this.#applySettings();

            // Full-text indexes are built before the port opens: a client that
            // attaches can search immediately.
            for (const index of this.#options.ftsIndexes ?? []) {
                await db.createFtsIndex(index.table, index);
            }
            for (const index of this.#options.vssIndexes ?? []) {
                await db.createVssIndex(index.table, index);
            }

            // Named arguments: `quack_serve(uri, token := …)`. The transport is only
            // stated when the caller chose one: Quack's default is plain for a local
            // URI and TLS otherwise, while an explicit `disable_ssl := false` forces
            // TLS even on localhost.
            const args = [
                quoteLiteral(this.url),
                `token := ${quoteLiteral(this.token)}`,
                `allow_other_hostname := ${this.#options.allowOtherHostname === true}`,
            ];
            if (this.#options.disableSsl !== undefined) {
                args.push(`disable_ssl := ${this.#options.disableSsl}`);
            }
            if (this.#options.sslCertFile !== undefined) {
                args.push(`ssl_cert_file := ${quoteLiteral(this.#options.sslCertFile)}`);
                args.push(`ssl_key_file := ${quoteLiteral(this.#options.sslKeyFile!)}`);
            }

            // The return value is what the server really bound: keep it rather than
            // recomputing the URL from the options.
            const { rows } = await db.exec(`CALL quack_serve(${args.join(", ")})`);
            const served = rows[0] as { listen_uri?: unknown; listen_url?: unknown } | undefined;
            if (served?.listen_uri !== undefined) this.#listenUri = String(served.listen_uri);
            if (served?.listen_url !== undefined) this.#listenUrl = String(served.listen_url);
        } catch (err: any) {
            this.#debugError("start failed", err, { url: this.url });
            // Release what this attempt opened, and drop the handle: the next
            // `start()` must build a fresh instance, not reuse a closed one.
            await db.close().catch(() => { });
            if (this.#db === db) this.#db = null;
            this.#listenUri = null;
            this.#listenUrl = null;
            throw new DuckdbQuackError(
                `Cannot start the Quack server on ${this.url} — ${firstLine(err?.message)}`,
                "DUCKDB_QUACK_SERVE_FAILED",
                err,
            );
        }

        this.#running = true;
        // A native listener does not keep Bun's event loop alive: a ref'd timer does,
        // until `stop()` clears it. This is what makes `bun start` stay up.
        this.#keepAlive = setInterval(() => { }, 60_000);
        this.#debug("serving", { listenUri: this.listenUri, listenUrl: this.listenUrl });
        return this;
    }

    /**
     * Whether the listener is **really** still there.
     *
     * `isRunning` is the wrapper's own flag; this asks the engine
     * (`quack_server_list()`) which servers it is still serving. Use it from a
     * supervisor: a native listener can be gone while the process — and the
     * keep-alive timer — are perfectly alive.
     */
    async health(): Promise<boolean> {
        if (!this.#running || !this.#db) return false;
        try {
            const { rows } = await this.#db.exec("SELECT listen_uri FROM quack_server_list()");
            return rows.some((row) => String(row.listen_uri) === this.listenUri);
        } catch {
            return false;
        }
    }

    /** The Quack settings, applied before the server starts listening. */
    async #applySettings(): Promise<void> {
        const options = this.#options;

        if (options.targetBatchBytes !== undefined) {
            await this.db.exec(`SET GLOBAL quack_target_batch_bytes = ${Number(options.targetBatchBytes)}`);
        }
        if (options.authenticationFunction) {
            await this.db.exec(`SET GLOBAL quack_authentication_function = ${quoteLiteral(options.authenticationFunction)}`);
        }
        if (options.authorizationFunction) {
            await this.db.exec(`SET GLOBAL quack_authorization_function = ${quoteLiteral(options.authorizationFunction)}`);
        }

        const identity = options.identity;
        if (identity) {
            // Any subset, named — `quack_identify` updates the `whoami_*` settings.
            const named = Object.entries(identity)
                .filter(([, value]) => value !== undefined)
                .map(([key, value]) => `${key} := ${quoteLiteral(String(value))}`);
            if (named.length) await this.db.exec(`CALL quack_identify(${named.join(", ")})`);
        }
    }

    /**
     * Stop serving and close the instance. Uses the protocol's own `quack_stop`,
     * then releases the database (a file is only unlocked when the instance closes).
     * Idempotent.
     */
    async stop(): Promise<void> {
        const wasRunning = this.#running;
        const db = this.#db;
        this.#running = false;
        if (this.#keepAlive) {
            clearInterval(this.#keepAlive);
            this.#keepAlive = null;
        }

        if (wasRunning && db) {
            try {
                await db.exec(`CALL quack_stop(${quoteLiteral(this.listenUri)})`);
            } catch {
                // Already gone — closing the instance releases the rest.
            }
        }

        this.#listenUri = null;
        this.#listenUrl = null;
        this.#debug("stopped", { wasRunning });
        // The next `start()` builds a fresh instance: a closed one cannot be reopened,
        // and keeping it would make `stop(); start()` throw `DUCKDB_CLOSED`.
        if (db) await db.close();
        if (this.#db === db) this.#db = null;
    }
}

// ─── Defaults ─────────────────────────────────────────────────────────────

/** What a table gets when no schema is declared: an append-only event log. */
const DEFAULT_COLUMNS: DuckdbColumn[] = [
    { name: "id", type: "string" },
    { name: "ts", type: "timestamp" },
    { name: "data", type: "json" },
];

const SQL_TYPE: Record<string, string> = {
    string: "VARCHAR",
    timestamp: "TIMESTAMP",
    json: "JSON",
};

/** Rows sent per `INSERT` — one statement per batch, values bound. */
const INSERT_BATCH = 500;

/** Quack's own default port. */
const DEFAULT_PORT = 9494;

/** Rows returned by `searchFts` when no `limit` is given (`0` disables the cap). */
const FTS_DEFAULT_LIMIT = 100;

/** Neighbours returned by `searchVss` when no `limit` is given. */
const VSS_DEFAULT_LIMIT = 10;

// ─── Errors ───────────────────────────────────────────────────────────────

/** An error of this package, with a stable `code`. */
class DuckdbQuackError extends Error {
    readonly code: string;

    constructor(message: string, code = "DUCKDB_ERROR", cause?: unknown) {
        super(message);
        this.name = "DuckdbQuackError";
        this.code = code;
        if (cause !== undefined) this.cause = cause;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function settingsOf(options: QuackInstanceOptions): Record<string, string> {
    // Persistent HNSW indexes need the flag **before** the database is opened:
    // without it, the session cannot bind the index and `LOAD vss` hangs. Enabling
    // it by default costs nothing (it only permits an experimental feature) and is
    // what makes a `dbPath` with vector indexes work after a restart.
    const merged = {
        hnsw_enable_experimental_persistence: "true",
        ...(options.settings ?? {}),
    };
    return Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, String(value)]));
}

function firstLine(message: unknown): string {
    return String(message ?? "unknown error").split("\n")[0]!;
}

/** One-line, length-capped SQL for debug logs — never the whole payload. */
function preview(sql: string, max = 500): string {
    const oneLine = String(sql ?? "").replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** The address to probe for a bind on `host` — a wildcard bind is reachable on loopback. */
function probeHost(host: string): string {
    if (host === "0.0.0.0") return "127.0.0.1";
    if (host === "::" || host === "[::]" || host === "::0") return "::1";
    return host;
}

/**
 * Whether something is already listening on `host:port`.
 *
 * Quack does **not** fail on a busy port: it binds with `SO_REUSEPORT`, so a second
 * server silently takes half the traffic and the first one's clients start failing
 * authentication. A TCP probe before `quack_serve` is what turns that into an error.
 */
function portAnswers(host: string, port: number, timeoutMs = 500): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (answer: boolean) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(answer);
        };
        const socket = createConnection({ host, port });
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
    });
}

/** The server's database instance went away — the attachment must be redone. */
const DATABASE_INVALIDATED = /invalidated its database|database has been invalidated|database is invalidated|invalid connection id|connection id is invalid/i;

/** DuckDB's own fatal class — the database is invalidated by design. */
const INTERNAL_ERROR = /INTERNAL Error/i;

/** A persisted HNSW index and no `vss` in the session — see `wrapEngineError`. */
const HNSW_NOT_LOADED = /unknown index type 'HNSW'/i;

/** Whether the error says the server's database instance is gone. */
function isInvalidated(err: any): boolean {
    return DATABASE_INVALIDATED.test(String(err?.message ?? err));
}

/**
 * Wrap an engine error, giving the "server restarted" case its own stable code:
 * a caller can then `reattach()` and retry instead of matching on English text.
 */
function wrapEngineError(prefix: string, err: any): DuckdbQuackError {
    const message = firstLine(err?.message);
    if (isInvalidated(err)) {
        return new DuckdbQuackError(
            `${prefix} ${message} — the Quack server restarted or invalidated its database. ` +
            `Reads are retried automatically (autoReattach: 'reads'); a write is not: ` +
            `call \`reattach()\` or set \`autoReattach: 'always'\` (idempotent writes only).`,
            "DUCKDB_QUACK_DATABASE_INVALIDATED",
            err,
        );
    }
    if (INTERNAL_ERROR.test(message)) {
        // DuckDB treats an internal error as fatal: it invalidates the database to
        // avoid serving a possibly-corrupt state. The server must be restarted, and
        // the statement is a bug report (engine/extension), not a data problem.
        return new DuckdbQuackError(
            `${prefix} ${message} — DuckDB hit an internal error and invalidated the database; ` +
            `restart the server and report the failing statement (engine or extension bug).`,
            "DUCKDB_INTERNAL_ERROR",
            err,
        );
    }
    if (HNSW_NOT_LOADED.test(message)) {
        // A persistent HNSW index lives in the file; the session that writes must be
        // opened with the persistence flag so `vss` can bind it. Setting the flag at
        // run time is impossible (it belongs to `vss`, which cannot load without it),
        // and `LOAD vss` on such a file hangs in DuckDB 2.0.0-r.1.
        return new DuckdbQuackError(
            `${prefix} ${message} — the table has a persisted HNSW index but \`vss\` is not loaded. ` +
            `Reopen the instance with \`options: { hnsw_enable_experimental_persistence: "true" }\` ` +
            `Experimental persistence is enabled by default; if you disabled it, re-enable it at ` +
            `creation and restart — loading vss at run time on such a file hangs.`,
            "DUCKDB_VSS_INDEX_NOT_LOADED",
            err,
        );
    }
    return new DuckdbQuackError(`${prefix} ${message}`, "DUCKDB_ERROR", err);
}

/**
 * Whether a statement only reads — the default `autoReattach: 'reads'` retries
 * these after a re-attach. Heuristic: the first keyword, comments skipped. A
 * `WITH … INSERT` is classified as a read; use `autoReattach: false` when that
 * distinction matters.
 */
function looksReadOnly(sql: string): boolean {
    const stripped = String(sql).replace(/^(?:(?:--[^\n]*\n)|\/\*[\s\S]*?\*\/|\s)+/, "");
    return /^(select|from|with|show|describe|desc|summarize|explain|pivot|unpivot|table|values)\b/i.test(stripped);
}

function normaliseName(name: unknown): string {
    const value = String(name ?? "").trim();
    if (!value) throw new DuckdbQuackError("A table or column name is required", "DUCKDB_NAME_INVALID");
    if (value.includes("\0")) throw new DuckdbQuackError("A DuckDB name may not contain a NUL byte", "DUCKDB_NAME_INVALID");
    return value;
}

/** What a migration has to write, column by column. */
type ColumnPlan = {
    name: string;
    /** The type the column must have (declared, or the existing one). */
    sql: string;
    /** The type it has now (`null` when the column is being added). */
    actualSql: string | null;
    /** Whether the column already exists. */
    existing: boolean;
};

/** A SQL identifier, quoted — a name is never interpolated raw. */
function quoteIdent(name: string): string {
    return `"${normaliseName(name).replace(/"/g, '""')}"`;
}

/** A SQL string literal, escaped — used for a token or a URL, never for a value. */
function quoteLiteral(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

/** A possibly qualified name (`schema.table`), each part quoted. */
/**
 * Split a possibly-qualified name into bare parts, respecting double quotes:
 * `main.documents`, `"main"."documents"` and `"my.table"` all work.
 */
function parsePath(name: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quoted = false;

    for (let index = 0; index < name.length; index++) {
        const ch = name[index]!;
        if (ch === '"') {
            if (quoted && name[index + 1] === '"') {
                current += '"';
                index++;
            } else {
                quoted = !quoted;
            }
            continue;
        }
        if (ch === "." && !quoted) {
            parts.push(current);
            current = "";
            continue;
        }
        current += ch;
    }
    parts.push(current);

    return parts.map((part) => normaliseName(part.trim()));
}

/** A possibly qualified name (`schema.table`), each part quoted. */
function quotePath(name: string): string {
    return parsePath(name).map((part) => quoteIdent(part)).join(".");
}

/**
 * The schema DuckDB's `fts` extension creates for a table: `fts_<schema>_<table>`
 * (`fts_main_documents` for `documents` or `main.documents`).
 */
function ftsSchemaName(table: string): string {
    const parts = parsePath(table);
    const name = parts[parts.length - 1]!;
    const schema = parts.length >= 2 ? parts[parts.length - 2]! : "main";
    return `fts_${schema}_${name}`;
}

/** A comma-separated field list, trimmed and normalised. */
function fieldList(value: string | string[]): string[] {
    const parts = Array.isArray(value) ? value : String(value).split(",");
    return parts
        .map((part) => String(part).trim())
        .filter((part) => part.length > 0)
        .map((part) => normaliseName(part));
}

/** A supported VSS metric, validated (`l2sq`, `cosine`, `ip`). */
function vssMetric(value?: string | null): DuckdbVssMetric {
    const metric = String(value ?? "l2sq").toLowerCase();
    if (metric !== "l2sq" && metric !== "cosine" && metric !== "ip") {
        throw new DuckdbQuackError(
            `Unknown VSS metric '${metric}' — use 'l2sq', 'cosine' or 'ip'`,
            "DUCKDB_VSS_METRIC_INVALID",
        );
    }
    return metric;
}

/** The DuckDB function that computes the distance for a metric. */
function vssDistanceFunction(metric: DuckdbVssMetric): string {
    if (metric === "cosine") return "array_cosine_distance";
    if (metric === "ip") return "array_negative_inner_product";
    return "array_distance";
}

/** The default HNSW index name for a column. */
function vssIndexName(table: string, column: string): string {
    const parts = parsePath(table);
    const tableName = parts[parts.length - 1]!;
    return `vss_${tableName}_${column}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
}

/** The index name qualified with the table's schema, for `DROP INDEX`. */
function vssIndexRef(table: string, index: string): string {
    const parts = parsePath(table);
    return parts.length >= 2 ? `${parts[parts.length - 2]}.${index}` : index;
}

/** A `CAST([…] AS FLOAT[N])` literal, with a validated, finite vector. */
function vssVector(vector: unknown): string {
    if (!Array.isArray(vector) || !vector.length) {
        throw new DuckdbQuackError(
            "`searchVss` needs a non-empty array of numbers",
            "DUCKDB_VSS_VECTOR_REQUIRED",
        );
    }
    const values = vector.map((value) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
            throw new DuckdbQuackError(
                "A VSS vector must contain finite numbers",
                "DUCKDB_VSS_VECTOR_INVALID",
            );
        }
        return parsed;
    });
    return `CAST([${values.join(", ")}] AS FLOAT[${values.length}])`;
}

/** A finite number, for a BM25 parameter or a limit. */
function finiteNumber(value: unknown, option: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new DuckdbQuackError(`\`${option}\` must be a finite number`, "DUCKDB_FTS_OPTION_INVALID");
    }
    return parsed;
}

function columnSql(column: DuckdbColumn): string {
    const parts = [quoteIdent(column.name), declaredType(column)];
    if (column.required) parts.push("NOT NULL");
    if (column.primaryKey) parts.push("PRIMARY KEY");
    return parts.join(" ");
}

/** The SQL type a declared field maps to (`string` → `VARCHAR`, anything else verbatim). */
function declaredType(field: DuckdbColumn): string {
    const declared = String(field.type ?? "string");
    return SQL_TYPE[declared.toLowerCase()] ?? declared;
}

/** Types compare case-insensitively, whitespace-collapsed — `DOUBLE` = `double`. */
function normaliseType(sql: string): string {
    return String(sql).trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * `YYYY-MM-DD HH:mm:ss` in **local** time — the wall clock DuckDB reads back as a
 * `TIMESTAMP` (which carries no timezone).
 *
 * A `Date` bound straight to a DuckDB parameter is refused (`Cannot create values
 * of type ANY`): a timestamp has to travel as a string, cast on the way in.
 */
function formatTimestamp(date: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * `exec`'s second argument is either bound values (an array, or a record of named
 * parameters) or options — `{ values, server }`. A record is read as options when
 * it carries one of the option keys; for a named parameter that happens to be
 * called `server`, wrap it: `{ values: { server: … } }`.
 */
function splitExecArguments(input?: any[] | Record<string, any>): {
    values?: any[] | Record<string, any>;
} {
    if (input === undefined) return {};
    // An array, or a record of named parameters — unless it is the `{ values }` form.
    if (Array.isArray(input)) return { values: input };
    if (!Object.prototype.hasOwnProperty.call(input, "values")) return { values: input };

    return { values: (input as DuckdbExecOptions).values };
}

/**
 * `where` is mandatory, and must be a real SQL predicate — an update, replace
 * or delete without one would hit every row. A non-string (`undefined`, an
 * array…) is refused rather than stringified into something that runs.
 */
function requireWhere(where: unknown, operation: string): string {
    const predicate = typeof where === "string" ? where.trim() : "";
    if (!predicate) {
        throw new DuckdbQuackError(`\`${operation}\` needs \`where\` — a non-empty SQL predicate`, "DUCKDB_WHERE_REQUIRED");
    }
    return predicate;
}

/** The number of rows an `UPDATE`/`DELETE` reports (`Count`). */
function affectedRows(result: DuckdbExecResult): number {
    const [first] = result.rows;
    const value = first ? Object.values(first)[0] : 0;
    return Number(value ?? 0);
}

/** What a value has to become to travel as a bound parameter. */
function bindable(value: unknown, sqlType?: string): any {
    if (value === undefined) return null;
    if (value instanceof Date) return formatTimestamp(value);
    // A typed array is a list, not an object: `Float32Array` would otherwise be
    // stringified as `{"0":…}` by `JSON.stringify`. Bind it as the JSON form
    // (`[1,0.5,0]`), which `CAST($1 AS FLOAT[N])` parses — except for a BLOB,
    // where the bytes are what the caller means.
    if (ArrayBuffer.isView(value)) {
        if (sqlType && /BLOB|BYTEA/i.test(sqlType)) return value;
        return JSON.stringify(Array.from(value as unknown as ArrayLike<number>));
    }
    if (value !== null && typeof value === "object") return JSON.stringify(value);
    return value as any;
}

/**
 * A JS value as a SQL literal — the form Quack 2.0 requires when it cannot take
 * bound parameters (an attached catalog). Strings are escaped, numbers checked,
 * objects serialised the same way `bindable` does.
 */
function sqlLiteral(value: unknown): string {
    if (value === undefined || value === null) return "NULL";
    if (value instanceof Date) return quoteLiteral(formatTimestamp(value));
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new DuckdbQuackError(`Cannot inline '${value}' as a SQL value`, "DUCKDB_PARAMETER_INVALID");
        }
        return String(value);
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (typeof value === "string") return quoteLiteral(value);
    if (ArrayBuffer.isView(value)) {
        return quoteLiteral(JSON.stringify(Array.from(value as unknown as ArrayLike<number>)));
    }
    if (typeof value === "object") return quoteLiteral(JSON.stringify(value));
    return quoteLiteral(String(value));
}

/** The identifying field of a failed row — top level, or inside `data`. */
function rowId(row: Record<string, unknown>): string {
    const data = row?.data as Record<string, unknown> | undefined;
    const value = row?.id ?? data?.id ?? row?.ref ?? data?.ref;
    return value === undefined || value === null ? "?" : String(value);
}

/** `insertBatchSize` for one call — a positive integer, or the shared default. */
function batchSizeOf(value: unknown): number {
    const parsed = Math.trunc(Number(value ?? INSERT_BATCH));
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : INSERT_BATCH;
}

/** A JS value as a `SET VARIABLE` literal — a `Date` becomes a `TIMESTAMP`. */
function variableLiteral(value: unknown): string {
    if (value instanceof Date) return `TIMESTAMP '${formatTimestamp(value)}'`;
    return sqlLiteral(value);
}

/**
 * Replace `$1`/`$name` parameters with SQL literals, skipping what is not code:
 * quoted strings and identifiers, dollar-quoted strings, and comments.
 *
 * Quack 2.0 prepares a statement against the attached catalog and does not send
 * bind values with it, so this is the only way to keep `exec(sql, values)` working
 * on an attached instance.
 */
function inlineParameters(sql: string, values: any[] | Record<string, any>): string {
    const positional = Array.isArray(values);
    const named = positional ? undefined : values;
    let out = "";
    let index = 0;

    const copyQuoted = (quote: string) => {
        out += quote;
        index++;
        while (index < sql.length) {
            const ch = sql[index]!;
            out += ch;
            index++;
            if (ch === quote) {
                // A doubled quote is an escaped one, not the end.
                if (sql[index] === quote) {
                    out += quote;
                    index++;
                    continue;
                }
                break;
            }
        }
    };

    while (index < sql.length) {
        const ch = sql[index]!;

        if (ch === "'" || ch === '"') {
            copyQuoted(ch);
            continue;
        }

        if (ch === "-" && sql[index + 1] === "-") {
            while (index < sql.length && sql[index] !== "\n") {
                out += sql[index];
                index++;
            }
            continue;
        }

        if (ch === "/" && sql[index + 1] === "*") {
            out += "/*";
            index += 2;
            while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) {
                out += sql[index];
                index++;
            }
            if (index < sql.length) {
                out += "*/";
                index += 2;
            }
            continue;
        }

        if (ch === "$") {
            const rest = sql.slice(index);

            // Dollar-quoted string — `$$ … $$` or `$tag$ … $tag$`.
            const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
            if (dollar) {
                const tag = dollar[0];
                const end = sql.indexOf(tag, index + tag.length);
                if (end === -1) {
                    out += rest;
                    index = sql.length;
                } else {
                    out += sql.slice(index, end + tag.length);
                    index = end + tag.length;
                }
                continue;
            }

            // Positional — `$1`, `$2` …
            const position = /^\$(\d+)/.exec(rest);
            if (position) {
                if (!positional) {
                    throw new DuckdbQuackError("Positional parameters need an array of values", "DUCKDB_PARAMETER_INVALID");
                }
                const n = Number(position[1]);
                if (n < 1 || n > values.length) {
                    throw new DuckdbQuackError(`Missing value for parameter $${n}`, "DUCKDB_PARAMETER_MISSING");
                }
                out += sqlLiteral(values[n - 1]);
                index += position[0].length;
                continue;
            }

            // Named — `$name`. When the caller did not supply it, leave the token
            // for DuckDB 2.0's session-variable shorthand (`SET VARIABLE name = …`).
            const name = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
            if (name) {
                const key = name[1]!;
                if (named && Object.prototype.hasOwnProperty.call(named, key)) {
                    out += sqlLiteral(named[key]);
                    index += name[0].length;
                    continue;
                }
            }
        }

        out += ch;
        index++;
    }

    return out;
}

/**
 * The `ts` a document maps to: a `Date`, an epoch number or any string a `Date`
 * accepts — normalised to the wall clock DuckDB reads as a `TIMESTAMP`. Anything
 * unreadable falls back to now, so a bad field never fails the write.
 */
function toWallClock(value: unknown): string {
    if (value instanceof Date) return formatTimestamp(value);
    if (typeof value === "number") return formatTimestamp(new Date(value));
    if (typeof value === "string") {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return formatTimestamp(parsed);
    }
    return formatTimestamp();
}

/**
 * Create the folder a database file lives in — `./data/analytics.duckdb` should
 * work on a fresh checkout, without a `mkdir` in front of it. `:memory:` and other
 * URI-style paths resolve to the current directory, so the call is a no-op there.
 */
async function ensureDbDirectory(dbPath: string): Promise<void> {
    await mkdir(dirname(resolve(dbPath)), { recursive: true });
}

// ─── Retention helpers ──────────────────────────────────────────────────

/** Rows per `DELETE` — one statement must not rewrite a whole table. */
const RETENTION_BATCH = 100_000;

const RETENTION_UNITS = { s: "seconds", m: "minutes", h: "hours", d: "days", w: "weeks" } as const;
type RetentionUnit = keyof typeof RETENTION_UNITS;

/** `'30d'` → `{ amount: 30, unit: 'd' }`; anything else is refused. */
function parseRetention(value: unknown): { amount: number; unit: RetentionUnit } {
    const match = /^(\d+)\s*(s|m|h|d|w)$/i.exec(String(value ?? "").trim());
    if (!match) {
        throw new DuckdbQuackError(
            `Invalid duration '${value}' — use '30d', '24h', '90m', '3600s' or '2w'`,
            "DUCKDB_RETENTION_INVALID",
        );
    }
    return { amount: Number(match[1]), unit: match[2]!.toLowerCase() as RetentionUnit };
}

/** `'30d'` → `INTERVAL '30 days'`. */
function retentionInterval(value: string): string {
    const { amount, unit } = parseRetention(value);
    return `INTERVAL '${amount} ${RETENTION_UNITS[unit]}'`;
}

/** `'30d'` → milliseconds, for the scheduler. */
function retentionMs(value: unknown): number {
    const { amount, unit } = parseRetention(value);
    const factor: Record<RetentionUnit, number> = {
        s: 1_000,
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
        w: 604_800_000,
    };
    return amount * factor[unit];
}

/**
 * `CAST(column AS TIMESTAMP) < cutoff` — the cutoff comes from a duration
 * (`now() - INTERVAL …`, the database clock) or from an explicit `Date`.
 */
function retentionPredicate(column: string, ttl: string | Date, where?: string): string {
    const cutoff = ttl instanceof Date
        ? `CAST(${quoteLiteral(formatTimestamp(ttl))} AS TIMESTAMP)`
        : `CAST(now() - ${retentionInterval(ttl)} AS TIMESTAMP)`;
    const predicate = `CAST(${quoteIdent(column)} AS TIMESTAMP) < ${cutoff}`;
    return where ? `(${predicate}) AND (${where})` : predicate;
}

export {
    DuckdbQuackInstance,
    DuckdbQuackServer,
    DuckdbTable,
    DuckdbQuackError,
    DEFAULT_COLUMNS,
    DEFAULT_PORT,
    formatTimestamp,
};
