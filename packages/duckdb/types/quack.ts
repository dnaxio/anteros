/**
 * `@anteros/duckdb` — a DuckDB instance over the **Quack** protocol.
 *
 * Quack lets two DuckDB processes talk to each other: the server runs
 * `CALL quack_serve('quack:0.0.0.0:9494', token = '…')`, and a client attaches it
 * with `ATTACH 'quack:host:9494' AS <alias>` — the remote then behaves like any
 * other catalog (`alias.table`).
 *
 * ⚠️ Quack is **experimental** in DuckDB 1.x: DuckDB documents the protocol, the
 * function names and the implementation details as subject to change, with a
 * stable status expected in 2.0. Pin your `@duckdb/node-api` version.
 */

/**
 * A column, as `createTable` takes it.
 *
 * `type` is the SQL family spelled the way the rest of Anteros spells it — a
 * `timestamp` column is DuckDB's `TIMESTAMP`, a `json` column DuckDB's `JSON`,
 * anything else is passed through as SQL (`'DOUBLE'`, `'VARCHAR[]'`…).
 */
export type DuckdbColumnType =
    /** `VARCHAR` */
    | "string"
    /** `TIMESTAMP` */
    | "timestamp"
    /** `JSON` */
    | "json"
    /** Any other DuckDB type, used verbatim. */
    | (string & {});

export type DuckdbColumn = {
    /** Column name. */
    name: string;
    /** Column type (default `'string'`). */
    type?: DuckdbColumnType;
    /** Mark the column `NOT NULL`. */
    required?: boolean;
    /**
     * Primary key — a table declares at most one. `ingest` **appends**: a duplicate
     * key is refused by DuckDB rather than merged.
     */
    primaryKey?: boolean;
};

/**
 * A table declared at initialization: its name, and the fields it must have.
 *
 * The instance reconciles them **in the background** when it opens: creates a
 * missing table, adds the missing fields, retypes the ones whose declared type
 * differs — and **never drops** a field it does not know about.
 */
export type DuckdbTableSchema = {
    /** Table name. */
    name: string;
    /** The fields the table must have. */
    fields: DuckdbColumn[];
};

/** What the schema sync did for one table. */
export type DuckdbSchemaChange = {
    /** Table name. */
    table: string;
    /** The table did not exist, and was created with the declared fields. */
    created: boolean;
    /** Fields added (`ALTER TABLE … ADD COLUMN`). */
    added: string[];
    /** Fields whose type changed (`ALTER TABLE … ALTER COLUMN … SET DATA TYPE`). */
    retyped: string[];
};

/** What `syncSchema()` reports. */
export type DuckdbSchemaReport = {
    /** Every declared table, in declaration order. */
    tables: DuckdbSchemaChange[];
};

/**
 * A full-text index, as `createFtsIndex()` takes it.
 *
 * DuckDB builds it with the `fts` extension (autoloaded on first use) in a schema
 * named `fts_<catalog>_<table>` — `fts_main_documents` for `documents`.
 */
export type DuckdbFtsIndexOptions = {
    /** Document identifier column. `NOT NULL` or `PRIMARY KEY` when `incremental`. */
    id: string;
    /** One text column, a list of them, or `'*'` for every `VARCHAR` column. */
    fields: string | string[] | "*";
    /** Stemmer: `'porter'` (default), `'english'`, `'french'`, `'none'`… */
    stemmer?: string;
    /** Stopwords table, `'none'`, or the default `'english'` list. */
    stopwords?: string;
    /** Regex of patterns to ignore (default `'(\\.|[^a-z])+'`). */
    ignore?: string;
    /** Remove accents before indexing (default `true`). */
    stripAccents?: boolean;
    /** Lowercase before indexing (default `true`). */
    lower?: boolean;
    /**
     * `true` (default): rebuild an existing index. `false`: keep an existing index
     * as it is, and create it only when missing — what a server restart wants.
     * (DuckDB's own default is `false`, but it errors instead of skipping.)
     */
    overwrite?: boolean;
    /** Keep the index up to date with triggers after inserts/deletes. */
    incremental?: boolean;
};

/** A full-text index declared at server startup (`ftsIndexes`). */
export type DuckdbFtsIndex = DuckdbFtsIndexOptions & {
    /** Table on the served database. */
    table: string;
};

/** What `createFtsIndex()` reports. */
export type DuckdbFtsIndexInfo = {
    /** Table indexed. */
    table: string;
    /** Schema DuckDB created for the index (`fts_main_<table>`). */
    index: string;
};

