# @anteros/duckdb

A DuckDB instance over the **[Quack](https://duckdb.org/quack/)** protocol — the protocol that turns DuckDB into a client-server database.

- Two classes: **`DuckdbQuackInstance`** (the client) and **`DuckdbQuackServer`** (the server)
- Attaching a server makes it the **default catalog**: unqualified `events` is the server's table, and the client's own memory catalog stays reachable as `memory.<table>`
- **Data tables**: `db.table("tickets")` → `data` (JSON) + `ts` (TIMESTAMP), `ts` mapping a document field
- `exec`, `createTable`, `deleteTable`, `listTables`, `ingest` + `flush`, `raw()`, `close()` — and nothing else to configure

> ⚠️ **Quack is experimental.** DuckDB documents the protocol, the function names and the implementation details as subject to change, with a stable status expected in DuckDB 2.0. Pin your `@duckdb/node-api` version, and prefer this package over hand-rolling the attach so the SQL lives in one place.

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
| `token`    | `string`                                | `DUCKDB_QUACK_TOKEN` | The shared secret, sent as `CREATE SECRET (TYPE quack, TOKEN '…')`.            |
| `as`       | `string`                                | `'quack'`          | The catalog name the remote is attached under — and then made the **default catalog** (`USE`). |
| `readOnly` | `boolean`                               | `false`            | Attach the remote read-only — constrains the **client** connection; `exec` runs on the server. |
| `disableSsl` | `boolean`                             | negotiated         | Force plain HTTP — Quack expects TLS off a **non-local** URI by default (`DISABLE_SSL`). |
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
| `exec(sql, values?)`                        | Runs one statement, returns `{ columns, types, rows, duration_ms }`. On an attached instance it runs **on the Quack server**; bound `values` are the one client path (the server takes SQL text). |
| `createTable(table, columns?)`              | `CREATE TABLE IF NOT EXISTS` — on the attached remote when there is one.         |
| `deleteTable(table)`                        | `DROP TABLE IF EXISTS` — on the attached remote when there is one.               |
| `listTables()`                              | The tables of the attached remote, or of the local catalog when not attached.     |
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

On an attached instance, `exec` **always** runs the statement on the **Quack server** (`quack_query`): the
remote computes, and only the result crosses the wire — what a large aggregate needs, since the client path
would fetch every `data`.

```ts
await db.exec("SELECT SUM(CAST(data.prix AS INT)) AS total FROM tickets"); // on the server
await db.exec("SELECT * FROM tickets WHERE id = $1", ["a-1"]);             // client (bound values)
```

One exception: a statement with bound `values` runs in the **client's** engine (the server only receives SQL
text, it cannot take parameters). The client's own catalog and the remote alias are then reachable through
`db.raw()` — an escape hatch, not the normal path. On a local instance (no `url`), everything runs in the
client: there is no server.

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
  disableSsl: false,                 // true to serve plain HTTP
  fetchBatchChunks: 12,              // quack_fetch_batch_chunks
  options: { threads: "4" },
});

await server.start();                            // CALL quack_serve(…), idempotent

// The server owns the data, and builds it with the very same methods:
await server.db.createTable("orders");
await server.db.ingest({ table: "orders", rows: [{ data: { ref: "A-1" } }] });
await server.db.flush();

console.log(server.url);                         // quack:127.0.0.1:9494 — what clients attach
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
| `quack_fetch_batch_chunks` | Server-side `DataChunk` batching (default `12`) — `fetchBatchChunks` in the options |
| `quack_active_connections()` / `quack_server_list()` | Who is attached, what is being served |
| `quack_query(uri, sql, token := …)` | One-shot remote query, without attaching |
| `enable_logging('Quack' \| 'HTTP')` + `duckdb_logs_parsed(...)` | Per-message logs (`quack_connection_id`, `client_query_id`, `duration_ms`) and the HTTP transport |

## Notes

| Member        | What it is                                                                        |
| ------------- | --------------------------------------------------------------------------------- |
| `start()`     | Opens the instance and serves. Idempotent.                                         |
| `stop()`      | `quack_stop`, then closes the instance. Idempotent.                                 |
| `db`          | The local `DuckdbQuackInstance` being served — the tables the clients see.         |
| `url`         | `'quack:host:port'`, exactly what a client hands to `DuckdbQuackInstance`.         |
| `token`       | The secret clients must present.                                                   |
| `host` / `port` | What it binds (defaults `'127.0.0.1'` / `9494`).                                 |
| `isRunning`   | Whether it is accepting connections.                                               |

> ⚠️ An empty token is refused at construction, and `host` defaults to **localhost**: exposing a Quack server to a network is a deliberate act (`host: '0.0.0.0'`), and the token is then the only thing in the way.

## Notes

- **Attaching makes the remote the default catalog.** The client attaches it as `quack` and runs `USE quack`, so `db.exec('SELECT * FROM orders')` reads the **server's** table — and runs there. The client's own in-memory catalog stays reachable through `db.raw()` (`SELECT * FROM memory.orders`). A local-only instance (no `url`) keeps its own database as the default.
- **`readOnly` constrains the attach, not `exec`.** Statements run on the server, so `readOnly: true` does not stop a write made through `exec` — it stops writes on the client connection (the mode SQL using the remote alias runs there).
- **The client's own database is in memory** (`dbPath` opens a file instead). Build a report, aggregate, discard — what has to be shared between processes, or survive a restart, belongs on the server, whose tables live as long as the serving process (give it a reason to stay up, and rebuild at boot if it matters).
- **`ingest` is a background write**, and on an attached instance it targets the remote. `await db.ingest(...)` returns as soon as the rows are queued; `await db.flush()` waits for the write. A failure goes to `onError`, not to a rejected promise — the caller is gone by then.
- **One instance per object.** Use `raw()` for what this class does not wrap (the `Appender`, prepared statements, Arrow, extensions, UDFs) rather than opening a second instance.
- Local names are **quoted** and values **bound**: a name or a token never reaches the SQL as raw text.

## Testing

```bash
bun test packages/duckdb/tests
```

The suite runs against a **real Quack server** started with `quack_serve` on a free port, so the protocol itself is covered — not a mock. The first run downloads the `quack` extension (needs network, a few seconds); DuckDB caches it, and the suite is offline from the second run on.
