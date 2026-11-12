# Security Audit — Progress Register

## Project
- **Target:** Anteros — headless/backend CMS framework for Bun + MongoDB
- **Root:** `anteros/`
- **Audit type:** Static, read-only. No dynamic testing performed without authorization.

## ÉTAPE 1 — INVENTAIRE TECHNIQUE (état: EN COURS)

### Stack identifiée
| Élément | Valeur |
| --- | --- |
| Runtime | Bun >= 1.3.0 |
| Langage | TypeScript (ESM, strict) |
| Framework HTTP | Hono ^4.13.1 |
| Base de données | MongoDB (driver `mongodb` 7.5.0), une DB par tenant |
| JWT | `jose` 6.2.8 |
| Validation | `zod` ^4.4.3, `joi` ^18.3.0 |
| WebSockets | `socket.io` 4.8.3, `@socket.io/bun-engine` 0.1.1 |
| Cache | `bentocache` 1.6.1, `ioredis` 6.0.0 |
| MCP | `@hono/mcp` ^0.3.1, `@modelcontextprotocol/sdk` ^1.30.0 |
| DuckDB | `@duckdb/node-api` 2.0.0-r.1 |
| Reco | `onnxruntime-node` ^1.31.1, `sharp` ^0.35.5 |

### Packages
| Package | Version | Rôle |
| --- | --- | --- |
| `@anteros/core` | 0.0.48 | Framework principal (server, collections, routes, hooks, agents) |
| `@anteros/cli` | 0.0.1 | CLI de scaffolding |
| `@anteros/sdk` | 0.0.8 | Client HTTP typé |
| `@anteros/duckdb` | 0.0.15 | DuckDB / Quack |
| `@anteros/reco` | 0.0.1 | Reconnaissance faciale |
| `@anteros/gateway` | 0.0.1 | Reverse proxy passif |

### Fichiers source principaux (core) — ~20 500 lignes
- `server/` : access.ts, api.ts, boot.ts, cluster.ts, config.ts, env.ts, envFile.ts, flags.ts, hono.ts, http.ts, io.ts, mcp.ts, metrics.ts, routes.ts, security.ts, agents.ts
- `database/` : audit.ts, collection.ts, db.cache.ts, decorator.ts, field.crypto.ts, file.ts, mongodbadapter.ts (1524 l.), replication.ts, rest.ts, schema.ts, tenant.ts, ttl.ts, vars.ts, workflow.ts
- `lib/` : agent.ts (2195 l.), api.ts, define.ts, endpoints.ts, error.ts, files.ts (667 l.), load.ts, middleware.ts, routes.ts, services.ts, scripts.ts, etc.
- `utils/` : cache.ts, crypto.ts (417 l.), func.ts (1302 l.), index.ts, logger.ts (317 l.)

