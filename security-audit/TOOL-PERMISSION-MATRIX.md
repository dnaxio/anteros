# Tool Permission Matrix

> **Important** : le framework Anteros ne fournit **aucun tool par défaut**. Les tools sont **définis par l'opérateur** via `define.Tool` (agent) ou `define.McpTool` (MCP). Cette matrice documente donc le **modèle d'exécution** (contrôles appliqués par le framework) plutôt que des tools concrets, qui n'existent que dans les déploiements.

## Modèle d'exécution des tools

| Surface | File:Line | Params | Auth | Min Role | Resources | Tenant Filter | Validation | Side Effects | Rate Limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Agent tool (via LLM) | `lib/agent.ts:1506-1566` (#executeTool) | args (Zod `inputSchema`) | Token (via route agents `api.access`) | règle `api.access` | `rest` tenant + FS/réseau (selon code tool) | lié au `rest` appelant | `inputSchema` (Zod) + guardrails | dépend du tool | global 100/min |
| Agent route | `server/agents.ts:364-535` | body | Token + `api.access` | **no rule = denied** | — | URL tenant | `normalizeInput`, Zod | — | global |
| MCP tool (`tools/call`) | `server/mcp.ts:77-116` | args (Joi `inputSchema`) | **AUCUN** ❌ | **AUCUN** ❌ | `rest` tenant + FS/réseau (selon code tool) | URL tenant (non contrôlé) | `inputSchema.validate(raw, {allowUnknown:false})` ✅ | dépend du tool | global 100/min |
| MCP resource (`resources/read`) | `server/mcp.ts:146-171` | uri + params | **AUCUN** ❌ | **AUCUN** ❌ | `rest` tenant | URL tenant (non contrôlé) | matching template | dépend de la resource | global |
| MCP client (outbound) | `lib/mcpClient.ts:87-112` | args | — (conso. agent) | — | réseau distant | — | `inputSchema` distant | distant | timeout 5s |

## Colonnes « Tool / Min Role / Side Effects / Resources »
Non renseignées au niveau framework (aucun tool concret). À remplir **par déploiement** pour chaque `define.Tool` / `define.McpTool` :
- **Params** : schéma Zod/Joi déclaré.
- **Min Role** : si `api.access` utilise le rôle (`token.decoded.role`), sinon tout token valide.
- **Resources** : `rest` (DB tenant), éventuellement `fs`, `fetch`, `Bun.spawn`, `process.env`.
- **Side Effects** : lecture/écriture DB, fichiers, réseau, exécution.

## Constat transversal
- **Agent** : chaque action est **gated** (`api.access`, no rule = denied). ✅
- **MCP** : **aucun** gating (`G-MCP-EXPOSE`). ❌
