# OWASP ASVS 5.0 — Mapping (extrait des contrôles vérifiés)

> Statut : PASS (preuve code) / FAIL / PARTIAL / NOT VERIFIED / N/A.
> Seuls les contrôles **effectivement examinés** sont listés. Aucun chapitre n'est déclaré « couvert » en entier.

| ID ASVS | Domaine | Exigence (résumé) | Fichier | Preuve | Statut |
| --- | --- | --- | --- | --- | --- |
| V2.1.1 | AuthN | Mots de passe ≥ 12 c. / politique | — (délégué à `onLogin` dev) | non vérifiable framework | N/A |
| V2.2.1 | AuthN | Anti brute-force login | `server/hono.ts:449` | rate-limit login 10/min | PASS |
| V2.3.1 | AuthN | JWT signé, exp vérifiée | `utils/func.ts:44-55` | `jose.jwtVerify` + `requiredClaims:['exp']` | PASS |
| V2.3.2 | AuthN | Pas d'`alg:none` / confusion | `utils/func.ts:50` | clé symétrique jose | PASS |
| V2.4.1 | AuthN | Refresh token rotatif/révocation | — | JWT sans état | FAIL (AUTH-02) |
| V2.5.4 | AuthN | Tenant claim obligatoire | `server/hono.ts:537` | défaut `false` | PARTIAL (AUTH-01) |
| V4.1.1 | Access | Contrôle d'accès par défaut (deny) | `server/access.ts:52` | `evaluateAccess` no rule = 401 | PASS |
| V4.1.2 | Access | IDOR/BOLA protégé | `server/api.ts:164` | `requireId` (anti `$ne`) | PASS |
| V4.2.2 | Access | Mass assignment évité | `database/mongodbadapter.ts:156` | `allowUnknown:false` | PASS |
| V4.3.1 | Access | Moindre privilège par opération | `server/api.ts:179` | allow-list opérateurs update | PARTIAL (C-01) |
| V5.1.4 | Validation | Rejet des objets inconnus | `schema.ts` + `validate` | Joi `allowUnknown:false` | PASS |
| V5.2.4 | Validation | Anti-injection NoSQL | `utils/func.ts:697-973` | `$where`/`$function`/`$expr` bloqués | PASS |
| V5.5.1 | Validation | Anti-ReDoS regex | `utils/func.ts:921` | `$regex` max 1000 | PASS |
| V6.2.1 | Crypto | Algorithme de hashage moderne | `utils/func.ts:29` | HMAC-SHA256 (JWT) | PASS |
| V6.4.2 | Crypto | Clés gérées, pas en clair | `server/envFile.ts:53` | `.env` 0600 | PASS |
| V7.1.1 | Logging | Pas de secrets dans les logs | `lib/redact.ts` + `server/hono.ts:468` | redaction + exclusion headers | PASS |
| V7.1.2 | Logging | Audit des accès sensibles | `database/mongodbadapter.ts:1327` | `rest.audit` | PARTIAL (G-MCP-AUDIT fixé) |
| V8.3.8 | Data | Données sensibles non loggées | `lib/redact.ts`, `auditResult.ts` | `summary` = jamais de doc | PASS |
| V9.1.3 | Comm. | TLS requis (déploiement) | — | hors code | NOT VERIFIED |
| V12.1.1 | Fichiers | Upload validé (MIME + taille) | `lib/files.ts:256-272` | magic bytes + maxSize | PASS |
| V12.3.5 | Fichiers | Anti path-traversal | `server/api.ts:897`, `lib/attachment.ts:224` | validation + realpath | PASS |
| V12.6.1 | Fichiers | Anti SSRF (URLs) | `lib/providers.ts:147` | baseUrl config-contrôlée | PASS |
| V13.1.1 | API | Inventaire des endpoints | `ENDPOINT-INVENTORY.md` | — | PARTIAL |
| V13.2.3 | API | Rate limiting | `server/security.ts` | global + login + MCP | PARTIAL (AUTH-05) |

## Synthèse
Contrôles core (NoSQL, mass-assignment, JWT, fichiers, redaction) **solides**. Faiblesses : JWT non révocable (V2.4.1), tenant claim défaut permissif (V2.5.4), readOnlyFields bypass (V4.3.1), rate-limit non partagé (V13.2.3).
