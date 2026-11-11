# Unaudited Areas — Zones non auditées / restant à examiner

> Audit statique en cours. Cette liste suit les fichiers/lots restants.

## Lots restants (prévus)
- **Lot G** — Agents & MCP : `server/agents.ts`, `server/mcp.ts`, `lib/agents.ts`, `lib/agent.ts` (2195 l.), `lib/agentMemory.ts`, `lib/mcp.ts`, `lib/mcpClient.ts`, `lib/providers.ts`, `lib/ai.ts`, `lib/eval.ts`, `lib/partialJson.ts`, `lib/messages.ts`.
- **Lot H** — Infrastructure : `server/cluster.ts`, `server/io.ts`, `server/metrics.ts`, `lib/sockets.ts`.
- **Lot I** — Logging/audit (détail) : `utils/logger.ts`, `utils/func.ts` (reste), `lib/auditDriver.ts`, `lib/auditQuack.ts`, `lib/auditResult.ts`, `lib/tracing.ts`, `lib/error.ts`.
- **Lot J** — Réplication/cache : `database/replication.ts` (1222 l.), `database/db.cache.ts`, `database/ttl.ts`, `database/decorator.ts`, `utils/cache.ts`.
- **Lot K** — Packages annexes : `gateway/`, `cli/`, `sdk/`, `duckdb/`, `reco/`, `docd/`.

## Fichiers non lus (partiel, core)
- `server/agents.ts`, `server/mcp.ts`, `server/cluster.ts`, `server/io.ts`, `server/metrics.ts`
- `lib/agents.ts`, `lib/agent.ts`, `lib/agentMemory.ts`, `lib/ai.ts`, `lib/eval.ts`, `lib/mcp.ts`, `lib/mcpClient.ts`, `lib/providers.ts`, `lib/partialJson.ts`, `lib/messages.ts`, `lib/skills.ts`, `lib/tracing.ts`, `lib/error.ts`, `lib/auditDriver.ts`, `lib/auditQuack.ts`, `lib/auditResult.ts`, `lib/load.ts` (lu), `lib/lifecycle.ts`, `lib/jsonSchema.ts`
- `database/replication.ts`, `database/db.cache.ts`, `database/ttl.ts`, `database/decorator.ts`
- `utils/func.ts` (partiel : query-builder lu ; le reste ~1300 l. non lu), `utils/logger.ts`, `utils/cache.ts`, `utils/index.ts`

## Fichiers sensibles détectés (non lus — protection des secrets)
- `.env`, `.env.*` (ignorés par `.gitignore`) — non lus.
- Aucun `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `secrets/`, `credentials/`, `.aws/`, `.ssh/` détecté dans le workspace.

## Limitations
- **Aucun test dynamique** : comportement réseau, Hono/Bun (injection d'en-tête D-01), timing, limites effectives → non vérifiés.
- **`npm audit`/`osv-scanner`/`gitleaks`/`semgrep`** : non exécutés (à faire en Lot dépendances).
- Dépendances transitives : non analysées (lockfile `bun.lock` ignoré par `.gitignore`).