/** What `dropFtsIndex()` reports. */
export type DuckdbFtsDropResult = {
    /** Table whose index was dropped. */
    table: string;
    /** `true` when an index existed. */
    dropped: boolean;
};

/** What `searchFts()` takes. */
export type DuckdbFtsSearchOptions = {
    /** Document identifier column — the **column**, not its name as a string. */
    id: string;
    /** Fields to search: a list, or a comma-separated string. Default: all indexed fields. */
    fields?: string[] | string;
    /** BM25 `k1` (default `1.2`). */
    k?: number;
    /** BM25 `b` (default `0.75`). */
    b?: number;
    /** Every term must be present (default `false`). */
    conjunctive?: boolean;
    /**
     * Extra SQL predicate, e.g. `"doc_version > 2"`. It is **SQL**, not a value:
     * never pass untrusted input here.
     */
    where?: string;
    /** Columns to return (default `*`); `score` is always appended. */
    select?: string[];
    /** Maximum rows (default `100`; `0` → no limit). */
    limit?: number;
};

/** What `searchFts()` returns. */
export type DuckdbFtsSearchResult = {
    /** Table searched. */
    table: string;
    /** The query string. */
    query: string;
    /** Matching rows, `score` included. */
    rows: Record<string, unknown>[];
    /** Call duration, row materialisation included. */
    duration_ms: number;
};

/** The distance metric an HNSW index is built for. */
export type DuckdbVssMetric = "l2sq" | "cosine" | "ip";

/** A vector index, as `createVssIndex()` takes it. */
export type DuckdbVssIndexOptions = {
    /** `FLOAT[N]` column to index. */
    column: string;
    /** Distance metric (default `'l2sq'`). */
    metric?: DuckdbVssMetric;
    /** HNSW `ef_construction` (default 128). */
    efConstruction?: number;
    /** HNSW `ef_search` (default 64). */
    efSearch?: number;
    /** HNSW `M` (default 16). */
    m?: number;
    /** HNSW `M0` (default `2 * M`). */
    m0?: number;
    /** Index name (default `vss_<table>_<column>`). */
    name?: string;
    /** Drop and recreate an existing index (default `true`). */
    overwrite?: boolean;
    /**
     * Enable `hnsw_enable_experimental_persistence` before creating the index —
     * required for a **file** database. In-memory databases do not need it.
     */
    persist?: boolean;
};

/** A vector index declared at server startup (`vssIndexes`). */
export type DuckdbVssIndex = DuckdbVssIndexOptions & {
    /** Table on the served database. */
    table: string;
};

/** What `createVssIndex()` reports. */
export type DuckdbVssIndexInfo = {
    /** Table indexed. */
    table: string;
    /** Name of the HNSW index. */
    index: string;
    /** Metric the index was built for. */
    metric: DuckdbVssMetric;
};

/** What `dropVssIndex()` reports. */
export type DuckdbVssDropResult = {
    /** Table whose index was dropped. */
    table: string;
    /** Index name. */
    index: string;
    /** `true` when the index existed. */
    dropped: boolean;
};

/** What `searchVss()` takes. */
export type DuckdbVssSearchOptions = {
    /** `FLOAT[N]` column to search. */
    column: string;
    /** Distance metric (default `'l2sq'`); it must match the index to accelerate. */
    metric?: DuckdbVssMetric;
    /** Number of neighbours (default `10`; must be > 0). */
    limit?: number;
    /** Columns to return (default `*`); `distance` is always appended. */
    select?: string[];
    /** Extra SQL predicate — trusted SQL only. */
    where?: string;
};

/** What `searchVss()` returns. */
export type DuckdbVssSearchResult = {
    /** Table searched. */
    table: string;
    /** Vector column. */
    column: string;
    /** Metric used. */
    metric: DuckdbVssMetric;
    /** Nearest rows, `distance` included (closest first). */
    rows: Record<string, unknown>[];
    /** Call duration, row materialisation included. */
    duration_ms: number;
};

/** A session variable, as `listVariables()` reports it. */
export type DuckdbVariable = {
    /** Variable name. */
    name: string;
    /** Value as text (`getVariable` returns it typed). */
    value: string | null;
    /** DuckDB type (`INTEGER`, `VARCHAR`, `BIGINT[]`…). */
    type: string;
};

