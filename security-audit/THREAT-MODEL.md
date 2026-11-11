# Threat Model

## Profils d'attaquant

### 1. Attaquant externe anonyme
- **Prérequis** : accès réseau à l'API.
- **Findings** : G-MCP-EXPOSE (corrigé), SOCKET-AUTH (corrigé), G-MCP-ENUM (corrigé), B-02 (metricsPort), AUTH-06 (/health), AUTH-05 (rate limit IP contournable).
- **Impact résiduel** : après correctifs, l'attaquant anonyme ne peut plus invoquer tools MCP ni sockets. Reste : énumération limitée via /health, contournement rate-limit par rotation IP.

### 2. Utilisateur authentifié avec privilèges limités
- **Prérequis** : token valide (tenant), accès agent/collection.
- **Findings** : AUTH-01 (token sans claim cross-tenant), G-PROMPT-INJ (injection → tool call), G-MEM-POISON (BOLA mémoire), C-01 (readOnlyFields bypass), E-01 (schéma via `_dnax/config`).
- **Impact** : escalade de privilèges intra-tenant (accès aux tools/mémoire d'autres utilisateurs, modification de champs read-only), divulgation de schéma.

### 3. Administrateur compromis
- **Prérequis** : compte admin / token admin.
- **Impact** : accès complet au tenant (par conception). Risque aggravé par F-01 (accès `cfg` global → tous les tenants, forge de JWT via secret partagé).

### 4. Insider / supply chain
- **Prérequis** : capacité à modifier le code déployé (dépendance compromise, accès dépôt).
- **Findings** : F-01 (process partagé, `cfg` global, JWT secret commun), DEP-DUCKDB (RC expérimental), DEP-SURFACE (surface transitive + natifs).
- **Impact** : compromission totale (lecture de tous les tenants, forge de tokens, exécution arbitraire).

## Matrice findings × profils

| Finding | Profil 1 | Profil 2 | Profil 3 | Profil 4 |
| --- | --- | --- | --- | --- |
| F-01 (HIGH) | — | — | ⚠️ | 🔴 |
| AUTH-01 (MEDIUM) | — | 🟠 | ⚠️ | — |
| G-PROMPT-INJ (MEDIUM) | — | 🟠 | — | — |
| G-MEM-POISON (MEDIUM) | — | 🟠 | — | — |
| C-01 (MEDIUM) | — | 🟠 | — | — |
| SOCKET-TENANT (MEDIUM, fixé) | 🟠 | — | — | — |
| G-MCP-EXPOSE (fixé) | 🟠 | — | — | — |

Légende : 🔴 critique · 🟠 important · ⚠️ modéré.

## Scénarios d'escalade CRITICAL évalués (non retenus)
- **Introduction de code distant** : non démontrée (pas de mécanisme d'upload de plugins/scripts).
- **Prompt injection → compromission grave inter-tenant** : limitée par l'isolation tenant (DB par tenant) ; pas de démonstration d'un impact inter-tenant sans F-01.
- **G-MCP-EXPOSE** : HIGH confirmé puis **corrigé** (pas de CRITICAL démontré, aucun tool par défaut).
