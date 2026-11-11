# OWASP API Security Top 10 (2023) — Mapping

| ID | Risque | Contrôle attendu | Fichier:ligne | Preuve | Statut | Recommandation |
| --- | --- | --- | --- | --- | --- | --- |
| API1:2023 | BOLA (IDOR) | Vérifier l'appartenance de la ressource | `server/api.ts:164` (`requireId`), mémoire : `lib/agentMemory.ts:59` | IDs validés, mais mémoire keyée par `resourceId` appelant | **PARTIAL** | Lier `resource` au token (G-MEM-POISON) |
| API2:2023 | Broken Authentication | AuthN sur toutes les surfaces | `server/mcp.ts` (corrigé), `lib/sockets.ts` (corrigé) | MCP/Socket désormais authentifiés | **PASS** (après correctif) | — |
| API3:2023 | Broken Object Property Level AuthZ | Anti mass-assignment + readOnly | `mongodbadapter.ts:156` (`allowUnknown:false`), `api.ts:206` | insert OK, mais readOnlyFields bypass dot-notation | **PARTIAL** | Corriger C-01 |
| API4:2023 | Unrestricted Resource Consumption | Rate limit + bornes | `security.ts`, `func.ts:921` | global/login/MCP + `$regex`/`$in` bornés ; chaînage non borné | **PARTIAL** | Limite profondeur workflow (G-CHAIN-RECURSION) |
| API5:2023 | BFLA | Contrôle par fonction | `server/access.ts:44` (`evaluateAccess`) | collections/services/vars/agents/MCP OK ; `_dnax/config` tout token | **PARTIAL** | Restreindre `_dnax/config` (E-01) |
| API6:2023 | Unrestricted Access to Sensitive Flows | Protection des flux métier | — | dépend des règles `api.access` dev | N/A | — |
| API7:2023 | SSRF | Valider les URLs | `lib/providers.ts:147`, `lib/mcpClient.ts` | baseUrl/mcp déclarés serveur | **PASS** | — |
| API8:2023 | Security Misconfiguration | Défauts sécurisés | `config.ts`, `hono.ts:537` | `requireTenantClaim` défaut `false` | **PARTIAL** | Activer AUTH-01 |
| API9:2023 | Improper Inventory | Inventaire des endpoints | `ENDPOINT-INVENTORY.md` | `/health`, `metricsPort`, `_dnax/config` | **PARTIAL** | Restreindre/auditer les surfaces |
| API10:2023 | Unsafe Consumption of 3rd-party APIs | Valider les réponses tierces | `lib/mcpClient.ts:68` | tools distants adaptés + timeout 5s | **PASS** | — |

## Synthèse
Après correctifs MCP/Socket (API2), la surface API est bien couverte. Résidu : API1 (mémoire BOLA), API3 (readOnlyFields), API4 (chaînage), API5 (`_dnax/config`), API8 (`requireTenantClaim`).