/**
 * What `new DuckdbQuackInstance()` takes.
 *
 * The Quack part is at the top level, because it is what the class is for; leaving
 * `url` out gives a plain local instance.
 *
 * ```ts
 * const db = new DuckdbQuackInstance({
 *   url: 'quack:analytics.internal:9494',
 *   token: process.env.QUACK_TOKEN,
 *   tables: [
 *     { name: 'tickets', fields: [
 *       { name: 'prix', type: 'DOUBLE' },
 *       { name: 'libelle', type: 'string' },
 *     ] },
 *   ],
 * });
 * ```
 */
export type QuackInstanceOptions = {
    /**
     * The Quack server — `'quack:host'` (port 9494) or `'quack:host:port'`.
     * Omitted → a local instance, no remote attached.
     */
    url?: string;
    /**
     * The shared secret, sent as `CREATE SECRET (TYPE quack, TOKEN '…')`.
     * Falls back to the **`DUCKDB_QUACK_TOKEN`** environment variable when omitted.
     */
    token?: string;
    /**
     * The catalog name the remote is attached under (default `'quack'`).
     *
     * Attaching then runs `USE <alias>`: the remote becomes the instance's
     * **default catalog**, so an unqualified table name means the server's table.
     * The client's own database stays reachable, qualified (`memory.…`).
     */
    as?: string;
    /**
     * Select a database on the attached Quack server (`USE <db>`) — for a
     * server that exposes several databases (e.g. `ATTACH 'PROD_RTL.duckdb'`).
     * Omitted → the server's default database. Requires `url`.
     *
     * The selection is **per client session**: one instance per database, or
     * `exec("USE …")` later.
     */
    db?: string;
    /**
     * The transport, spelled out: `true` forces plain HTTP, `false` forces TLS
     * (even for a local URI), omitted keeps Quack's default — plain for a local
     * URI, TLS otherwise (`DISABLE_SSL`).
     */
    disableSsl?: boolean;
    /**
     * Refused: Quack 2.0 accepts `READ_ONLY` on ATTACH and ignores it, so the flag
     * cannot protect anything. Enforce read-only on the server with
     * `QuackServerOptions.authorizationFunction` instead.
     */
    readOnly?: boolean;
    /** Name given to the created secret (default `'anteros_quack'`). */
    secret?: string;
    /**
     * Open a **local** DuckDB file instead of an in-memory database — the local
     * workspace's own storage. The remote's data is never here: a Quack server owns
     * its own database, and this instance only ever sees it over the protocol.
     */
    dbPath?: string;
    /**
     * DuckDB configuration options applied to the local instance —
     * `{ threads: '2', memory_limit: '1GB' }`.
     *
     * `threads` is the one worth pinning: left alone, DuckDB takes one thread per
     * core of the machine.
     *
     * @see https://duckdb.org/docs/current/configuration/overview
     */
    options?: Record<string, string | number | boolean>;
    /**
     * Columns of a table created without a schema — the shape `createTable(name)`
     * and `ingest()` use. Default: `id` (string), `ts` (timestamp), `data` (json).
     */
    columns?: DuckdbColumn[];
    /**
     * Where a **background** `ingest()` write reports its failure — the caller of
     * `ingest()` is long gone by then, so a rejected promise has nobody to catch it.
     * Default: `console.error`.
     */
    onError?: (error: Error) => void;
    /**
     * Tables the instance must have, with their fields. Reconciled **in the
     * background** when it opens — see `syncSchema()`: create, add columns, retype;
     * a field the declaration does not know about is **never dropped**.
     */
    tables?: DuckdbTableSchema[];
};

/**
 * What `new DuckdbQuackServer()` takes.
 *
 * ```ts
 * const server = new DuckdbQuackServer({ port: 9494, token: process.env.QUACK_TOKEN! });
 * await server.start();
 * // clients: new DuckdbQuackInstance({ url: server.url, token: server.token })
 * ```
 */
