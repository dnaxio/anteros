# G-MCP-EXPOSE — Endpoint MCP sans authentification ni autorisation

- **Statut** : CONFIRMED
- **Sévérité** : HIGH (escalade CRITICAL conditionnelle — voir « Critères d'escalade »)
- **Confiance** : HIGH
- **Domaine** : API / MCP / Broken Authentication / BOLA
- **Fichiers** : `server/mcp.ts:195-207` (handler), `server/mcp.ts:77-116` (exécution tool), contraste `server/agents.ts:401-408`

## Résumé
Le handler de `GET/POST /api/:tenant_id/mcp` n'applique **aucun** contrôle d'authentification ni d'autorisation. Le tenant est extrait de l'URL, les tools/resources résolus par ce tenant, et `tool.exec()` appelé avec un `rest` lié au tenant. Tout appelant **anonyme** peut `tools/list` puis `tools/call` les tools MCP d'un tenant dont il connaît l'`id`.

## Preuve
`server/mcp.ts:195-207` — aucune vérification de token/rôle/`api.access`/tenant↔identité. `server/mcp.ts:95-103` — exécution avec `rest` tenant. `server/hono.ts:514-522` ne rejette que les tokens présents mais invalides ; une requête sans token passe. Le tenant-claim (`server/hono.ts:526`) ne s'applique qu'aux tokens avec claim.

## Préconditions
- Tenant cible avec ≥1 tool/resource MCP déclaré.
- `id` de tenant connu/déviné.

## Chemin d'exploitation
1. `POST /api/<tenant_id>/mcp` (JSON-RPC `initialize` + `tools/list`) anonyme → tools + descriptions + `inputSchema`.
2. `POST /api/<tenant_id>/mcp` (JSON-RPC `tools/call`) anonyme → `tool.exec()` sur la DB du tenant.

## Impact
- **Confidentialité** : lecture de données tenant (exfiltration).
- **Intégrité** : modification/suppression si tools d'écriture.
- **Disponibilité** : opérations coûteuses/DoS.
- **Périmètre** : tout tenant dont l'`id` est connu.

## CVSS 4.0
`CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:L/SC:L/SI:L/SA:N` → **8.7 (High)**.
Réseau + complexité faible + aucun prérequis + aucun privilège ; impact C/I élevé sur le système vulnérable (DB tenant), A faible, impact subséquent faible.

## Critères d'escalade vers CRITICAL
Si un déploiement expose un tool MCP réalisant : (1) requête MongoDB arbitraire, (2) lecture FS hors périmètre, (3) SSRF sensible, (4) exécution scripts/workflows, (5) lecture secrets/config, (6) écriture/suppression non autorisée → ré-évaluer en CRITICAL. Le framework ne fournit **aucun** tool par défaut.

## Remédiation
Dans `server/mcp.ts`, appliquer avant `tool.exec`/`resource.read` un contrôle équivalent à la route Agents :
- vérifier `c.get('token')` + tenant-claim ;
- évaluer `api.access` via `evaluateAccess` (secure-by-default : no rule = denied).
À défaut, désactiver l'endpoint MCP en production.

## Critères de validation après correction
- 401 sans token valide sur `tools/list`/`tools/call`/`resources/read`.
- Token tenant A ne peut pas invoquer un tool du tenant B.
- Sans règle `api.access`, invocation refusée.
- Chaque `tools/call` audité (identité + tenant + tool).
