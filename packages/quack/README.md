# @anteros/quack

The **standalone CLI** for a DuckDB instance served over the **[Quack](https://duckdb.org/quack/)**
protocol, from the terminal.

- One binary, **`antq`**, and one command: `start`
- Sensible defaults: in-memory database, `127.0.0.1:9494`, TLS on, token required (≥ 4 characters)
- **Standalone**: it drives DuckDB through `@duckdb/node-api` directly — it does **not** depend on
  `@anteros/duckdb`. The client library (`DuckdbQuackInstance`) lives there for programmatic use

> ⚠️ **Quack is experimental.** DuckDB documents the protocol, the function names and the implementation
> details as subject to change, with a stable status expected in DuckDB 2.0. Pin your `@duckdb/node-api`
> version, and go through this package rather than hand-rolling the attach, so the SQL lives in one place.

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
| `--disableSsl`                                      | `false`     | Serve plain HTTP instead of TLS                                                                                                |
| `--threads <n>`                                     | —           | DuckDB threads of the server instance                                                                                          |
| `--fetchBatchChunks <n>`                            | `12`        | `DataChunk`s per `FETCH` response                                                                                              |
| `--name` / `--region` / `--provider` / `--hostname` | —           | Identity advertised by `whoami()`                                                                                              |
| `--printToken`                                      | `false`     | Show the token in the banner (masked by default)                                                                               |

Option names are forgiving: `--dbPath`, `--db-path` and `--DBPATH` are the same. The banner shows the URL,
where the data goes and the **masked** token; `Ctrl-C` stops the server (`quack_stop`, then the instance
closes, so a file is released).

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

An unqualified table name is the **client's local** database; the remote is reached through the alias
(`quack.<table>`). The server side is the `@anteros/duckdb` README's subject — classes, options, `raw()`,
`ingest`/`flush`.

## Testing

```bash
bun test packages/quack/tests
```

The suite spawns the CLI as a real process: it must actually serve, stay alive, and persist to `--dbPath`
across a restart. Quack's extension is downloaded on first use (needs network, a few seconds), then cached.