export type QuackServerOptions = {
    /**
     * The shared secret a client must present to attach — **required**, and at
     * least **4 characters** (Quack's own rule). A server that looks protected and
     * is not is worse than one that refuses to start.
     */
    token: string;
    /** The port to listen on (default `9494`, Quack's own default). */
    port?: number;
    /**
     * The interface to bind (default `'127.0.0.1'` — localhost only).
     *
     * ⚠️ Binding is **not** enough to accept a remote client: Quack checks the
     * `Host` header and refuses anything but localhost unless
     * `allowOtherHostname` is set. A server meant to be reached sets both
     * (`host: '0.0.0.0'`, `allowOtherHostname: true`) — and then the token, and TLS,
     * are all that stand between the network and the data.
     */
    host?: string;
    /**
     * Accept a `Host` header that is not localhost (default `false`, Quack's own
     * default — it is what stops a DNS-rebinding attack from reaching a localhost
     * server). Required, with a non-loopback `host`, for a remote client to connect.
     */
    allowOtherHostname?: boolean;
    /**
     * The transport, spelled out: `true` serves plain HTTP, `false` forces TLS
     * (even for a local URI), omitted keeps Quack's default — plain for a local
     * URI, TLS otherwise.
     */
    disableSsl?: boolean;
    /**
     * **Where the data is saved.** Omitted → in memory, so every table is gone when
     * the process ends (the server still serves them for its whole lifetime).
     *
     * Set a file path (`dbPath`) to make the server's database durable — and this is the one
     * place a DuckDB file is the right answer: a Quack server is a **single** process
     * owning its database, so the cross-process lock that rules a file out for
     * per-worker instances cannot happen. A `mongodump`-style copy of that file is a
     * backup; nothing else in the protocol persists anything.
     */
    dbPath?: string;
    /**
     * Target size of one wire batch (`quack_target_batch_bytes`, default 32 MiB) —
     * the server-side batching knob: raise it to cut per-message overhead on wide
     * results, lower it to bound memory.
     */
    targetBatchBytes?: number;
    /**
     * TLS certificate used when serving HTTPS (`ssl_cert_file`). Quack generates a
     * self-signed pair when omitted. Refused together with `disableSsl: true`.
     */
    sslCertFile?: string;
    /** Private key matching `sslCertFile` (`ssl_key_file`). */
    sslKeyFile?: string;
    /**
     * Name of a `(sid, client_token, server_token) -> BOOLEAN` scalar function used
     * to authenticate clients, replacing the default `quack_check_token`
     * (`quack_authentication_function`). Registered **on the server instance** by
     * you — see `db.raw()` for that.
     */
    authenticationFunction?: string;
    /**
     * Name of a `(sid, query) -> BOOLEAN` scalar function authorizing **each query**,
     * replacing the default `quack_nop_authorization`
     * (`quack_authorization_function`) — the place to refuse a `DROP` or a `COPY`
     * from a given client.
     */
    authorizationFunction?: string;
    /** Identity this node advertises, read back with `whoami()` (`quack_identify`). */
    identity?: {
        name?: string;
        provider?: string;
        hostname?: string;
        region?: string;
        /** Free-form JSON string. */
        meta?: string;
    };
    /** DuckDB configuration of the server instance (`{ threads: '4' }`…). */
    options?: Record<string, string | number | boolean>;
    /** Columns of a table created without a schema. Default: `id` / `ts` / `data`. */
    columns?: DuckdbColumn[];
    /** Tables the server owns, with their fields — reconciled like `QuackInstanceOptions.tables`. */
    tables?: DuckdbTableSchema[];
    /**
     * Full-text indexes built **before** the server starts listening (the `fts`
     * extension is autoloaded). Rebuilt at each start (`overwrite` defaults to
     * `true`), so a restart picks up new rows; pass `incremental: true` to keep an
     * index current instead.
     */
    ftsIndexes?: DuckdbFtsIndex[];
    /**
     * HNSW vector indexes built **before** the server starts listening. The `vss`
     * extension is installed/loaded on first use.
     */
    vssIndexes?: DuckdbVssIndex[];
    /**
     * Enable `hnsw_enable_experimental_persistence` on the server instance —
     * required to create an HNSW index in a **file** database. DuckDB marks this
     * persistence as experimental (WAL recovery is not implemented for it).
     */
    vssPersist?: boolean;
    /** Where a failed background `ingest` reports itself (default `console.error`). */
    onError?: (error: Error) => void;
};

/** What `exec()` returns. */
export type DuckdbExecResult = {
    /** Column names, in the order the statement returned them. */
    columns: string[];
    /** DuckDB types, as text (`'VARCHAR'`, `'TIMESTAMP'`, `'BIGINT'`…). */
    types: string[];
    /**
     * Rows as plain objects (DuckDB's JSON form: a `BIGINT` is a string, an
     * `INTERVAL` an object…). A `JSON` column is the **text** DuckDB stores —
     * `JSON.parse` it for the value.
     */
    rows: Record<string, unknown>[];
    /**
     * How long the statement took, in milliseconds (Quack's name for it).
     *
     * Measured in this process around the execution **and** the row materialisation;
     * opening/attaching the instance is not counted. In remote mode it therefore
     * includes the round trip; it is **not** the server's own internal duration —
     * Quack only exposes that per message, in whole milliseconds, through
     * `CALL enable_logging('Quack')` + `duckdb_logs_parsed('Quack')`.
     */
    duration_ms: number;
};

