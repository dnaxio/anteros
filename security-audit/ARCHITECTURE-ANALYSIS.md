# Architecture Analysis

## Stack
Bun (≥1.3) · TypeScript (ESM, strict) · Hono 4 · MongoDB 7 (driver, une DB par tenant) · jose (HS256) · zod/joi · Socket.IO 4 · bentocache/ioredis · @modelcontextprotocol/sdk · @duckdb/node-api (RC) · onnxruntime/sharp (reco).

## Monorepo
`packages/core` (framework), `cli`, `sdk`, `duckdb`, `reco`, `gateway`, `docd` (docs Nuxt).

## Modèle de confiance
- **Code exécutable** : chargé depuis le filesystem au boot (`import()` de `{tenant.dir}/collections|services|scripts|workflows|routes|middlewares|sockets|ai/agents|ai/mcp`). Déclaré/modifié **uniquement par l'opérateur** — aucun upload/plugin runtime (pas de marketplace).
- **Multi-tenance** : isolation **au niveau données** (DB par tenant + claim JWT), **pas au niveau code** (process partagé, `cfg` global, `JWT_SECRET` HS256 commun) → F-01.

## Flux d'une requête HTTP (ordre des middlewares, `server/hono.ts`)
IP client (trustProxy) → access log (opt-in body) → CORS → compress → ipRestriction → CORP/secureHeaders → bodyLimit (16MB/100MB) → /health → rateLimit global+login → asyncContextStorage + parsing/verif JWT → rejet token invalide/expiré → tenant claim → middlewares globaux → routes custom → collections/services/vars/upload/files/agents/mcp/config.

## Surfaces d'accès (authN/authZ)
| Surface | AuthN | AuthZ |
| --- | --- | --- |
| Collections | Bearer JWT | `api.access` (no rule = denied) |
| Services / Vars / Agents | Bearer JWT | `api.access` |
| Files (upload/serve/delete) | Bearer JWT | file collection `api.access` |
| MCP | Bearer JWT (corrigé) | `api.access` par tool (corrigé) |
| Socket.IO | token + tenant (corrigé) | `api.access` par handler (corrigé) |
| Routes custom | — (auth manuelle documentée) | — |
| `/health` | non | — |

## Défense NoSQL (MongoDB)
`buildPipeline`/`assertSafeFilter`/`isSafeAggregatePipeline` (`utils/func.ts`) : bloque `$where`/`$function`/`$accumulator`/`$expr`(find)/`$out`/`$merge`/`$unionWith`, restreint `$lookup`/`$graphLookup` aux collections du tenant, borne `$regex` (1000) et `$in`/`$nin` (10000), interdit le renommage `$project`, allow-list des opérateurs d'update (sans `$rename`), `requireId` (anti `$ne`).

## Points faibles structurels
- F-01 : isolation code inter-tenant absente.
- `requireTenantClaim` défaut `false` (AUTH-01) : token sans claim accepté cross-tenant.
- `readOnlyFields` contournable par notation pointée (C-01).
- Logger général sans redaction (LOG-REDACT).
