# Permission Matrix — Modèle d'accès Anteros

> Le framework n'a **pas de liste de rôles fixe**. L'autorisation est **déclarative** via `api.access` (par surface, par action) : `{ [action]: boolean | (ctx) => boolean }`, avec `'*'` en wildcard. **Aucune règle = refus** (secure-by-default, `server/access.ts`).

## Surfaces et contrôle effectif

| Surface | Action(s) | Champ du contrôle | Tenant | Contrôle réel (fichier:ligne) | Effectif ? |
| --- | --- | --- | --- | --- | --- |
| Collection | find/findOne/aggregate/insert*/update*/delete*/custom | `col.api.access[action\|*]` | URL → `rest` tenant | `server/api.ts:600` (`evaluateAccess`) | ✅ |
| Service | action | `service.api.access[action\|*]` | URL → `rest` tenant | `server/api.ts:780` | ✅ |
| Vars | set/get/del/incr/… | `definition.api.access[action\|*]` | URL → `rest` tenant | `server/api.ts:695` | ✅ |
| Agent | generate/stream/object/info/… | `agent.api.access[action\|*]` | URL → `rest` tenant | `server/agents.ts:419` | ✅ |
| MCP tool | call | `tool.api.access[call\|*]` | token claim | `server/mcp.ts` (corrigé) | ✅ |
| MCP resource | read | `resource.api.access[read\|*]` | token claim | `server/mcp.ts` (corrigé) | ✅ |
| Socket | connect | `handler.api.access[connect\|*]` | token claim | `lib/sockets.ts` (corrigé) | ✅ |
| File serve | read | `fileCol.api.access[read\|*]` | URL → `rest` tenant | `server/api.ts:894` (`checkFileAccess`) | ✅ |
| File delete | delete | `fileCol.api.access[delete\|*]` | URL → `rest` tenant | `server/api.ts:956` | ✅ |
| File upload | (create) | file collection `api.access` | URL → `rest` tenant | `server/api.ts:793` | ⚠️ (à confirmer) |
| Custom route | — | **aucun** (auth manuelle documentée) | — | `server/routes.ts:26` | ❌ (B-01) |
| `_dnax/config` | read | **tout token valide** (pas de rôle) | claim (si présent) | `server/api.ts:975` | ⚠️ (E-01) |
| `/health` | read | **aucun** (public) | — | `server/hono.ts:423` | ❌ (AUTH-06, intentionnel) |

## Incohérences / gaps
- **B-01** : routes custom publiques par défaut (contraste avec le reste).
- **E-01** : `_dnax/config` accessible à tout token valide (pas de rôle admin).
- **C-01** : `readOnlyFields` contournable par notation pointée dans `update`.
- **G-MEM-POISON** : la mémoire agent n'est **pas** couverte par `api.access` (keyée par `resourceId` fourni par l'appelant).

## Modèle d'héritage
- Pas d'héritage agent→tool/MCP : chaque `McpTool`/`McpResource`/`WebSocketHandler` a son **propre** `api.access` (pas de fallback vers l'agent).
- `'*'` = wildcard (toutes les actions) ; `true` = « tout utilisateur authentifié » (l'authN globale reste obligatoire).
