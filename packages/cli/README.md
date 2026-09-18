# @anteros/cli

`@anteros/cli` ships the Anteros toolchain:

- **`anteros`** — framework CLI: scaffold a project, run it locally, diagnose the environment
- **`ros`** — deployment / CI-CD CLI: multi-server deploys over SSH, monitoring, proxy management

`ros` is exposed through the same binary as `anteros ros <command>`, and as its own `ros`
binary (`bun run bin/ros/index.ts` in this repository).

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
| `anteros ros`    | Forward every argument to the deployment CLI                    |

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

## Deployment — `ros`

### Initialize a project

```bash
anteros ros init
```

This creates a `deploy.yaml` in your project, the configuration file used to manage your
CI/CD deployments. See [`base.deploy.yaml`](./base.deploy.yaml) for a full annotated example.

### Commands

| Command                   | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `anteros ros init`        | Create a `deploy.yaml` in the current project          |
| `anteros ros deploy`      | Deploy all pods to the target environment              |
| `anteros ros status`      | Show the status of all deployed pods                   |
| `anteros ros setup`       | Install required dependencies on remote servers        |
| `anteros ros logs`        | Tail logs from a pod                                   |
| `anteros ros rollback`    | Roll back to the previous version                      |
| `anteros ros config`      | Validate / inspect the `deploy.yaml` configuration     |
| `anteros ros destroy`     | Remove a pod and its resources                         |
| `anteros ros exec`        | Run a command on a remote server / inside a container  |
| `anteros ros env`         | Show the resolved environment variables                |
| `anteros ros history`     | Show the deployment history                            |
| `anteros ros proxy`       | Manage the Caddy reverse proxy (Admin API)             |
| `anteros ros alerts`      | Install / manage the alerts cron on remote servers     |
| `anteros ros metrics`     | Install / manage the metrics scraper on remote servers |

### Global options

```bash
anteros ros <cmd> [options]

  -e, --env <name>        Target environment (test, staging, production)
  -s, --server <target>   Target server(s) — root@ip, logical name, or tag
  -c, --config <path>     Path to deploy.yaml (default: ./deploy.yaml)
  -f, --force             Force the action, bypassing safety checks:
                             • skip drift detection on remote servers
                             • skip the interactive confirmation prompt
                             • allow downgrading a service to an older version
                             • allow re-running setup on an already-initialized server
      --dry-run           Show the plan without applying it
      --no-color          Disable colored output
  -v, --verbose           Verbose mode
  -h, --help              Help
      --version           Show the CLI version
```

### Common workflows

```bash
# Deploy
anteros ros deploy
anteros ros deploy --env production
anteros ros deploy --service api --tag v1.0.3
anteros ros deploy --force                    # bypass safety checks (drift, confirmation)

# Status
anteros ros status
anteros ros status api --env production
anteros ros status --watch

# Setup (install server dependencies)
anteros ros setup
anteros ros setup root@192.168.30.11

# Logs & rollback
anteros ros logs api --env production --tail 200
anteros ros rollback api --to v1.0.1

# Config
anteros ros config validate
anteros ros config show --env production
```

`ros setup` installs the following dependencies on the target server(s):
`docker`, `caddy-server`, `flox.dev`, `git`, `unzip`.

## Configuration overview

`base.deploy.yaml` is organized in three top-level blocks:

- **`environments`** — list of SSH targets per environment (`test`, `staging`, `production`, …)
- **`pods`** — apps to deploy, with a `type` (`web`, `api`, `database`, …), a `driver` (`docker`
  or `flox`), and a list of `containers`
- **`proxy`** — Caddy reverse-proxy routes that map public domains to internal service ports

See [`base.deploy.yaml`](./base.deploy.yaml) for the full schema with examples.