### Plan de découpage des lots (proposition)
1. **Lot A** — `server/security.ts`, `server/access.ts`, `server/api.ts`, `server/hono.ts` (surface d'authentification/autorisation)
2. **Lot B** — `server/boot.ts`, `server/config.ts`, `server/env.ts`, `server/envFile.ts`, `server/http.ts`
3. **Lot C** — `database/mongodbadapter.ts`, `database/collection.ts`, `database/schema.ts`, `database/rest.ts`
4. **Lot D** — `database/tenant.ts`, `database/file.ts`, `database/field.crypto.ts`, `database/audit.ts`
5. **Lot E** — `lib/api.ts`, `lib/routes.ts`, `lib/endpoints.ts`, `lib/middleware.ts`, `lib/define.ts`
6. **Lot F** — `lib/files.ts`, `lib/zip.ts`, `lib/attachment.ts`, `utils/crypto.ts`
7. **Lot G** — `lib/agents.ts`, `lib/agent.ts`, `lib/agentMemory.ts`, `lib/mcp.ts`, `server/agents.ts`, `server/mcp.ts`
8. **Lot H** — `lib/services.ts`, `lib/scripts.ts`, `lib/workflow.ts`, `database/workflow.ts`, `database/vars.ts`
9. **Lot I** — `utils/logger.ts`, `lib/redact.ts`, `lib/audit.ts`, `lib/auditDriver.ts`, `lib/auditQuack.ts`
10. **Lot J** — `server/io.ts`, `server/cluster.ts`, `lib/sockets.ts`, `server/metrics.ts`
11. **Lot K** — `database/replication.ts`, `database/db.cache.ts`, `database/ttl.ts`, `database/decorator.ts`
12. **Lot L** — `gateway/`, `cli/`, `sdk/`, `duckdb/`, `reco/`

### Fichiers lus (inventaire)
- `README.md`, `SECURITY.md`, `package.json`, `tsconfig.json`, `.gitignore`, `index.ts`
- `packages/*/package.json` (6 manifests)
- Structure des dossiers `core`, `gateway`, `cli`, `sdk`, `duckdb`, `reco`

### Fichiers restant à examiner
- Tout le code source applicatif (voir lots A–L ci-dessus).
- `docd/` (site de documentation Nuxt) — hors périmètre backend mais à évaluer rapidement.

### Domaines audités
- Aucun en profondeur à ce stade (inventaire uniquement).

### Domaines restant à auditer
- Tous (authentification, autorisation, API, CMS, MongoDB, données, fichiers, plugins, infra, dépendances, logs, résilience).

### Vulnérabilités identifiées
- Aucune confirmée à ce stade (phase d'inventaire).

### Investigations nécessaires
- Validation du flux JWT (signature, algorithmes, expiration, audience/issuer).
- Règles `api.access` (RBAC/ABAC) et tenant isolation.
- Construction dynamique des requêtes MongoDB (risque d'injection NoSQL).
- Gestion des fichiers uploadés (MIME, magic bytes, path traversal).
- Champ crypto (clés, rotation).

### Prochain lot proposé
~~Lot G1 (inventaire + triage MCP)~~ → **Lot G2** (Agent Core / prompt / tool-calling / guardrails) — sur validation explicite.

---

## LOT G1 — INVENTAIRE AGENTS/MCP + TRIAGE G-MCP-EXPOSE (TERMINÉ)

### Fichiers lus (G1)
- `lib/agents.ts`, `lib/mcp.ts`, `lib/mcpClient.ts`, `server/mcp.ts`
- `server/agents.ts` (L364-412), `lib/agent.ts` (outline), `lib/agentMemory.ts` (outline), `lib/providers.ts` (outline)

### 🚨 HIGH confirmé
- **G-MCP-EXPOSE** — MCP sans authN/authZ (`server/mcp.ts:195-207`). CVSS 8.7 (High).
- G-MCP-ENUM (LOW), G-MCP-AUDIT (LOW) — findings liés.

### Identité d'exécution MCP (GAP 1)
- `rest` lié au tenant (URL), **anonyme**, MongoDB = connexion tenant (**NOT_VERIFIED**), `internal:false` (audit), processus partagé (accès `process.env`/`cfg` global → F-01).

### Validation args MCP (GAP 3)
- `tool.inputSchema.validate(raw, {allowUnknown:false})` (Joi) avant `tool.exec` → validation présente. G-MCP-INJECT **non retenu** comme finding framework (la sûreté reste à la charge du code du tool).

### Livrables
- `findings/G-MCP-EXPOSE.md`, `findings/G-MCP-ENUM.md`, `findings/G-MCP-AUDIT.md`
- `MCP-EXECUTION-IDENTITY.md`, `TOOL-PERMISSION-MATRIX.md`
- `VULNERABILITY-REPORT.md`, `PRODUCTION-READINESS.md` (NOT READY), `PROGRESS.md` mis à jour.

### En attente
- G2–G6 suspendus (validation utilisateur requise).

---

## ÉTAPE 4c — SCRIPTS/WORKFLOWS & EXÉCUTION DE CODE (Lot F — TERMINÉ)

### Fichiers lus (Lot F)
- `lib/define.ts`, `lib/load.ts`, `lib/scripts.ts`, `lib/scriptWorker.ts`, `lib/workflow.ts`
- `database/workflow.ts` (sections invoke/executeSteps/run), `database/vars.ts` (outline)
- Recherche `eval`/`new Function`/`vm` → **aucun résultat** dans le core.

### Constats
| ID | Constat | Criticité | Statut |
| --- | --- | --- | --- |
| F-01 | Pas d'isolation tenant au niveau code : process partagé, `cfg` global (tous les `database.uri`), `process.env` partagé (JWT_SECRET HS256 commun) | MEDIUM | CONFIRMED |
| F-02 | `runHeavyScript` passe `process.env` complet au sous-processus | LOW | CONFIRMED |
| F-03 | Scripts/services/actions/hooks/workflows en `internal:true` + accès DB complet (par conception) | INFO | CONFIRMED |
| F-04 | Scripts non-heavy sans timeout/limite CPU/mémoire | LOW | CONFIRMED |

### Contrôles vérifiés (positifs)
- **Aucun RCE client** : pas d'`eval`/`new Function`/`vm` ; handlers = références de fonctions déclarées.
- Workflows : `validateWorkflowContext`, timeout + retries/backoff + AbortController, verrou distribué + saga.
- Heavy scripts : subprocess, timeout hard (kill), config tenant via stdin (pas de fuite `ps`).
- `runAction`/`runService` vérifient `Object.hasOwn` avant invocation.

### Livrables
- `SCRIPT-EXECUTION-SECURITY.md`, `UNAUDITED-AREAS.md` créés ; `VULNERABILITY-REPORT.md`, `PROGRESS.md` mis à jour.

---

## ÉTAPE 4b — API/CMS & ROUTES INTERNES (Lot E — TERMINÉ)

### Fichiers lus (Lot E)
- `lib/api.ts`, `lib/routes.ts`, `lib/endpoints.ts`, `lib/middleware.ts`, `lib/services.ts`
- `server/api.ts` (L745-795 service, L659-745 vars, L860-989 files/config)
- `database/mongodbadapter.ts` (L1157-1216 runAction/runService)

### Constats
| ID | Constat | Criticité | Statut |
| --- | --- | --- | --- |
| E-01 | `_dnax/config` expose le schéma (collections/champs/relations/services) à tout token valide, sans rôle admin | LOW | CONFIRMED |
| AUTH-01 (repris) | `_dnax/config` cross-tenant possible via token sans claim `tenant` (défaut `requireTenantClaim:false`) | MEDIUM | CONFIRMED |

### Contrôles vérifiés (positifs)
- Services : `evaluateAccess(service.api.access, action)` — 401 si pas de règle (secure-by-default).
- Vars : ns déclaré via `define.Vars` + `evaluateAccess` ; audit **jamais** `value`/`meta` (secrets).
- Actions custom collection : `evaluateAccess(col.api.access, action)` avant `runAction`.
- `_dnax/config` : token vérifié requis, `safePublicConfig()` (pas de secrets), tenant-claim appliqué.
- Custom routes : warning si shadow d'une famille framework (`isReservedFamily`).
- Multi-tenant : services/routes/vars résolvent `_tenant_` et conservent le `rest` lié au tenant.

### Zones non vérifiées (lots suivants)
- `agents` / `mcp` / `socket.io` (Lot G/J) — accès et isolation à confirmer.
- `lib/define.ts`, `lib/load.ts`, `lib/scripts.ts`, `lib/workflow.ts` (Lot F).

### Livrables créés/mis à jour
- `ENDPOINT-INVENTORY.md`, `INTERNAL-ENDPOINTS-ANALYSIS.md`, `VULNERABILITY-REPORT.md` (registre), `PROGRESS.md`.

---

## ÉTAPE 4 — FILES, PLUGINS & EXTENSIONS (Lot D — TERMINÉ)

### Fichiers lus (Lot D)
- `database/file.ts`, `database/field.crypto.ts`
- `lib/zip.ts`, `lib/attachment.ts`, `lib/files.ts` (storage, upload, serve, detect, replication)
- `server/api.ts` (L860-970 : routes upload/serve/delete)

### Constats
| ID | Constat | Criticité | Statut |
| --- | --- | --- | --- |
| D-01 | `Content-Disposition: filename="..."` : la validation du `filename` n'exclut pas `"`, CR, LF → injection d'en-tête possible (à vérifier en dynamique) | LOW | POSSIBLE |
| D-02 | Réplication SFTP : `filename` (ext contrôlé par upload) interpolé dans le batch stdin (`put "..."`) → injection de commande SFTP | LOW | LIKELY |
| D-03 | Réplication SSH/SFTP : `StrictHostKeyChecking=accept-new` (acceptation auto des clés → risque MITM) | LOW | CONFIRMED |
| D-04 | `col.storage.path` joint sans sanitiser (mais valeur config serveur, non client) | INFO | CONFIRMED |

### Contrôles vérifiés (positifs)
- Upload : validation **magic bytes** (`detectMimeFromBuffer`) + rejet si déclaré image mais contenu non-image.
- SVG avec `<script`/`onload`/`onerror`/`javascript:` → rejeté (`svgContainsScript`).
- Serve : seuls PNG/JPEG/GIF/WebP/AVIF/BMP + PDF en inline ; **tout le reste en `attachment`** (anti XSS stocké).
- Filename disque : `<ObjectId><ext>`, `writeFile` flag `'wx'` (pas d'écrasement).
- Path traversal serve/delete **bloqué** (validation `rawFile`/`fileId` : pas de `.` initial, `..`, `/`, `\`).
- Attachments agent : `realpath` + `startsWith(root+sep)` (anti-échappement symlink).
- ZIP : `MAX_ENTRY_BYTES` 10MB, `inflateRawSync maxOutputLength` (anti zip-bomb), pas de ZIP64/encrypté.
- Crypto champ : AES-256-GCM + AAD (tenant:collection:field), rejet des opérateurs non chiffrables, clé par version (rotation).

### Faux positifs écartés
- Path traversal fichier → déjà mitigé (validation `rawFile`/`fileId`).

---

## ÉTAPE 3 — MONGODB & DATA (Lot C — TERMINÉ)

### Fichiers lus (Lot C)
- `database/rest.ts`, `database/tenant.ts`, `database/collection.ts`, `database/schema.ts`
- `database/mongodbadapter.ts` (sections : _validate, find/findOne/aggregate, addActivities)
- `utils/func.ts` (buildPipeline, assertSafeFilter, boundMatchOperators, isSafeAggregatePipeline, toBson, unflattenKeys)
- `server/api.ts` (L52-230 : readOnly/private fields, update operators)

### Constats
| ID | Constat | Criticité | Statut |
| --- | --- | --- | --- |
| C-01 | `readOnlyFields` contournable via notation pointée dans `update` (`$set: {'obj.champ': …}`) — ni `assertOperatorUpdate` (match exact) ni `stripReadOnlyUpdate` ne détectent `obj.champ` | MEDIUM | CONFIRMED |
| C-02 | `$expr` non bloqué dans l'action `aggregate` (contrairement à `find`) → `$regexMatch`/`$regexFind` non bornés (ReDoS) | LOW | CONFIRMED |
| C-03 | Opérateurs de mise à jour hors `$set` (`$push`, `$inc`, `$mul`, `$min`, `$max`) ne passent pas la validation Joi du schéma | LOW | CONFIRMED |
| C-04 | `aggregate` autorise `$lookup` vers les collections système `_audit_`, `_locks_`, `_workflows_` (méta-données d'audit) | LOW | CONFIRMED |
| C-05 | Pas d'ACL document/champ natif (ownership) — à implémenter dans la fonction `api.access` | INFO | CONFIRMED |

### Contrôles vérifiés (positifs)
- `$where`/`$function`/`$accumulator` bloqués partout ; `$expr` bloqué dans `find`.
- `$out`/`$merge`/`$unionWith`/`$collStats`/`$currentOp`/… bloqués dans `aggregate` (pas d'écriture ni exfiltration cross-collection).
- `$lookup`/`$graphLookup` restreints aux collections du tenant.
- `$regex` (max 1000 c.) et `$in`/`$nin` (max 10 000) bornés → anti-ReDoS/memory-DoS.
- `$sort`/`$skip`/`$limit` validés (entiers, direction 1/-1).
- `$project` : renommage de champ interdit (anti-exfiltration par alias).
- Update : opérateurs en allow-list, `$rename` absent (anti-exfiltration).
- `requireId` (string, pas de préfixe `$`) → anti-IDOR `$ne`/`$gt`.
- `insertOne`/`insertMany` : `allowUnknown: false` → anti mass-assignment.

### Note
Code manifestement passé par un durcissement sécurité (commentaires « Flaw 9/12/13/14 », #24/#31/#32/#33/#35/#43/#45/#47/#48/#52/#63).

---

## ÉTAPE 2b — CONFIGURATION & BOOT (Lot B — TERMINÉ)

### Fichiers lus (Lot B)
- `server/boot.ts` (génération secret, cluster, Bun.serve)
- `server/http.ts` (idle timeout)
- `server/routes.ts` (routes custom)
- `server/flags.ts` (capabilités/modes)
- `docd/.../14.routes.md` (doc routes, auth manuelle)

### Constats (aucun CRITICAL/HIGH)
| ID | Constat | Criticité | Statut |
| --- | --- | --- | --- |
| B-01 | Routes custom (`cfg.routes`) publiques par défaut — auth manuelle attendue (documenté) | LOW | CONFIRMED |
| B-02 | Master cluster expose `/health` sur `metricsPort` (PORT+1) non authentifié + metrics agrégées | LOW | CONFIRMED |

### Contrôles vérifiés (positifs)
- JWT_SECRET auto-généré (CSPRNG 48 octets) + persisté `0600` si auth activée et secret absent.
- Avertissement boot si secret < 32 caractères.
- `maxRequestBodySize` (Bun.serve) + middleware `bodyLimit` (16MB/100MB) = double limite.
- Idle timeout HTTP par défaut 30s (configurable, borné).
- `uncaughtException`/`unhandledRejection` loggés en fichier, réponse client générique 500 (pas de fuite).

### À investiguer (lots suivants)
- Endpoint interne `_dnax/config` (`api.ts` ~L973-985) → vérifier exposition de `safePublicConfig()`.

---

## ÉTAPE 2 — AUTHENTIFICATION & IDENTITY (Lot A — TERMINÉ)

### Fichiers lus (Lot A)
- `server/security.ts` (rate limiting)
- `server/access.ts` (evaluateAccess)
- `server/api.ts` (flux login/logout/access)
- `server/hono.ts` (CORS, headers sécurité, parsing JWT, tenant claim, rate limit)
- `utils/func.ts` (JWT sign/verify)
- `utils/crypto.ts` (crypto champ — aperçu)
- `server/config.ts`, `server/env.ts`, `server/envFile.ts`
- `database/audit.ts`, `lib/audit.ts`, `lib/redact.ts`
- `database/mongodbadapter.ts` (section addActivities/redaction)

### Constats (aucun CRITICAL/HIGH confirmé)
| ID | Constat | Criticité | Statut |
| --- | --- | --- | --- |
| AUTH-01 | `requireTenantClaim` par défaut `false` → token sans claim `tenant` accepté cross-tenant | MEDIUM | CONFIRMED |
| AUTH-02 | JWT sans état : pas de rotation/refresh, pas de révocation serveur (logout client-side) | MEDIUM | CONFIRMED |
| AUTH-03 | Durée de vie token par défaut 7 jours | LOW | CONFIRMED |
| AUTH-04 | `issuer`/`audience` non vérifiés sauf si configurés | LOW | CONFIRMED |
| AUTH-05 | Rate limiting in-memory par instance (non partagé en cluster), clé IP | MEDIUM | CONFIRMED |
| AUTH-06 | `/health` public, expose metrics + IP, non rate-limité | LOW | CONFIRMED |
| AUTH-07 | Claims JWT décodées (PII : email, sub) stockées dans l'audit (`token.decoded`) | LOW | CONFIRMED |

### Contrôles vérifiés (positifs)
- JWT HS256 via `jose` + clé symétrique → confusion d'algorithme / `alg:none` bloquée.
- Aucun secret JWT par défaut ; auto-généré + persisté en `0600` (`saveJwtSecret`).
- `requiredClaims: ['exp']` imposé à la vérification.
- Contrôle d'accès secure-by-default (`evaluateAccess` → 401 si pas de règle).
- Claim `tenant` forcé à la signature lors du login.
- Tokens invalides/expirés rejetés globalement (sauf login/logout).
- Redaction d'audit par défaut (`password`/`token`/`secret`… → `[redacted]`).
- Rejet CORS `credentials:true` + `origin:*` au boot.

### Faux positif écarté
- « Mot de passe en clair dans l'audit » → **déjà corrigé** par `redactPayload` (`mongodbadapter.ts` addActivities → `lib/redact.ts`).
