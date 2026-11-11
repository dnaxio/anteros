# Security Scorecard (indicatif)

> Barème : CRITICAL −40 · HIGH −15 · MEDIUM −5 · LOW −1 · INFO 0. Score = max(0, 100 − Σ pénalités).
> Les causes racines ne sont comptées **qu'une fois** (dédupliquées). Les constats **corrigés** ne sont pas pénalisés.

| Domaine | Contrôles examinés | Constats dédupliqués | Pénalité | Score /100 |
| --- | --- | --- | --- | --- |
| Authentification & Identité | JWT (HS256/jose, `exp` requis), secret 0600, rate-limit login, tenant claim | AUTH-01(M), AUTH-02(M), AUTH-03(L), AUTH-04(L), AUTH-05(M), AUTH-06(L), AUTH-07(L) | −19 | **81** |
| Autorisation & Access Control | `evaluateAccess` (deny par défaut), `requireId`, mass-assignment, readOnlyFields, mémoire | C-01(M), G-MEM-POISON(M) | −10 | **90** |
| API Security | AuthN/AuthZ toutes surfaces, inventaire, rate limit, erreurs | E-01(L), B-01(L), B-02(L) | −3 | **97** |
| Headless CMS / Query builder | `buildPipeline`, `isSafeAggregatePipeline`, `$lookup` scoping, `$project` rename | C-02(L), C-03(L), C-04(L) | −3 | **97** |
| Data Protection | Redaction audit, `summary` (pas de doc), crypto champ (AES-GCM+AAD) | LOG-REDACT(L), F-02(L) | −2 | **98** |
| Files & Médias | Magic bytes, SVG script, attachment, path-traversal, ZIP bomb | D-01(L), D-02(L), D-03(L) | −3 | **97** |
| Plugins / Extensions (code) | Pas d'`eval`/`vm`, timeout, budget, isolation | F-01(H), F-04(L), G-CHAIN-RECURSION(L) | −17 | **83** |
| Infrastructure & DevOps | Cluster, métriques, TLS (N/V), durcissement | B-02(L) | −1 | **99** |
| Dépendances / Supply chain | Versions core à jour, `@duckdb/node-api` RC | DEP-DUCKDB(L) | −1 | **99** |
| Logging & Audit | Redaction, minimisation, correlation, centralisation | (compté en Data Protection) | 0 | **100** |
| Résilience | Rate limiting, timeouts, budget, limites | (AUTH-05 / F-04 comptés ailleurs) | 0 | **100** |

## Synthèse
- **Points forts** : NoSQL/validation, fichiers, redaction d'audit, secure-by-default.
- **Points faibles** : Authentification (81 — JWT non révocable, tenant claim permissif), Plugins/Extensions (83 — F-01 architecture partagée).
- **Verdict global** : un score élevé ne garantit **jamais** la sécurité. **F-01 (HIGH confirmé non corrigé) → NOT READY.**

## Contrôles non vérifiés (N/A ou NOT VERIFIED)
- TLS, rôles/credentials MongoDB, scan CVE automatisé, tests dynamiques/pentest, durcissement OS/container.
