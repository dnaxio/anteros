import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type {
    DuckdbColumn,
    DuckdbDocument,
    DuckdbExecOptions,
    DuckdbExecResult,
    DuckdbIngestOptions,
    DuckdbIngestResult,
    DuckdbSchemaChange,
    DuckdbSchemaReport,
    DuckdbTableDeleteResult,
    DuckdbTableInfo,
    DuckdbTableIngestResult,
    DuckdbTableOptions,
    DuckdbTableReplaceResult,
    DuckdbTableUpdateResult,
    QuackInstanceOptions,
    QuackServerOptions,
} from "../types/quack";

/** The surface a `DuckdbTable` needs from its instance (wired by `table()`). */
type TableBackend = {
    /** The table name, qualified with the attached catalog when there is one. */
    target: string;
    ensure: () => Promise<void>;
    insert: (rows: Array<Record<string, unknown>>, ts?: string) => Promise<void>;
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
        this.#backend.enqueue(() => this.#backend.insert(rows, options.ts ?? this.#options.ts));
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
        const predicate = requireFilter(where, "update");
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
        const predicate = requireFilter(where, "replace");
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
        const predicate = requireFilter(where, "delete");
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

    /** Writes queued by `ingest`, drained in order (see `flush`). */
    #pending: Promise<void> = Promise.resolve();
    /** Tables known to exist — skips the existence check on ingest. */
    #tables = new Set<string>();
    /** Columns of a table, as DuckDB reports them. */
    #columns = new Map<string, Array<{ name: string; sql: string }>>();
    /** The background reconciliation of `options.tables` (see `syncSchema`). */
    #schemaSync: Promise<DuckdbSchemaReport> | null = null;

    constructor(options: QuackInstanceOptions = {}) {
        this.#options = options;
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

    async #open(): Promise<void> {
        // A file when one is asked for (that is what the server does), memory
        // otherwise — a client is a workspace.
        this.#instance = await DuckDBInstance.create(this.#options.dbPath, optionsOf(this.#options));
        this.#connection = await this.#instance.connect();
        if (this.#options.url) await this.#attach();
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
        try {
            // The secret first: the ATTACH resolves it by type.
            await this.#connection!.run(`CREATE OR REPLACE SECRET ${secret} (TYPE quack, TOKEN ${quoteLiteral(token)})`);

            // `READ_ONLY` and `DISABLE_SSL` are ATTACH options (Quack's own defaults
            // are "writable" and "TLS off a local URI").
            const attachOptions: string[] = [];
            if (quack.disableSsl) attachOptions.push("DISABLE_SSL true");
            if (quack.readOnly) attachOptions.push("READ_ONLY");
            const suffix = attachOptions.length ? ` (${attachOptions.join(", ")})` : "";

            await this.#connection!.run(
                `ATTACH ${quoteLiteral(quack.url!)} AS ${quoteIdent(this.alias)}${suffix}`,
            );
            // The remote is what this instance is for: make it the default catalog, so
            // an unqualified `events` means the *server's* table. The client's own
            // memory catalog stays reachable, qualified (`memory.…`).
            await this.#connection!.run(`USE ${quoteIdent(this.alias)}`);
            this.#attached = true;
        } catch (err: any) {
            throw new DuckdbQuackError(
                `Cannot attach the Quack remote '${quack.url}' — ${firstLine(err?.message)}`,
                "DUCKDB_QUACK_ATTACH_FAILED",
                err,
            );
        }
    }

    /** Close the instance. Every later call is refused. */
    async close(): Promise<void> {
        await this.flush();
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
            this.#schemaSync = null;
        }
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
            insert: (rows, ts) => this.#insertDocuments(tableName, rows, ts),
            enqueue: (work) => this.#enqueueWrite(work),
            flush: () => this.flush(),
            query: (sql) => this.exec(sql),
        });
    }

    /** Shorthand for `(await db.table(name)).update(where, patch)` — filter mandatory. */
    async update(table: string, where: string, patch: DuckdbDocument): Promise<DuckdbTableUpdateResult> {
        return (await this.table(table)).update(where, patch);
    }

    /** Shorthand for `(await db.table(name)).replace(where, document)` — filter mandatory. */
    async replace(table: string, where: string, document: DuckdbDocument): Promise<DuckdbTableReplaceResult> {
        return (await this.table(table)).replace(where, document);
    }

    /** Shorthand for `(await db.table(name)).delete(where)` — filter mandatory. */
    async delete(table: string, where: string): Promise<DuckdbTableDeleteResult> {
        return (await this.table(table)).delete(where);
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
    async #insertDocuments(table: string, rows: Array<Record<string, unknown>>, tsField?: string): Promise<void> {
        const target = this.#targeted(table);

        for (let offset = 0; offset < rows.length; offset += INSERT_BATCH) {
            const batch = rows.slice(offset, offset + INSERT_BATCH);
            const params: any[] = [];

            const tuples = batch.map((row) => {
                const ts = tsField !== undefined && row[tsField] !== undefined
                    ? toWallClock(row[tsField])
                    : formatTimestamp();
                params.push(bindable(row));
                params.push(ts);
                return `(CAST($${params.length - 1} AS JSON), CAST($${params.length} AS TIMESTAMP))`;
            });

            await this.#runWithParams(`INSERT INTO ${target} ("data", "ts") VALUES ${tuples.join(", ")}`, params);
        }
    }

    /** Queue a write behind the ones already queued, reporting a failure through `onError`. */
    #enqueueWrite(work: () => Promise<void>): void {
        const next = this.#pending.then(work, work);
        this.#pending = next.catch(() => {});
        next.catch((err: any) => {
            const error = err instanceof DuckdbQuackError
                ? err
                : new DuckdbQuackError(`DuckDB: ${firstLine(err?.message ?? err)}`, "DUCKDB_ERROR", err);
            if (this.#options.onError) this.#options.onError(error);
            else console.error(error.message);
        });
    }

    /** Run a statement with bound values — the SQL this class builds itself. */
    async #runWithParams(sql: string, values: any[]): Promise<void> {
        const { connection } = await this.raw();
        await connection.run(sql, values);
    }

    // ─── Query ────────────────────────────────────────────────────────────

    /**
     * Run one statement and return its rows.
     *
     * On an attached instance it runs **on the Quack server** (`quack_query`): the
     * remote computes, and only the result crosses the wire. A statement with bound
     * `values` is the one exception — it runs in the **client's** engine, because the
     * server only receives SQL text and cannot take parameters.
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
        // Everything runs on the Quack server — bound values are the one exception:
        // the server receives SQL text, it cannot take parameters.
        if (this.#options.url !== undefined && values === undefined) {
            return this.#execOnRemote(sql);
        }

        return this.#execOnClient(sql, values);
    }

    /** Run the statement in the client's DuckDB engine. */
    async #execOnClient(sql: string, values?: any[] | Record<string, any>): Promise<DuckdbExecResult> {
        const { connection } = await this.raw();
        const started = performance.now();
        try {
            const reader = await connection.runAndReadAll(sql, values);
            const result = {
                columns: reader.columnNames(),
                types: reader.columnTypes().map((type) => String(type)),
                rows: reader.getRowObjectsJson() as Record<string, unknown>[],
            };
            return { ...result, duration_ms: performance.now() - started };
        } catch (err: any) {
            throw new DuckdbQuackError(`DuckDB: ${firstLine(err?.message)}`, "DUCKDB_ERROR", err);
        }
    }

    /** Run the statement on the attached Quack server — `quack_query` carries the SQL. */
    async #execOnRemote(sql: string): Promise<DuckdbExecResult> {
        const token = this.#options.token ?? Bun.env?.DUCKDB_QUACK_TOKEN ?? process.env?.DUCKDB_QUACK_TOKEN;
        if (!token) {
            throw new DuckdbQuackError(
                "A Quack url was given but no token — pass `token`, or set DUCKDB_QUACK_TOKEN",
                "DUCKDB_QUACK_TOKEN_REQUIRED",
            );
        }

        const { connection } = await this.raw();
        const started = performance.now();
        try {
            const reader = await connection.runAndReadAll(
                `SELECT * FROM quack_query($1, $2, token := $3)`,
                [this.#options.url, sql, token],
            );
            const result = {
                columns: reader.columnNames(),
                types: reader.columnTypes().map((type) => String(type)),
                rows: reader.getRowObjectsJson() as Record<string, unknown>[],
            };
            return { ...result, duration_ms: performance.now() - started };
        } catch (err: any) {
            throw new DuckdbQuackError(`DuckDB (server): ${firstLine(err?.message)}`, "DUCKDB_ERROR", err);
        }
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
            return { table: name, columns: cols.map((column) => column.name), created: !existed };
        } catch (err: any) {
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
            return { table: name, columns: [], created: false, dropped: existed };
        } catch (err: any) {
            throw new DuckdbQuackError(`DuckDB: ${firstLine(err?.message)}`, "DUCKDB_ERROR", err);
        }
    }

    /**
     * Every table of the attached remote, or of the local catalog when the
     * instance is not attached.
     */
    async listTables(): Promise<string[]> {
        if (this.#options.url) {
            const token = this.#options.token ?? Bun.env?.DUCKDB_QUACK_TOKEN ?? process.env?.DUCKDB_QUACK_TOKEN;
            if (!token) {
                throw new DuckdbQuackError(
                    "A Quack url was given but no token — pass `token`, or set DUCKDB_QUACK_TOKEN",
                    "DUCKDB_QUACK_TOKEN_REQUIRED",
                );
            }

            const { connection } = await this.raw();
            try {
                // A quack remote exposes its tables, not its `information_schema`:
                // one-shot query, no ATTACH needed.
                const reader = await connection.runAndReadAll(
                    `SELECT table_name FROM quack_query($1, $2, token := $3) ORDER BY 1`,
                    [this.#options.url, "SELECT table_name FROM duckdb_tables()", token],
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

    async #exists(connection: DuckDBConnection, table: string): Promise<boolean> {
        if (this.#options.url) {
            // `information_schema` only describes the *local* catalog, so the remote
            // is probed with a zero-row select instead.
            try {
                await connection.runAndReadAll(`SELECT * FROM ${this.#targeted(table)} LIMIT 0`);
                return true;
            } catch {
                return false;
            }
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
            // select is what reports the columns it actually has.
            try {
                const reader = await connection.runAndReadAll(`SELECT * FROM ${this.#targeted(table)} LIMIT 0`);
                const types = reader.columnTypes().map((type) => String(type));
                const columns = reader.columnNames().map((name, index) => ({ name, sql: types[index] ?? "VARCHAR" }));
                if (!columns.length) throw new Error("no columns");
                this.#columns.set(table, columns);
                return columns;
            } catch (err: any) {
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

    // ─── Ingest ───────────────────────────────────────────────────────────

    /**
     * Queue rows into a table — **in the background**.
     *
     * The call returns as soon as the rows are queued: the table is created if it
     * is missing, then the batch is written by the drain loop. Await `flush()` when
     * the write has to be over before you move on (a script that exits, a test, the
     * shutdown path). A write that fails is logged, not thrown — a standalone
     * library logs through `onError`, and the caller is long gone by then.
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
        if (!this.#tables.has(table)) {
            if (!(await this.#exists(connection, table))) await this.createTable(table, options.columns);
            else this.#tables.add(table);
        }
        const columns = await this.#columnsOf(connection, table);

        const work = async () => {
            try {
                await this.#insert(connection, table, columns, rows as Array<Record<string, unknown>>);
            } catch (err: any) {
                const error = new DuckdbQuackError(`DuckDB ingest into '${table}' failed: ${firstLine(err?.message)}`, "DUCKDB_ERROR", err);
                if (this.#options.onError) this.#options.onError(error);
                else console.error(error.message);
            }
        };

        // Serialised: batches land in the order they were queued, and a failure
        // never breaks the chain for the writes behind it.
        const next = this.#pending.then(work, work);
        this.#pending = next.catch(() => {});
        next.catch(() => {});

        return { table, queued: rows.length };
    }

    async #insert(
        connection: DuckDBConnection,
        table: string,
        columns: Array<{ name: string; sql: string }>,
        rows: Array<Record<string, unknown>>,
    ): Promise<void> {
        const names = columns.map((column) => quoteIdent(column.name)).join(", ");

        for (let offset = 0; offset < rows.length; offset += INSERT_BATCH) {
            const batch = rows.slice(offset, offset + INSERT_BATCH);
            const params: any[] = [];

            const tuples = batch.map((row) => `(${columns.map((column) => {
                let value = row[column.name];
                // The event-log defaults: a row may omit the time and the id.
                if (value === undefined && column.name === "ts") value = formatTimestamp();
                if (value === undefined && column.name === "id") value = crypto.randomUUID();
                params.push(bindable(value));
                return `CAST($${params.length} AS ${column.sql})`;
            }).join(", ")})`);

            await connection.run(
                `INSERT INTO ${this.#targeted(table)} (${names}) VALUES ${tuples.join(", ")}`,
                params,
            );
        }
    }

    /** Wait for every write queued so far. */
    async flush(): Promise<void> {
        await this.#pending.catch(() => {});
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
    /** The local instance being served — the tables the clients see live here. */
    readonly db: DuckdbQuackInstance;

    #options: QuackServerOptions;
    #running = false;

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

        this.#options = options;
        // The server is a client that attaches nothing: same engine, same SQL.
        this.db = new DuckdbQuackInstance({
            // A Quack server owns its database — the one place a file is right.
            dbPath: options.dbPath,
            options: options.options,
            columns: options.columns,
            tables: options.tables,
            onError: options.onError,
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

    /** What a client hands to `DuckdbQuackInstance` — `'quack:host:port'`. */
    get url(): string {
        return `quack:${this.host}:${this.port}`;
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

    /** Open the instance, apply the settings, and start serving. Idempotent. */
    async start(): Promise<this> {
        if (this.#running) return this;

        await this.db.connect();
        try {
            await this.#applySettings();

            // Named arguments: `quack_serve(uri, token := …, allow_other_hostname := …, disable_ssl := …)`.
            const args = [
                quoteLiteral(this.url),
                `token := ${quoteLiteral(this.token)}`,
                `allow_other_hostname := ${this.#options.allowOtherHostname === true}`,
                `disable_ssl := ${this.#options.disableSsl === true}`,
            ];
            await this.db.exec(`CALL quack_serve(${args.join(", ")})`);
        } catch (err: any) {
            await this.db.close();
            throw new DuckdbQuackError(
                `Cannot start the Quack server on ${this.url} — ${firstLine(err?.message)}`,
                "DUCKDB_QUACK_SERVE_FAILED",
                err,
            );
        }

        this.#running = true;
        return this;
    }

    /** The Quack settings, applied before the server starts listening. */
    async #applySettings(): Promise<void> {
        const options = this.#options;

        if (options.fetchBatchChunks !== undefined) {
            await this.db.exec(`SET GLOBAL quack_fetch_batch_chunks = ${Number(options.fetchBatchChunks)}`);
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
        this.#running = false;

        if (wasRunning) {
            try {
                await this.db.exec(`CALL quack_stop(${quoteLiteral(this.url)})`);
            } catch {
                // Already gone — closing the instance releases the rest.
            }
        }

        await this.db.close();
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

function optionsOf(options: QuackInstanceOptions): Record<string, string> {
    return Object.fromEntries(Object.entries(options.options ?? {}).map(([key, value]) => [key, String(value)]));
}

function firstLine(message: unknown): string {
    return String(message ?? "unknown error").split("\n")[0]!;
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

/** A filter is mandatory — an update/replace without one would hit every row. */
function requireFilter(where: unknown, operation: string): string {
    const predicate = String(where ?? "").trim();
    if (!predicate) {
        throw new DuckdbQuackError(`\`${operation}\` needs a WHERE filter`, "DUCKDB_WHERE_REQUIRED");
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
function bindable(value: unknown): any {
    if (value === undefined) return null;
    if (value instanceof Date) return formatTimestamp(value);
    if (value !== null && typeof value === "object") return JSON.stringify(value);
    return value as any;
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

export {
    DuckdbQuackInstance,
    DuckdbQuackServer,
    DuckdbTable,
    DuckdbQuackError,
    DEFAULT_COLUMNS,
    DEFAULT_PORT,
    formatTimestamp,
};
