# MCP Security Test Plan (non destructif, staging isolé)

> **Aucun test en production sans autorisation écrite.** Environnement : staging isolé, tenant de test, tool de test **sans effet de bord** (retourne une constante). Pas de données réelles.

## Pré-requis
- Un tenant `t-a` avec un tool MCP de test (`echo`), un tenant `t-b` avec un tool différent.
- Deux tokens : `tok-a` (tenant `t-a`), `tok-a-noclaim` (sans claim `tenant`, si `requireTenantClaim:false`), `tok-b` (tenant `t-b`).
- Un client MCP (ou requêtes JSON-RPC manuelles) + un outil de mesure de statut/corps/temps.

## Cas de test

| # | Scénario | Attendu après correctif |
| --- | --- | --- |
| 1 | `tools/list` sans `Authorization` | **401** `AUTH_REQUIRED` |
| 2 | `tools/call` avec token invalide (signature falsifiée) | **401** `INVALID_TOKEN` |
| 3 | `tools/call` avec token expiré | **401** `TOKEN_EXPIRED` |
| 4 | `tools/call` avec `tok-a-noclaim` (si `requireTenantClaim:false`) | 401 `TENANT_CLAIM_REQUIRED` **si** le correctif exige un claim ; sinon documenter le comportement |
| 5 | `tok-a` sur URL `/api/t-b/mcp` (tools/call) | **401** `TENANT_MISMATCH` |
| 6 | `tok-a` sur URL `/api/t-a/mcp` (tools/call sur tool sans `api.access`) | **401** `ACCESS_DENIED` (no rule = denied) |
| 7 | `tok-a` sur `/api/t-a/mcp` `tools/list` | **200** (liste des tools du tenant) |
| 8 | `tok-a` `tools/call` sur tool de test avec `api.access.call = true` | **200**, résultat attendu |
| 9 | `resources/list` | **200** (ressources du tenant, authentifié) |
| 10 | `resources/read` sur resource sans `api.access` | **401** `ACCESS_DENIED` |
| 11 | Session MCP invalide / `initialize` absent ou `Mcp-Session-Id` invalide | Rejet du transport (erreur protocolaire), **pas** d'exécution de tool |
| 12 | 50 `tools/call` concurrents | Rate limit appliqué ; pas de crash ; pas d'écriture hors scope |

## Vérifications complémentaires (protocole Streamable HTTP)
- `initialize` → négociation de version OK.
- `tools/list` / `tools/call` / `resources/read` fonctionnent après `initialize`.
- Les requêtes `GET` (SSE) et `POST` (JSON-RPC) sont toutes deux couvertes par l'auth.
- `DELETE` (fin de session) n'exécute aucun tool.

## Vérification audit (G-MCP-AUDIT)
Après les cas 6/8/10, contrôler dans `_audit_` la présence d'entrées `mcp.tools/call` / `mcp.resources/read` avec :
- principal (`sub`) ou `"anonymous"`,
- tenant, tool/resource, timestamp, succès/échec, correlation id,
- **aucun** argument en clair (seule une empreinte).

## Vérification énumération (G-MCP-ENUM)
- `tools/list` sur tenant inexistant vs existant sans tools → réponse **identique** (statut/corps), sans écho de `tenant_id`.

## Sortie
Un rapport par cas : statut réel, corps, code, et écart éventuel vs attendu. Tout écart = non-conformité du correctif.
