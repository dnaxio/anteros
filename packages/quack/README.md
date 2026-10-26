# @anteros/quack

The **standalone CLI** for a DuckDB instance served over the **[Quack](https://duckdb.org/quack/)**
protocol, from the terminal.

- One binary, **`antq`**, and one command: `start`
- Sensible defaults: in-memory database, `127.0.0.1:9494`, plain HTTP on localhost (TLS elsewhere), token
  required (≥ 4 characters)
- **Standalone**: it drives DuckDB through `@duckdb/node-api` directly — it does **not** depend on
  `@anteros/duckdb`. The client library (`DuckdbQuackInstance`) lives there for programmatic use

> ⚠️ **Quack is experimental through DuckDB 1.x.** DuckDB documents the protocol, the function names and the
> implementation details as subject to change up to the stable 2.0 line. This package is pinned to
> `@duckdb/node-api` **2.0.0-r.1** (DuckDB 2.0.0): pin it too, and go through this package rather than
> hand-rolling the attach, so the SQL lives in one place.

## Install

```bash
bun add @anteros/quack      # the `antq` binary, plus @duckdb/node-api
```

Without installing, the package's single `bin` also runs through `bunx`:

```bash
bunx @anteros/quack start --token super-secret
```

## Start a server

```bash
antq start --token super-secret

antq start --dbPath ./data/analytics.duckdb --port 9494 --token super-secret

antq start --host 0.0.0.0 --allowOtherHostname --token super-secret

antq start --dbPath ./data/docs.duckdb \
  --fts documents:document_identifier:text_content,author \
  --fts docs:id:body \
  --fts redactions:redaction_id:text \
  --token super-secret

antq start --dbPath ./data/docs.duckdb --fts documents:document_identifier:text_content,author --ftsStemmer french --token super-secret
```

The banner says where you are, then the process keeps serving until `Ctrl-C`:

```
  @anteros/quack — serving
    mode     quack
    url      quack:127.0.0.1:9494
    db       in memory (nothing is persisted)
    token    ******** (12 characters)
```

`Ctrl-C` runs `quack_stop` and then closes the instance — that is what releases a `--dbPath` file lock.

## Options

| Option                                              | Default     | Description                                                                                                                    |
| --------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--quack`                                           | on          | The serving mode — today the only one, so the flag is optional. `--quack=false` is refused rather than serving something else. |
| `--dbPath <path>`                                   | memory      | DuckDB file to serve — nothing is persisted without it                                                                         |
| `--port <n>`                                        | `9494`      | Port to listen on                                                                                                              |
| `--host <addr>`                                     | `127.0.0.1` | Interface to bind                                                                                                              |
| `--token <secret>`                                  | —           | Required (`QUACK_TOKEN` / `DUCKDB_QUACK_TOKEN` also work). At least 4 characters.                                              |
| `--allowOtherHostname`                              | `false`     | Accept a non-localhost `Host` header — required for a remote client                                                            |
| `--disableSsl`                                      | Quack's default | `--disableSsl` serves plain HTTP; `--disableSsl=false` forces TLS (even on localhost); omitted keeps Quack's default (plain locally, TLS otherwise) |
| `--threads <n>`                                     | —           | DuckDB threads of the server instance                                                                                          |
| `--targetBatchBytes <n>`                            | 32 MiB      | Target size of one wire batch (`quack_target_batch_bytes`)                                                                     |
| `--fts <table:id:fields>`                            | —           | Build a full-text index at startup (`table:id:field1,field2`); repeatable, rebuilt on each start                               |
| `--ftsConfig <path>`                                 | —           | JSON file: array of indexes `{ table, id, fields, … }` — several tables, each with its own options                              |
| `--ftsStemmer <name>`                                | `porter`    | Default stemmer for `--fts` / `--ftsConfig` indexes (`french`, `english`, `none`…)                                            |
| `--ftsIncremental`                                   | `false`     | Keep every `--fts` index current with triggers (`id` must be `NOT NULL` / `PRIMARY KEY`)                                      |
| `--vss <table:column[:metric]>`                      | —           | Build an HNSW vector index (`table:column[:l2sq\|cosine\|ip]`); repeatable                                                      |
| `--vssConfig <path>`                                 | —           | JSON file: array of vector indexes `{ table, column, metric, … }`                                                              |
| `--vssMetric <metric>`                               | `l2sq`      | Default metric for `--vss` / `--vssConfig` (`l2sq`, `cosine`, `ip`)                                                           |
| `--vssPersist`                                       | `false`     | Enable experimental HNSW persistence — required for a **file** database                                                       |
| `--sslCertFile <path>` / `--sslKeyFile <path>`      | generated   | TLS certificate and key; they go together, and are refused with `--disableSsl`                                                 |
| `--name` / `--region` / `--provider` / `--hostname` | —           | Identity advertised by `whoami()`                                                                                              |
| `--printToken`                                      | `false`     | Show the token in the banner (masked by default)                                                                               |

Option names are forgiving: `--dbPath`, `--db-path` and `--DBPATH` are the same. The banner shows the URI
`quack_serve` **actually bound** (`listen_uri`), where the data goes and the **masked** token; `Ctrl-C` stops
the server (`quack_stop`, then the instance closes, so a file is released). A TLS pair is refused when only
one of `--sslCertFile` / `--sslKeyFile` is given, or when `--disableSsl` is combined with a certificate.

Both forms build the indexes **before** the port opens, so a client can search as soon as it attaches.
`--fts` is repeatable for quick one-offs:

```bash
antq start --dbPath ./data/docs.duckdb \
  --fts documents:document_identifier:text_content,author \
  --fts docs:id:body \
  --fts redactions:redaction_id:text \
  --token super-secret
```

For several tables with **per-index options**, use `--ftsConfig` — a JSON array, the same shape as
`DuckdbQuackServer({ ftsIndexes })`:

```json
[
  { "table": "documents", "id": "document_identifier", "fields": ["text_content", "author"], "stemmer": "french" },
  { "table": "docs", "id": "id", "fields": "body" },
  { "table": "redactions", "id": "redaction_id", "fields": ["text"], "incremental": true }
]
```

```bash
antq start --dbPath ./data/docs.duckdb --ftsConfig ./fts.json --token super-secret
```

`--ftsStemmer` / `--ftsIncremental` fill what an entry does not specify; a per-entry value wins. Everything is
rebuilt at each start unless the entry sets `"overwrite": false` (keep the existing index). With `--fts`
alone, use `DuckdbQuackServer({ ftsIndexes })` or `db.createFtsIndex(...)` for `stopwords` / `ignore`.

Vector indexes use `--vss` (repeatable, `table:column[:metric]`) or `--vssConfig`, with the same per-index
rules. `--vssMetric` fills the metric; `--vssPersist` is required for a **file** database (DuckDB's HNSW
persistence is experimental):

```json
[
  { "table": "documents", "column": "embedding", "metric": "cosine" },
  { "table": "images", "column": "vec", "metric": "l2sq", "efSearch": 128 }
]
```

```bash
antq start --dbPath ./data/vecs.duckdb --vss embeddings:vec:cosine --vssPersist --token super-secret
antq start --dbPath ./data/vecs.duckdb --vssConfig ./vss.json --vssPersist --token super-secret
```

`vss` is not autoloaded: `antq` runs `LOAD vss` (installing it on first use) before building the indexes. An
in-memory database does not need `--vssPersist`.

## Where the data lives

Quack has **no storage option of its own**: the server *is* a DuckDB database, and whatever is in it is what
clients see over the protocol. So the answer is one line of configuration:

| `--dbPath` | Where the data lives | Survives a restart                                                                         |
| ---------- | -------------------- | ------------------------------------------------------------------------------------------ |
| omitted    | in memory            | no — the tables serve every attached client for the lifetime of the process, then die with it |
| set        | a DuckDB file        | yes — the file *is* the database; copy it to back it up, and `Ctrl-C` releases the lock     |

A Quack server is a **single** process owning its database, so the cross-process lock that rules a file out
for per-worker instances cannot happen — that is exactly the architecture Quack exists to allow: one writer,
N readers.

> The token is at least **4 characters** (Quack's rule, checked before serving), and a non-loopback `host` is
> **not enough** to accept a remote client: Quack checks the `Host` header and refuses anything but
> localhost unless `--allowOtherHostname` is set. A server meant to be reached sets both — and then the token
> (and TLS) is all that stands between the network and the data.

## Attach a client

```ts
import { DuckdbQuackInstance } from "@anteros/duckdb";

const db = new DuckdbQuackInstance({ url: "quack:127.0.0.1:9494", token: process.env.QUACK_TOKEN });
const { rows } = await db.exec("SELECT * FROM quack.orders LIMIT 5"); // the remote catalog
await db.close();
```

An unqualified table name is the **server's**: attaching runs `USE quack`, so the remote is the default
catalog; the client's own in-memory catalog stays reachable as `memory.<table>`. The server side is the
`@anteros/duckdb` README's subject — classes, options, `raw()`, `ingest`/`flush`.

## Search it

`--fts` builds the index before the server starts; a client only searches:

```ts
const { rows } = await db.searchFts("documents", "small cats", {
  id: "document_identifier", // the column, not its name as a string
  limit: 10,
});
// [{ document_identifier, text_content, author, score }]
```

`fields`, `where`, `select`, `conjunctive`, `k` and `b` are on `searchFts`; the index itself is created with
`db.createFtsIndex(...)` or the `ftsIndexes` server option — see the
[DuckDB package page](../duckdb#full-text-search).

`--vss` does the same for vectors:

```ts
const { rows } = await db.searchVss("embeddings", [1, 0, 0], {
  column: "vec",
  metric: "cosine", // must match the index to accelerate
  limit: 5,
});
// [{ id, label, vec, distance }]
```

The index is created with `db.createVssIndex(...)` or the `vssIndexes` server option — see
[Vector similarity search](../duckdb#vector-similarity-search).

## Testing

```bash
bun test packages/quack/tests
```

The suite spawns the CLI as a real process: it must actually serve, stay alive, and persist to `--dbPath`
across a restart. Quack's extension is downloaded on first use (needs network, a few seconds), then cached.
