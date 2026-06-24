# @anteros/cli

`@anteros/cli` exposes two binaries:

- **`ant`** — framework CLI (scaffolding, dev, build, generate, test, lint)
- **`ros`** — deployment / CI-CD CLI (init, deploy, status, setup, logs, rollback, config)

`ros` is a toolkit for deploying applications or pods across multiple servers via SSH.

## Install

```bash
bun i @anteros/cli@latest -g
```

## Framework — `ant`

```bash
ant init         # scaffold a new Anteros project
ant dev          # run the local dev server
ant build        # produce a production build
ant generate     # generate code (routes, services, models, …)
ant test         # run the test suite
ant lint         # run linters / formatters
ant doctor       # diagnose the local environment
```

## Deployment — `ros`

### Initialize a project

```bash
ros init
```

This will create a `base.deploy.yaml` file in your project, which is the configuration file used by `@anteros/cli` to manage your CI/CD deployments.

See [`base.deploy.yaml`](./base.deploy.yaml) for a full annotated example.

### Commands

| Command         | Description                                            |
|-----------------|--------------------------------------------------------|
| `ros init`      | Create a `deploy.yaml` in the current project          |
| `ros deploy`    | Deploy all pods to the target environment              |
| `ros status`    | Show the status of all deployed pods                   |
| `ros setup`     | Install required dependencies on remote servers       |
| `ros logs`      | Tail logs from a pod                                  |
| `ros rollback`  | Roll back to the previous version                     |
| `ros config`    | Validate / inspect the `deploy.yaml` configuration     |
| `ros destroy`   | Remove a pod and its resources                        |
| `ros exec`      | Run a command on a remote server / inside a container  |
| `ros env`       | Show the resolved environment variables               |

### Global options

```bash
ros <cmd> [options]

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
      --version           Show ros version
```

### Common workflows

```bash
# Deploy
ros deploy
ros deploy --env production
ros deploy --service api --tag v1.0.3
ros deploy --force                    # bypass safety checks (drift, confirmation)

# Status
ros status
ros status api --env production
ros status --watch

# Setup (install server dependencies)
ros setup
ros setup root@192.168.30.11
ros setup root@192.168.30.11 root@192.168.30.12

# Logs & rollback
ros logs api --env production --tail 200
ros rollback api --to v1.0.1

# Config
ros config validate
ros config show --env production
```

`ros setup` installs the following dependencies on the target server(s):

- `docker`
- `caddy-server`
- `flox.dev`
- `git`
- `unzip`

## Configuration overview

`base.deploy.yaml` is organized in three top-level blocks:

- **`environments`** — list of SSH targets per environment (`test`, `staging`, `production`, …)
- **`pods`** — apps to deploy, with a `type` (`web`, `api`, `database`, …), a `driver` (`docker` or `flox`), and a list of `containers`
- **`proxy`** — Caddy reverse-proxy routes that map public domains to internal service ports

See [`base.deploy.yaml`](./base.deploy.yaml) for the full schema with examples.
