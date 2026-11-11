# Endpoint Inventory — Anteros (statique, partiel)

> Statut : **en cours** (lots A–E audités). Les familles `agents`, `mcp` et `socket.io` seront complétées au Lot G/J.
> « Auth requise » décrit le contrôle **effectivement vérifié dans le code**, pas une intention.

| Méthode | Path | Auth requise | Type d'auth | Permissions | Rate limit | Validation | Public/Privé | Données sensibles | Handler (fichier:ligne) | Middleware (fichier:ligne) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | `/health` | Non | — | — | Non | — | Public | metrics + IP | `server/hono.ts:423` | — (enregistré avant rate-limit) |
| POST | `/api/:tenant_id/collections/:collection/:action` | Oui (selon règle) | Bearer JWT (HS256) | `col.api.access[action\|*]` — **401 si absent** | Global 100/min (+ login 10/min) | Joi schéma, `allowUnknown:false`, `requireId`, `assertOperatorUpdate` | Privé (sauf règle `true`) | Documents collection (privateFields masqués) | `server/api.ts:490` | `server/access.ts:44` (evaluateAccess) |
| POST | `/api/:tenant_id/collections/:collection/login` | Non (public) | — (créé le token) | `col.api.auth.enabled` + `onLogin` | login 10/min | — | Public | renvoie `token` + `data` | `server/api.ts:558` | — |
| POST | `/api/:tenant_id/collections/:collection/logout` | Non | — | `onLogout` | Global | — | Public | — | `server/api.ts:538` | — |
| POST | `/api/:tenant_id/services/:service/:action` | Oui | Bearer JWT | `service.api.access[action\|*]` — **401 si absent** | Global | — (données = code service) | Privé | dépend du service | `server/api.ts:750` | `server/access.ts:44` |
| POST | `/api/:tenant_id/vars/:action` | Oui | Bearer JWT | `definition.api.access[action\|*]` — **401 si absent** | Global | ns déclaré via `define.Vars` | Privé | valeurs de variables (jamais auditées) | `server/api.ts:660` | `server/access.ts:44` |
| POST | `/api/:tenant_id/upload/:collection` | Oui | Bearer JWT | file collection `api.access` (à confirmer : `checkFileAccess`) | Global | MIME magic bytes, taille, `assertUploadMetadata` | Privé | fichier binaire + métadonnées | `server/api.ts:793` | `server/access.ts` |
| GET | `/api/:tenant_id/files/:collection/:file` | Oui | Bearer JWT | `col.api.access.read\|*` (checkFileAccess) | Global | `rawFile` anti-traversal | Privé (sauf règle `true` → cache public) | fichier binaire | `server/api.ts:881` | `server/api.ts:894` (checkFileAccess) |
| DELETE | `/api/:tenant_id/files/:collection/:file` | Oui | Bearer JWT | `col.api.access.delete\|*` (checkFileAccess) | Global | `fileId` anti-traversal | Privé | suppression fichier | `server/api.ts:943` | `server/api.ts:956` (checkFileAccess) |
| POST | `/api/:tenant_id/agents/:agent/:action` | À auditer (Lot G) | — | `agent.api.access` (Lot G) | Global | — | — | — | `server/agents.ts` | Lot G |
| GET/POST | `/api/:tenant_id/mcp` | À auditer (Lot G) | — | MCP access (Lot G) | Global | — | — | — | `server/mcp.ts` | Lot G |
| GET | `/_dnax/config/:tenant_id` | Oui | Bearer JWT (vérifié) | **tout token valide** (pas de rôle admin) | Global | tenant claim (si présent) | Privé | schéma collections/services (pas de secrets) | `server/api.ts:972` | `server/api.ts:975` + `server/hono.ts:526` |
| GET/POST/… | routes custom `cfg.routes` (préfixe tenant) | **Non** | — (auth manuelle attendue) | — | Global | — | Public par défaut | dépend du handler | `server/routes.ts:26` | — (B-01) |
| * | `/socket.io/` | À auditer (Lot J) | — | — | — | — | — | — | `server/io.ts` | Lot J |
| GET | `:metricsPort/health` (cluster master) | Non | — | — | Non | — | Public | métriques agrégées + pid | `server/boot.ts:276` | — (B-02) |

## Middlewares globaux (ordre, `server/hono.ts`)
1. IP client (`trustProxy`-aware) — L281
2. Access log (opt-in body) — L293
3. CORS — L366
4. compress — L374
5. ipRestriction — L377
6. CORP / secureHeaders — L388/L396
7. bodyLimit (16MB / upload 100MB) — L414
8. rateLimit global (100/min) + login (10/min) — L441/L449
9. asyncContextStorage + parsing/verification JWT — L458
10. rejet token invalide/expiré (sauf login/logout) — L514
11. tenant claim (`requireTenantClaim` défaut `false`) — L526
12. middlewares globaux utilisateur — L548
