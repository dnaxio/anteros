# MCP Remediation Matrix

| Finding | Contrôle manquant | Correctif proposé | Fichier:ligne cible | Test associé |
| --- | --- | --- | --- | --- |
| G-MCP-EXPOSE (authN) | Aucune authentification | Rejet anonyme/invalide/expiré via `c.get('token')` | `server/mcp.ts:195` (handler) | #1, #2, #3 |
| G-MCP-EXPOSE (tenant) | Tenant = URL uniquement | Vérifier claim `tenant` vs `tenant_id` URL + `requireTenantClaim` | `server/mcp.ts:195` | #4, #5 |
| G-MCP-EXPOSE (authZ tool) | Aucun `api.access` | `evaluateAccess(tool.api?.access, 'call', …)` avant `tool.exec` | `server/mcp.ts:77-103` | #6, #8 |
| G-MCP-EXPOSE (authZ resource) | Aucun `api.access` | `evaluateAccess(resource.api?.access, 'read', …)` avant `resource.read` | `server/mcp.ts:146-171` | #10 |
| G-MCP-ENUM | Écho de `tenant_id` + 404 différenciant | Réponse générique `Not found` (404) | `server/mcp.ts:199-201` | ENUM |
| G-MCP-AUDIT | Pas d'écriture `_audit_` | `rest.audit.log({ action: 'mcp.tools/call', … })` (args en empreinte) | `server/mcp.ts:77-116` | AUDIT |
| Rate limiting | Global seulement | Limite par tenant authentifié (clé `mcp:<tenant>`) | `server/hono.ts` ou `server/mcp.ts` | #12 |

## Modèle `api.access` (résultant)
- `tools/list` / `resources/list` : **authentifié seulement** (métadonnée).
- `tools/call` : `tool.api.access.call` (ou `*`), sinon **401**.
- `resources/read` : `resource.api.access.read` (ou `*`), sinon **401**.
- Pas d'héritage depuis les agents : un `McpTool` est autonome (même si un agent peut l'utiliser, l'accès direct MCP est régi par le `api.access` du tool).

## Impact sur les déploiements existants
- **Rupture de comportement** : tout tool/resource MCP existant sans `api.access` devient **refusé** (secure-by-default). Migration requise : déclarer `api.access` explicitement.
- Les clients MCP doivent désormais fournir un `Authorization: Bearer <jwt>`.