/**
 * The handle passed to `transaction()`.
 *
 * `exec` always runs **server-side** on an attached instance (values are inlined),
 * so it stays inside the open transaction. The high-level writers (`ingest`,
 * `createTable`, `deleteTable`, and `exec` with values outside `tx`) run in the
 * client engine and do **not** join it.
 */
export type DuckdbTransaction = {
    /** Run one statement in the open transaction. */
    exec(sql: string, values?: any[] | Record<string, any>): Promise<DuckdbExecResult>;
};

/** `exec()` options. */
export type DuckdbExecOptions = {
    /**
     * Bound values, same as passing them as the second argument.
     *
     * On an attached instance every statement runs **on the Quack server** — except
     * one taking bound `values`, which has to run in the **client's** engine: the
     * server only ever receives SQL text, so it cannot take parameters.
     */
    values?: any[] | Record<string, any>;
};

/** What `createTable` / `deleteTable` report. */
export type DuckdbTableInfo = {
    table: string;
    /** Column names the table has (empty for `deleteTable`). */
    columns: string[];
    /** `true` when the table did not exist before (`createTable`). */
    created: boolean;
    /** `true` when the table existed before (`deleteTable`). */
    dropped?: boolean;
};

/** `ingest({ table, rows })`. */
export type DuckdbIngestOptions = {
    /** The table to write into — created on the spot when it does not exist. */
    table: string;
    /**
     * The rows. Column names are the keys of the objects; a missing `ts` is filled
     * with the current time and a missing `id` with a UUID.
     */
    rows: Array<Record<string, unknown>>;
    /** Columns used if the table has to be created (the instance's default otherwise). */
    columns?: DuckdbColumn[];
};

/** What `ingest()` reports — it does **not** wait for the write (`flush()` does). */
export type DuckdbIngestResult = {
    table: string;
    /** Rows queued — `await db.flush()` to wait for them to be written. */
    queued: number;
};

/** A document of a data table — an arbitrary object, stored as one `data` value. */
export type DuckdbDocument = Record<string, unknown>;

/** `db.update()` request — the table, the filter, and the fields to merge. */
export type DuckdbUpdateOptions = {
    /** The table holding the documents. */
    table: string;
    /** SQL predicate selecting the rows — mandatory. */
    filter: string;
    /** Fields merged into each matching document (`json_merge_patch`). */
    set: DuckdbDocument;
};

/** `db.replace()` request — the table, the filter, and the document to store. */
export type DuckdbReplaceOptions = {
    /** The table holding the documents. */
    table: string;
    /** SQL predicate selecting the rows — mandatory. */
    filter: string;
    /** The whole document stored in place of the previous one. */
    set: DuckdbDocument;
};

/** `db.delete()` request — the table and the filter selecting the rows. */
export type DuckdbDeleteOptions = {
    /** The table holding the documents. */
    table: string;
    /** SQL predicate selecting the rows — mandatory. */
    filter: string;
};

/** `db.table()` options. */
export type DuckdbTableOptions = {
    /**
     * The field of the document used as the row's `ts` — `{ ts: 'createdAt' }`
     * maps `data.createdAt` to the timestamp column. Omitted → the ingestion time.
     */
    ts?: string;
};

/** What a table's `ingest()` reports — queued, not written (`flush()` waits). */
export type DuckdbTableIngestResult = {
    /** Table name. */
    table: string;
    /** Documents queued. */
    queued: number;
};

/** What `table.update()` reports — documents matched by the filter, patched. */
export type DuckdbTableUpdateResult = {
    /** Table name. */
    table: string;
    /** Documents updated. */
    updated: number;
};

/** What `table.replace()` reports — documents matched by the filter, replaced. */
export type DuckdbTableReplaceResult = {
    /** Table name. */
    table: string;
    /** Documents replaced. */
    replaced: number;
};

/** What `table.delete()` reports — documents matched by the filter, deleted. */
export type DuckdbTableDeleteResult = {
    /** Table name. */
    table: string;
    /** Documents deleted. */
    deleted: number;
};
