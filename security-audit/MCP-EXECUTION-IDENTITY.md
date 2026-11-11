# MCP — Identité d'exécution (GAP 1)

## Modèle d'exécution des tools MCP

| Élément | Valeur | Preuve |
| --- | --- | --- |
| **DB Connection** | `tenant.database.db` — connexion du tenant (établie au boot via `tenant.database.uri`) | `database/tenant.ts:19-21`, `server/mcp.ts:95` |
| **MongoDB User** | **NOT_VERIFIED** — dépend de la chaîne de connexion (config, non lisible) | — |
| **Mongo Roles** | **NOT_VERIFIED** — dépend du serveur MongoDB (hors code applicatif) | — |
| **Tenant Scope** | `tenant_id` extrait de l'URL, `rest` lié à ce tenant | `server/mcp.ts:95` |
| **Internal** | `false` (externe) via `requestCtxStorage` du middleware HTTP ; le `rest` créé sans `internal:false` a un défaut `#internal=true`, mais l'audit lit `requestCtxStorage.get('internal')` (false) | `server/hono.ts:462`, `database/mongodbadapter.ts:272` |
| **Identité authentifiée** | **Aucune** (anonyme) — token vide `{ provided:false }` | `server/hono.ts:499` |
| **Additional Access** | Le code du tool s'exécute dans le processus serveur : accès à `process.env`, `cfg` (tous les tenants), filesystem, réseau (F-01) | `lib/agents.ts`, `server/config.ts:5` |

## Signification exacte de `internal`
`internal` est un **drapeau d'audit** (classification interne/externe), **pas** un contournement d'accès.
- `#internal` (MongoRest) : défaut `true`, surchargé par `options.internal`.
- À l'audit : `internal: requestCtxStorage.get('internal') ?? this.#internal` (`mongodbadapter.ts:272`).
- HTTP : `requestCtxStorage.set('internal', false)` (`hono.ts:462`). Scripts/workers : `true`.
- **Aucun** endroit du code ne saute un contrôle d'accès quand `internal === true` (l'accès est contrôlé au niveau des routes HTTP via `evaluateAccess`, pas dans `rest`).

## Conclusion
Un tool MCP s'exécute **sans identité authentifiée**, avec la **connexion DB du tenant** (portée = tenant de l'URL, identité MongoDB = config serveur non vérifiée), dans le **processus partagé** (accès aux secrets globaux — F-01). L'isolation repose entièrement sur le fait que l'URL `tenant_id` est correcte, sans contrôle d'identité.
