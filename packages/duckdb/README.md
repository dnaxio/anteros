# @anteros/duckdb

A DuckDB instance over the **[Quack](https://duckdb.org/quack/)** protocol — the protocol that turns DuckDB into a client-server database.

- Two classes: **`DuckdbQuackInstance`** (the client) and **`DuckdbQuackServer`** (the server)
- Attaching a server makes it the **default catalog**: unqualified `events` is the server's table, and the client's own memory catalog stays reachable as `memory.<table>`
- **Data tables**: `db.table("tickets")` → `data` (JSON) + `ts` (TIMESTAMP), `ts` mapping a document field
- `exec`, `createTable`, `deleteTable`, `listTables`, `ingest` + `flush`, `raw()`, `close()` — and nothing else to configure

> ⚠️ **Quack is experimental through DuckDB 1.x.** DuckDB documents the protocol, the function names and the
> implementation details as subject to change up to the stable 2.0 line. This package is pinned to
> `@duckdb/node-api` **2.0.0-r.1** (DuckDB 2.0.0): pin it too, and prefer this package over hand-rolling the
> attach so the SQL lives in one place.

## CLI

Serving a database from the terminal is the other package's job: [`@anteros/quack`](../quack) ships the
`antq` binary — `bunx @anteros/quack start --token …`. That package is standalone (it depends on
`@duckdb/node-api`, not on this one); this package keeps the library: the two classes, their options, and
the protocol's traps.

## Install

```bash
bun add @anteros/duckdb
```

## Quack in 30 seconds

The **server** is a DuckDB instance that listens (any DuckDB process — the CLI, another Bun process, a container):

```sql
INSTALL quack;         -- auto-installed on first use, but explicit is fine
LOAD quack;
CALL quack_serve('quack:0.0.0.0:9494', token = 'super-secret');
```

The **client** is this package:

```ts
import { DuckdbQuackInstance } from "@anteros/duckdb";

const db = new DuckdbQuackInstance({
  url: "quack:localhost:9494",
  token: process.env.QUACK_TOKEN,
  options: { threads: "2" },     // the client instance: pin the threads
});

// One table, two columns: `data` (JSON) and `ts` (TIMESTAMP).
const tickets = await db.table("tickets", { ts: "createdAt" });
await tickets.ingest([
  { ref: "A-1", total: 42, createdAt: "2026-10-01T08:30:00Z" },
  { ref: "A-2", total: 7 },
]);
await tickets.flush();

const { rows, duration_ms } = await db.exec(`
  SELECT ts, data->>'ref' AS ref, CAST(data->>'total' AS DOUBLE) AS total
    FROM tickets ORDER BY ts
`);

// CRUD on matching documents — the filter is mandatory.
await tickets.update("data->>'ref' = 'A-1'", { total: 43 });
await tickets.replace("data->>'ref' = 'A-2'", { ref: "A-2", total: 7 });
await tickets.delete("data->>'ref' = 'A-2'");

await db.close();
```

## Options

| Option     | Type                                    | Default            | Description                                                                    |
| ---------- | --------------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| `url`      | `string`                                | —                  | The Quack server, `'quack:host'` (9494) or `'quack:host:port'`. Omit for a purely local instance. |
| `token`    | `string`                                | `DUCKDB_QUACK_TOKEN` | The shared secret, sent as a secret **scoped to `url`** (`CREATE SECRET … SCOPE '…'`). |
| `as`       | `string`                                | `'quack'`          | The catalog name the remote is attached under — and then made the **default catalog** (`USE`). |
| `readOnly` | `boolean`                               | —                  | **Refused** — Quack 2.0 accepts `READ_ONLY` on `ATTACH` and ignores it. Enforce it on the server (`authorizationFunction`). |
| `disableSsl` | `boolean`                             | Quack's default    | `true` = plain HTTP, `false` = forced TLS (even localhost), omitted = plain for a local URI and TLS otherwise (`DISABLE_SSL`). |
| `secret`   | `string`                                | `'anteros_quack'`  | Name given to the created secret.                                              |
| `dbPath`   | `string`                                | —                  | Open a **local** DuckDB file instead of memory. The remote's data is never here. |
| `options`  | `Record<string, string \| number \| boolean>` | —            | DuckDB configuration of the local instance (`threads`, `memory_limit`…).        |
| `columns`  | `DuckdbColumn[]`                        | `id`/`ts`/`data`   | Shape of a table created without a schema.                                     |
| `tables`   | `DuckdbTableSchema[]`                   | —                  | Tables the instance must have — reconciled at startup (see below).             |
| `onError`  | `(error: Error) => void`                | `console.error`    | Where a failed **background** `ingest` reports itself.                         |

## Methods

| Method                                      | What it does                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| `connect()`                                 | Opens the local instance and attaches the remote. Idempotent, called for you.    |
| `exec(sql, values?)`                        | Runs one statement, returns `{ columns, types, rows, duration_ms }`. On an attached instance it runs **on the Quack server** (`quack_query_by_name`); `values` run in the client engine, inlined as SQL literals (Quack 2.0 cannot bind parameters on a remote catalog). |
| `createTable(table, columns?)`              | `CREATE TABLE IF NOT EXISTS` — on the attached remote when there is one.         |
| `deleteTable(table)`                        | `DROP TABLE IF EXISTS` — on the attached remote when there is one.               |
| `listTables()`                              | The tables of the attached remote, or of the local catalog when not attached.     |
| `createFtsIndex(table, options)`            | Builds/rebuilds a full-text index (`fts`); on the attached remote when there is one. |
| `searchFts(table, query, options)`          | BM25 search, best match first — runs on the server when attached.                 |
| `dropFtsIndex(table)`                       | Drops the index; `dropped: false` when there was none.                            |
| `createVssIndex(table, options)`            | Builds/rebuilds an HNSW index on a `FLOAT[N]` column (`vss`).                      |
| `searchVss(table, vector, options)`         | Nearest vectors, `distance` included — runs on the server when attached.           |
| `dropVssIndex(table, options)`              | Drops the HNSW index; `dropped: false` when there was none.                        |
| `setVariable(name, value)`                  | `SET VARIABLE name = value`; on the server when attached.                          |
| `getVariable(name)` / `resetVariable(name)` | Read (`null` when unset) / `RESET VARIABLE`.                                        |
| `listVariables()`                           | Every session variable with its type (`duckdb_variables()`).                        |
| `ingest({ table, rows })`                   | Queues rows **in the background**; creates the table if it is missing (on the remote when attached). |
| `flush()`                                   | Waits for every queued write.                                                    |
| `syncSchema()`                              | Waits for the startup reconciliation of `tables` — reports what changed.          |
| `table(name, { ts? })`                      | A **data table** — `data` JSON + `ts` TIMESTAMP, created in the background.       |
| `update(table, where, patch)`               | Shorthand for `(await db.table(name)).update(…)` — filter mandatory.              |
| `replace(table, where, document)`           | Shorthand for `(await db.table(name)).replace(…)` — filter mandatory.             |
| `delete(table, where)`                      | Shorthand for `(await db.table(name)).delete(…)` — filter mandatory.              |
| `raw()`                                     | The underlying `{ instance, connection }` — the escape hatch.                    |
| `close()`                                   | Closes the instance; later calls are refused.                                    |
| `isConnected` / `isAttached` / `url` / `alias` | State, readable at any time.                                                  |

`duration_ms` is the **call** duration: execution, the result transfer (remote mode) and the
**row materialisation** (columns + `rows` built as JS objects) — opening/attaching the instance is not counted.
A query returning 500k rows costs far more than the same scan aggregated to one row, and that difference *is*
in `duration_ms`.

### Where a statement runs

On an attached instance, `exec` **always** runs the statement on the **Quack server**
(`quack_query_by_name`): the remote computes, and only the result crosses the wire — what a large aggregate
needs, since the client path would fetch every `data`.

```ts
await db.exec("SELECT SUM(CAST(data.prix AS INT)) AS total FROM tickets"); // on the server
await db.exec("SELECT * FROM tickets WHERE id = $1", ["a-1"]);             // client (values inlined)
```

One exception: a statement with bound `values` runs in the **client's** engine. Quack 2.0 prepares it against
the attached catalog and does **not** carry bind parameters over the wire, so this package inlines them as
escaped SQL literals (`$1`, `$name`; quoted strings, identifiers, dollar-quotes and comments are left alone).
The client's own catalog and the remote alias are then reachable through `db.raw()` — an escape hatch, not the
normal path. On a local instance (no `url`), everything runs in the client and the values stay bound: there is
no server.

### Session variables

`SET VARIABLE` is available through `exec`, and wrapped by four methods:

```ts
await db.setVariable("my_var", 30);
await db.getVariable("my_var");        // 30
await db.exec("SELECT 20 + $my_var");  // 50
await db.listVariables();              // [{ name, value, type }]
await db.resetVariable("my_var");
```

- `setVariable` handles scalars: string, number, boolean, `null`, `Date` (`TIMESTAMP`). For a DuckDB
  list/map or a query result, run the SQL yourself: `db.exec("SET VARIABLE files = (SELECT list(...) …)")`.
- `getVariable` uses `getvariable()` and returns `null` for an unset variable.
- On an attached instance, the four methods run **on the Quack server**, and variables are session-scoped:
  they persist across `exec` calls without values. A statement with bound `values` runs in the client engine,
  so it reads/writes **client** variables instead.
- `$name` is DuckDB 2.0's shorthand for `getvariable('name')`. Our inliner leaves a `$name` it was not given
  a value for to DuckDB, so session variables still work; unlike `getvariable`, an unset `$name` raises.
- `listVariables()` reads `duckdb_variables()`: `value` is text, `type` is the DuckDB type.
- Variables are session state — nothing is persisted in the database file.

### Default table shape

`id` (VARCHAR), `ts` (TIMESTAMP), `data` (JSON) — an append-only event log. A row that leaves `ts` or `id` out gets the current time and a UUID; a `Date` is written as the local wall clock (`formatTimestamp`, exported).

A `JSON` column reads back as the **string** DuckDB stores: `JSON.parse` it for the object.

### Data tables (JSON documents)

The canonical shape: **two columns**, `data` (`JSON`) and `ts` (`TIMESTAMP`). `db.table(name)` returns a
handle and creates the table **in the background** when it is missing — `ingest()` waits for that creation.

```ts
const tickets = await db.table("tickets", { ts: "createdAt" });   // ts ← data.createdAt

await tickets.ingest([
  { ref: "A-1", total: 42, createdAt: "2026-10-01T08:30:00Z" },
  { ref: "A-2", total: 7 },                                       // no createdAt → now()
]);
await tickets.flush();

const { rows } = await db.exec(`
  SELECT ts, data->>'ref' AS ref, CAST(data->>'total' AS DOUBLE) AS total
    FROM tickets ORDER BY ts
`);
```

CRUD on the matching documents — the **filter is mandatory**:

```ts
await tickets.update("data->>'ref' = 'A-1'", { total: 43 });   // { table, updated }
await tickets.replace("data->>'ref' = 'A-2'", { ref: "A-2" }); // { table, replaced }
await tickets.delete("data->>'ref' = 'A-2'");                  // { table, deleted }

// Or from the instance, without holding the handle:
await db.update("tickets", "data->>'ref' = 'A-1'", { total: 44 });
await db.replace("tickets", "data->>'ref' = 'A-2'", { ref: "A-2" });
await db.delete("tickets", "data->>'ref' = 'A-2'");
```

| Element | What it does |
| --- | --- |
| `db.table(name, { ts })` | A handle; the table (`data` JSON, `ts` TIMESTAMP) is created in the background if missing |
| `table.ready()` | Waits for that creation |
| `table.ingest(documents, { ts })` | Queues documents — one row each: `data` = the object, `ts` = the mapped field or the ingestion time |
| `table.update(where, patch)` | Patches matching documents (`json_merge_patch`) — **filter mandatory**, server-side |
| `table.replace(where, document)` | Replaces matching documents entirely — **filter mandatory**, server-side |
| `table.delete(where)` | Deletes matching documents — **filter mandatory**, server-side |
| `table.flush()` | Waits for the queued writes |

`ts` is mapped from a document field (`{ ts: "createdAt" }`, or per `ingest` call); a `Date`, an epoch number
or an ISO string is accepted, and anything unreadable falls back to the ingestion time. A table that already
exists with another shape is refused (`DUCKDB_TABLE_SHAPE_INVALID`) rather than written into blindly.

### Declared tables (startup schema)

The tables an instance must have can be declared at initialization, with their fields:

```ts
const db = new DuckdbQuackInstance({
  url: "quack:127.0.0.1:9494",
  token: process.env.QUACK_TOKEN,
  tables: [
    { name: "tickets", fields: [
      { name: "prix", type: "DOUBLE" },
      { name: "libelle", type: "string" },
    ] },
  ],
});
```

When the instance opens, the declaration is reconciled **in the background** — `syncSchema()` waits for it and
returns what changed:

| Situation | What happens |
| --- | --- |
| table missing | created with the declared fields |
| a declared field is missing | added (`ALTER TABLE … ADD COLUMN`) |
| a declared type differs | changed (`ALTER TABLE … ALTER COLUMN … SET DATA TYPE`) |
| a column the declaration does not name | **never dropped** — carried over untouched |

```ts
const report = await db.syncSchema();
// { tables: [{ table: "tickets", created: false, added: ["zone"], retyped: ["prix"] }] }
```

A failure in the background goes to `onError`, not to the next query. `required`/`primaryKey` only apply when
the table is **created**: a column added to an existing table cannot be `NOT NULL` without a default.

> ⚠️ Quack does **not** implement `ALTER TABLE` on an attached catalog (`Not implemented Error: Alter not
> implemented yet`). On a remote, the migration is a **rebuild**: the rows are copied into a temp table, the
> table recreated with the reconciled schema, then the rows copied back — unknown columns included. It is a
> startup reconciliation, not an online migration: it is not atomic, and the rows travel through the client.
> A copy is kept while it runs — if the rebuild fails after the drop, the original table is restored from it.
> On a **local** instance (`server.db`), the migration is an in-place `ALTER TABLE`.

## Full-text search

DuckDB's [`fts` extension](https://duckdb.org/docs/2.0/core_extensions/full_text_search) is wrapped by three
methods. It is autoloaded on first use; the index lives in a schema named `fts_<catalog>_<table>`
(`fts_main_documents` for `documents`).

```ts
await db.createFtsIndex("documents", {
  id: "document_identifier",          // the id column
  fields: ["text_content", "author"], // a name, a list, or "*" for every VARCHAR
  stemmer: "english",                 // porter by default
  incremental: true,                  // keep it current; id must be NOT NULL / PRIMARY KEY
});

const { rows } = await db.searchFts("documents", "small cats", {
  id: "document_identifier",          // the column, not its name as a string
  fields: "text_content",             // default: every indexed field
  limit: 10,
});
// rows: [{ document_identifier, text_content, …, score }]

await db.dropFtsIndex("documents");
```

| Option (`createFtsIndex`)                | Default                    | What it does                                                        |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------------------- |
| `id`                                     | —                          | Document identifier column                                           |
| `fields`                                 | —                          | One name, `string[]`, or `'*'` for every `VARCHAR` column            |
| `stemmer` / `stopwords` / `ignore`       | `porter` / `english` / …   | Tokenisation — see the extension's reference                        |
| `stripAccents` / `lower`                 | `true`                     | Normalise before indexing                                           |
| `overwrite`                              | `true`                     | `true` rebuilds; `false` keeps an existing index (creates only when missing) |
| `incremental`                            | `false`                    | Triggers keep it current; `id` must be `NOT NULL` / `PRIMARY KEY`   |

`searchFts` adds `fields` (a name, a list, or a comma-separated string), `k` (1.2), `b` (0.75),
`conjunctive`, `where` (a **raw SQL** predicate — never pass untrusted input), `select` (an array of
returned columns, default `*`) and `limit` (default **100**; `0` disables the cap). `score` is the BM25
score, best match first.

Three options are easy to confuse: `id` is the index's **join key** — pass the same column as
`createFtsIndex`, it is not a filter; `fields` **narrows the search** to some indexed columns; `select` only
**narrows the returned columns**. An `id` that does not match the index yields no rows; a `fields` entry that
was not indexed throws `DUCKDB_FTS_FIELD_UNKNOWN` (the method checks the index's own field list).

On an attached instance, `createFtsIndex` and `searchFts` run **on the Quack server** — the index and its
macro live where the table is. Use the **server-side** table name (unqualified or `schema.table`); the client
alias (`quack.table`) is accepted and stripped.

A server can build indexes before it opens the port:

```ts
new DuckdbQuackServer({
  token: process.env.QUACK_TOKEN!,
  dbPath: "./data/docs.duckdb",
  ftsIndexes: [
    // `overwrite: false` keeps the index across restarts; omit it to rebuild.
    { table: "documents", id: "document_identifier", fields: ["text_content", "author"], overwrite: false },
  ],
});
```

> ⚠️ Without `incremental: true`, the index does **not** follow inserts/deletes — recreate it after a batch
> (`createFtsIndex` defaults to `overwrite: true`), or use `incremental` with a `NOT NULL` / `PRIMARY KEY` id.

### Worked example

```ts
await db.createTable("documents", [
  { name: "id", type: "string", primaryKey: true },
  { name: "title", type: "string" },
  { name: "body", type: "string" },
  { name: "author", type: "string" },
  { name: "category", type: "string" },
]);
await db.ingest({
  table: "documents",
  rows: [
    { id: "d1", title: "The cat", body: "The cat is a small carnivorous mammal.", author: "Alice", category: "animals" },
    { id: "d2", title: "Domestic cats", body: "Domestic cats sleep a lot.", author: "Bob", category: "animals" },
    { id: "d3", title: "The mallard", body: "The mallard is a migratory duck.", author: "Alice", category: "animals" },
    { id: "d4", title: "Filter coffee", body: "A recipe for filter coffee and green tea.", author: "Chloe", category: "food" },
  ],
});
await db.flush();

await db.createFtsIndex("documents", {
  id: "id",
  fields: ["title", "body", "author"],
  stemmer: "english",
  incremental: true,
});

// Stemming matches "cat" and "cats".
const byText = await db.searchFts("documents", "cats", { id: "id", limit: 5 });
// d1 The cat · d2 Domestic cats

// One field only, plus an extra SQL predicate.
const byAuthor = await db.searchFts("documents", "Alice", {
  id: "id",
  fields: "author",
  where: "category = 'animals'",
  select: ["id", "title", "author"],
});
// d1 The cat · d3 The mallard

// Every term must be present.
const conjunctive = await db.searchFts("documents", "migratory duck", { id: "id", conjunctive: true });
// d3 The mallard
```

Because the index is `incremental`, a row ingested afterwards is searchable without rebuilding:

```ts
await db.ingest({
  table: "documents",
  rows: [{ id: "d5", title: "The swan", body: "The swan is an aquatic bird.", author: "Alice", category: "animals" }],
});
await db.flush();

const swan = await db.searchFts("documents", "swan", { id: "id" });
// d5 The swan
```

### Search from SQL

The wrapper is optional: the macro is a normal DuckDB function. `match_bm25` takes the **id column** (not its
name as a string), and the index lives in `fts_main_<table>`:

```sql
SELECT document_identifier, text_content, score
  FROM (
    SELECT *, fts_main_documents.match_bm25(document_identifier, 'small cats') AS score
      FROM documents
  ) sq
 WHERE score IS NOT NULL
 ORDER BY score DESC
 LIMIT 10;
```

## Vector similarity search

DuckDB's [`vss` extension](https://duckdb.org/docs/2.0/core_extensions/vss) adds HNSW indexes on fixed-size
`FLOAT[N]` columns. Unlike `fts`, it is **not autoloaded**: `createVssIndex` / `searchVss` run `LOAD vss`
(installing it on first use) on the instance — on the Quack server when attached.

```ts
await db.createTable("embeddings", [
  { name: "id", type: "string", primaryKey: true },
  { name: "label", type: "string" },
  { name: "vec", type: "FLOAT[3]" },
]);
await db.ingest({
  table: "embeddings",
  rows: [
    { id: "e1", label: "cat", vec: [1, 0, 0] },
    { id: "e2", label: "dog", vec: [0, 1, 0] },
    { id: "e3", label: "bird", vec: [0, 0, 1] },
    { id: "e4", label: "kitten", vec: [0.9, 0.1, 0] },
  ],
});
await db.flush();

await db.createVssIndex("embeddings", { column: "vec", metric: "cosine" });

const { rows } = await db.searchVss("embeddings", [1, 0, 0], {
  column: "vec",       // the FLOAT[N] column
  metric: "cosine",    // must match the index to accelerate
  select: ["id", "label"],
  limit: 3,            // default: 10
});
// e1 cat (0) · e4 kitten (0.006) · e2 dog (1)

await db.dropVssIndex("embeddings", { column: "vec" });
```

| Option (`createVssIndex`)       | Default                  | What it does                                                       |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| `column`                        | —                        | `FLOAT[N]` column to index                                          |
| `metric`                        | `'l2sq'`                 | `'l2sq'`, `'cosine'` or `'ip'`                                      |
| `efConstruction` / `efSearch`   | `128` / `64`             | HNSW construction/search candidate count                            |
| `m` / `m0`                      | `16` / `2 * M`           | Graph connectivity (per level / level 0)                            |
| `name`                          | `vss_<table>_<column>`   | Index name                                                          |
| `overwrite`                     | `true`                   | Drop and recreate an existing index                                 |
| `persist`                       | `false`                  | Enable experimental persistence — required for a **file** database  |

| `metric` | Distance function                | Meaning                    |
| -------- | -------------------------------- | -------------------------- |
| `l2sq`   | `array_distance`                 | Squared L2 (Euclidean)     |
| `cosine` | `array_cosine_distance`          | Cosine distance            |
| `ip`     | `array_negative_inner_product`   | Negative inner product     |

`searchVss(table, vector, { column, metric, limit, select, where })` returns the nearest rows with a
`distance` column, closest first. `select` is an array of columns (default `*`); `where` is **raw SQL**
(trusted input only); `limit` defaults to **10** and must be greater than 0. The HNSW index accelerates the
`ORDER BY <distance>(col, constant) LIMIT n` shape — a `where` predicate may make the planner fall back to a
scan. Check with `EXPLAIN`: the plan shows `Hnsw Index Scan`.

A **file** database refuses HNSW indexes unless `hnsw_enable_experimental_persistence` is enabled — either per
call (`createVssIndex(..., { persist: true })`) or for the whole server (`vssPersist: true`). DuckDB marks that
persistence as experimental: WAL recovery is not implemented for custom indexes.

```ts
new DuckdbQuackServer({
  token: process.env.QUACK_TOKEN!,
  dbPath: "./data/vecs.duckdb",
  vssPersist: true,
  vssIndexes: [
    { table: "embeddings", column: "vec", metric: "cosine" },
  ],
});
```

### Search vectors from SQL

The distance functions are core DuckDB; only the index needs `vss`:

```sql
SELECT id, label, array_cosine_distance(vec, CAST([1, 0, 0] AS FLOAT[3])) AS distance
  FROM embeddings
 ORDER BY array_cosine_distance(vec, CAST([1, 0, 0] AS FLOAT[3]))
 LIMIT 3;
```

### Embeddings from Transformers.js

`@xenova/transformers` runs the model locally (ONNX). Its output is a `Float32Array`; convert it with
`output.tolist()` — a `Float32Array` would be serialised as JSON by `ingest` instead of being a vector. Build
the column from the model's dimension:

```ts
import { pipeline } from "@xenova/transformers";

const embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const embed = async (texts: string[]) =>
  (await embedder(texts, { pooling: "mean", normalize: true })).tolist();

const texts = ["The cat is a small mammal.", "The mallard is a migratory duck."];
const vectors = await embed(texts);

await db.createTable("documents", [
  { name: "id", type: "string", primaryKey: true },
  { name: "text", type: "string" },
  { name: "vec", type: `FLOAT[${vectors[0]!.length}]` },
]);
await db.ingest({
  table: "documents",
  rows: texts.map((text, index) => ({ id: `d${index + 1}`, text, vec: vectors[index] })),
});
await db.flush();
await db.createVssIndex("documents", { column: "vec", metric: "cosine" });

const [queryVector] = await embed(["A migratory bird"]);
const { rows } = await db.searchVss("documents", queryVector, {
  column: "vec",
  metric: "cosine",
  limit: 3,
});
```

Common dimensions: `all-MiniLM-L6-v2` and `paraphrase-multilingual-MiniLM-L12-v2` → 384;
`bge-base-en-v1.5` and `all-mpnet-base-v2` → 768. Use the same model, pooling and normalization for documents
and queries; changing the model means a new `FLOAT[N]` column and a rebuilt index. For French, prefer the
multilingual models (`paraphrase-multilingual-MiniLM-L12-v2`, `multilingual-e5-small` — the latter expects
`query:` / `passage:` prefixes).

## Serving — the server side

`DuckdbQuackServer` is the other half: a DuckDB instance that accepts clients over the protocol, on a port, behind a token.

```ts
import { DuckdbQuackServer } from "@anteros/duckdb";

const server = new DuckdbQuackServer({
  port: 9494,                        // default: 9494
  host: "127.0.0.1",                 // default: localhost
  token: process.env.QUACK_TOKEN!,   // required, at least 4 characters

  dbPath: "./data/analytics.duckdb", // ← the only place the data is saved (omit → in memory)

  allowOtherHostname: false,         // true to accept a non-localhost Host header
  // disableSsl: true,               // true = plain HTTP, false = forced TLS, omitted = Quack's default
  targetBatchBytes: 33_554_432,      // quack_target_batch_bytes (32 MiB, Quack's default)
  // sslCertFile: "./certs/server.pem", // TLS pair; omitted → Quack generates a self-signed one
  // sslKeyFile: "./certs/private_key.pem",
  options: { threads: "4" },
});

await server.start();                            // CALL quack_serve(…), idempotent

// The server owns the data, and builds it with the very same methods:
await server.db.createTable("orders");
await server.db.ingest({ table: "orders", rows: [{ data: { ref: "A-1" } }] });
await server.db.flush();

console.log(server.listenUri);                   // quack:127.0.0.1:9494 — what clients attach
console.log(server.listenUrl);                   // http://127.0.0.1:9494 — what quack_serve bound
await server.stop();                             // CALL quack_stop(…), then closes the instance
```

### Where the data is saved

Quack has **no storage option of its own**: the server *is* a DuckDB database, and whatever is in it is what clients see over the protocol. So the answer is one line of configuration:

| `dbPath` | Where the data lives | Survives a restart |
| --- | --- | --- |
| omitted | in memory | no — the tables serve every attached client for the lifetime of the process, then die with it |
| set | a DuckDB file | yes — the file *is* the database; copy it to back it up, and `stop()` releases the lock |

This is the one place a DuckDB **file** is the right answer: a Quack server is a **single** process owning its database, so the cross-process lock that rules a file out for per-worker instances cannot happen — that is exactly the architecture Quack exists to allow (one writer, N readers).

> The token is at least **4 characters** (Quack's rule, checked at construction), and a non-loopback `host` is **not enough** to accept a remote client: Quack checks the `Host` header and refuses anything but localhost unless `allowOtherHostname` is set. A server meant to be reached sets both — and then the token (and TLS) is all that stands between the network and the data.

### The rest of Quack

Reachable from `server.db.exec(...)` / `server.db.raw()` — the options `DuckdbQuackServer` does not wrap:

| Quack surface | What it is for |
| --- | --- |
| `quack_authentication_function` | Replace the static token with your own `(sid, client_token, server_token) -> BOOLEAN` |
| `quack_authorization_function` | Authorize **each query** — `(sid, query) -> BOOLEAN`; the place to refuse a `DROP` or a `COPY` per client |
| `quack_identify(...)` / `whoami()` | What the node advertises (`name`, `provider`, `hostname`, `region`, `meta`) — `identity` in the options |
| `quack_target_batch_bytes` | Target in-memory size of one wire batch (default 32 MiB) — `targetBatchBytes` in the options |
| `ssl_cert_file` / `ssl_key_file` | TLS certificate and key for an HTTPS server — `sslCertFile` / `sslKeyFile` in the options |
| `quack_active_connections()` / `quack_server_list()` | Who is attached, what is being served |
| `quack_query(uri, sql, token := …)` | One-shot remote query, without attaching |
| `quack_query_by_name(catalog, sql)` | A query through an existing attachment — what `exec` uses on the client |
| `fts` extension / `match_bm25(…)` | Full-text search — wrapped by `createFtsIndex` / `searchFts` / `dropFtsIndex` |
| `vss` extension / HNSW indexes | Vector similarity search — wrapped by `createVssIndex` / `searchVss` / `dropVssIndex` |
| `enable_logging('Quack' \| 'HTTP')` + `duckdb_logs_parsed(...)` | Per-message logs (`quack_connection_id`, `client_query_id`, `duration_ms`) and the HTTP transport |

### Members

| Member        | What it is                                                                        |
| ------------- | --------------------------------------------------------------------------------- |
| `start()`     | Opens the instance and serves. Idempotent.                                         |
| `stop()`      | `quack_stop`, then closes the instance. Idempotent.                                 |
| `db`          | The local `DuckdbQuackInstance` being served — the tables the clients see.         |
| `listenUri`   | The URI `quack_serve` actually bound, e.g. `quack:127.0.0.1:9494`.                  |
| `listenUrl`   | The HTTP(S) URL behind it, once started — `undefined` before `start()` / after `stop()`. |
| `url`         | Alias of `listenUri`: exactly what a client hands to `DuckdbQuackInstance`.        |
| `token`       | The secret clients must present.                                                   |
| `host` / `port` | What it binds (defaults `'127.0.0.1'` / `9494`).                                 |
| `isRunning`   | Whether it is accepting connections.                                               |

> ⚠️ An empty token is refused at construction, and `host` defaults to **localhost**: exposing a Quack server to a network is a deliberate act (`host: '0.0.0.0'`), and the token is then the only thing in the way.

## Notes

- **Attaching makes the remote the default catalog.** The client attaches it as `quack` and runs `USE quack`, so `db.exec('SELECT * FROM orders')` reads the **server's** table — and runs there. The client's own in-memory catalog stays reachable through `db.raw()` (`SELECT * FROM memory.orders`). A local-only instance (no `url`) keeps its own database as the default.
- **`readOnly` is refused.** Quack 2.0 accepts `READ_ONLY` on `ATTACH` and ignores it — writes still land — so the option throws `DUCKDB_QUACK_READ_ONLY_UNSUPPORTED` instead of pretending to protect. Enforce it on the server (`quack_authorization_function`, e.g. a `read_only` macro), which sees every query.
- **The client's own database is in memory** (`dbPath` opens a file instead). Build a report, aggregate, discard — what has to be shared between processes, or survive a restart, belongs on the server, whose tables live as long as the serving process (give it a reason to stay up, and rebuild at boot if it matters).
- **`ingest` is a background write**, and on an attached instance it targets the remote. `await db.ingest(...)` returns as soon as the rows are queued; `await db.flush()` waits for the write. A failure goes to `onError`, not to a rejected promise — the caller is gone by then.
- **One instance per object.** Use `raw()` for what this class does not wrap (the `Appender`, prepared statements, Arrow, extensions, UDFs) rather than opening a second instance.
- Local names are **quoted**, and values are **bound** on a local instance; on a remote they are **inlined as escaped literals** (Quack 2.0 cannot take parameters on an attached catalog) — a name, a token or a value never reaches the SQL unescaped.

## Testing

```bash
bun test packages/duckdb/tests
```

The suite runs against a **real Quack server** started with `quack_serve` on a free port, so the protocol itself is covered — not a mock. The first run downloads the `quack` extension (needs network, a few seconds); DuckDB caches it, and the suite is offline from the second run on.
