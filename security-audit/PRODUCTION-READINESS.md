# Production Readiness — Verdict (préliminaire)

> Ce verdict est **intermédiaire** : l'audit statique est en cours (lots A–F + triage MCP terminés ; G2–G6 et dépendances/infra restent à auditer).

## Verdict actuel : **NOT READY**

### Justification
Une vulnérabilité **HIGH confirmée et non corrigée** bloque la production :

- **G-MCP-EXPOSE** — `GET/POST /api/:tenant_id/mcp` sans authentification ni autorisation (`server/mcp.ts:195-207`). CVSS 4.0 ≈ 8.7 (High).

### État de la remédiation
- **Code appliqué + unit-tests passés** (`mcp.test.ts` 6/6) : authentification + tenant-claim + `evaluateAccess` + audit + rate limit.
- **Validation staging restante** : les 12 scénarios Streamable HTTP (`MCP-SECURITY-TEST-PLAN.md`) + vérification d'audit ne sont pas exécutés (pas de staging/MongoDB autorisé).
- Le verdict reste **NOT READY** tant que la validation staging n'est pas effectuée.

### Conditions pour passer à « READY WITH CONDITIONS »
1. Corriger G-MCP-EXPOSE (authentification + `api.access` sur chaque tool/resource, aligné sur la route Agents).
2. Activer `server.jwt.requireTenantClaim: true` (AUTH-01).
3. Corriger C-01 (contournement `readOnlyFields` par notation pointée).
4. Arbitrer F-01 (isolation code inter-tenant) selon le modèle de déploiement.

### Rappel
- Un audit **statique** ne garantit pas l'absence de vulnérabilités.
- Les tests dynamiques, le pentest et l'analyse des dépendances restent à réaliser (identifiés séparément).
- Le verdict ne reflète que l'état actuel du code, pas une architecture cible future.
