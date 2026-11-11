# Remediation Plan (priorisé)

> Priorité : P0 (immédiat) · P1 (avant production) · P2 (durcissement).

## P0 — Avant toute production

| # | Finding | Correctif | Fichier | Complexité |
| --- | --- | --- | --- | --- |
| 1 | **F-01 (HIGH)** | Définir le modèle de déploiement. Si tenants non fiables : séparer les processus par tenant (ou Control Plane / Execution Plane), secret JWT **par tenant** (pas HS256 partagé), retirer `database.uri` de `cfg` global partagé. Sinon : documenter explicitement le modèle mono-opérateur. | `server/config.ts`, `utils/func.ts` (jwt) | Élevée |
| 2 | **AUTH-01 (MEDIUM)** | Activer `server.jwt.requireTenantClaim: true` en production. | config | Triviale |
| 3 | **C-01 (MEDIUM)** | `assertOperatorUpdate` : détecter les préfixes (`target === field \|\| target.startsWith(field + '.')`). | `server/api.ts:206-213` | Faible |
| 4 | **G-PROMPT-INJ (MEDIUM)** | Documenter/activer `guardrails` + `approval` sur les tools sensibles ; proposer un least-privilege par tool (limiter `rest` exposé). | `lib/agent.ts`, docs | Moyenne |
| 5 | **G-MEM-POISON (MEDIUM)** | Dériver `resource` de l'identité authentifiée (`token.decoded.sub`) ou ajouter un contrôle d'appartenance dans `server/agents.ts`. | `server/agents.ts`, `lib/agentMemory.ts` | Moyenne |

## P1 — Durcissement recommandé

| # | Finding | Correctif | Fichier |
| --- | --- | --- | --- |
| 6 | AUTH-02 | Évaluer refresh token rotatif + révocation (ou documenter le modèle stateless). | `utils/func.ts` |
| 7 | AUTH-05 | Rate limiting Redis partagé en cluster (déjà supporté, activer). | `server/hono.ts` |
| 8 | LOG-REDACT | Appliquer `redactText`/`redactPayload` au `Logger#write`, redacter `request_body`. | `utils/logger.ts`, `server/hono.ts` |
| 9 | E-01 | Restreindre `_dnax/config` à un rôle admin (`token.decoded.role`). | `server/api.ts:972` |
| 10 | C-02 | Bloquer `$expr` dans `isSafeAggregatePipeline`. | `utils/func.ts:1182` |
| 11 | G-CHAIN-RECURSION | Limite de profondeur sur le chaînage workflow/script. | `database/workflow.ts` |
| 12 | D-01 | Valider `filename` contre `"`, CR, LF (header injection). | `server/api.ts:897-900` |
| 13 | D-02 | Échapper/valider `filename` dans la réplication SFTP. | `lib/files.ts:619-642` |

## P2 — Veille & supply chain

| # | Action |
| --- | --- |
| 14 | Épingler `@duckdb/node-api` et surveiller la sortie de la version stable (2.0.0-r.1 = RC). |
| 15 | Exécuter `osv-scanner`/`trivy`/`gitleaks` en CI ; `bun pm ls` de routine. |
| 16 | Auditer la source des packages annexes (`gateway`, `cli`, `sdk`, `reco`, `docd`). |

## Validation après correction
- Ré-exécuter `bun test packages/core/tests/mcp.test.ts` et les tests socket (après ajout).
- Exécuter `MCP-SECURITY-TEST-PLAN.md` (12 scénarios) et son équivalent WebSocket sur staging isolé.
- Vérifier l'audit (`_audit_`) pour les refus d'autorisation et les appels MCP/socket.
