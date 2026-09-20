# @anteros/cli

`@anteros/cli` ships the Anteros toolchain:

- **`anteros`** — framework CLI: scaffold a project, run it locally, diagnose the environment

## Install

```bash
bun i @anteros/cli@latest -g
```

Without a global install, everything also runs through `bunx`:

```bash
bunx @anteros/cli create server my-api
```

## Framework — `anteros`

| Command          | Description                                                     |
| ---------------- | --------------------------------------------------------------- |
| `anteros create` | Scaffold a new Anteros project                                  |
| `anteros dev`    | Run the local dev server (`bun --watch index.ts`)               |
| `anteros doctor` | Diagnose Bun, the project files, MongoDB and the HTTP port       |

Run `anteros <command> --help` for the options of a single command.

### Create a project

```bash
anteros create server my-api         # or: bunx @anteros/cli create server my-api
anteros create my-api                # default template
anteros create server my-api \
  --tenant acme \
  --port 3001 \
  --mongo mongodb://localhost:27017/acme \
  --no-install
```

| Option                      | Description                                            |
| --------------------------- | ------------------------------------------------------ |
| `-d, --dir <path>`          | Target directory (default: `./<name>`)                 |
| `-t, --tenant <id>`         | Tenant id and folder (default: `v1`)                   |
| `-p, --port <port>`         | HTTP port (default: `4000`)                            |
| `--mongo <uri>`             | MongoDB connection string                              |
| `--pm <pm>`                 | `bun` \| `npm` \| `pnpm` \| `yarn` (default: `bun`)    |
| `--install`, `--no-install` | Install dependencies (default: ask)                    |
| `--git`, `--no-git`         | Initialize a git repository (default: ask)             |
| `-f, --force`               | Write into a non-empty directory                       |
| `-y, --yes`                 | Accept the default answer to every prompt              |

Templates live in [`templates/`](./templates) — one directory per template with a
`template.json` manifest. Conventions used inside a template:

- a leading `_` on a file name means a leading dot on output (`_gitignore` → `.gitignore`)
- `{{placeholders}}` are substituted when scaffolding (`name`, `packageName`, `tenant`,
  `port`, `databaseUri`, `coreVersion`)
- the folder named after the manifest `tenant` (`v1`) is renamed to the requested tenant

The `server` template generates a runnable project:

```
my-api/
├── config/app.ts     # define.Server({ server, tenants })
├── index.ts          # app.boot(config)
├── v1/               # tenant root (`tenant.dir`)
│   ├── collections/  # *.model.ts
│   ├── mcp/tools/    # *.tool.ts
│   └── routes/       # *.route.ts
├── .env.example
└── package.json
```

### Dev server & diagnostics

```bash
anteros dev                    # bun --watch index.ts
anteros dev --entry src/main.ts --no-watch
anteros doctor                 # exits 1 when an error is found
```
