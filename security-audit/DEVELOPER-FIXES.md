# Developer Fixes — correctifs à porter (résumé actionnable)

> Destiné aux développeurs. Chaque correctif = finding + fichier + extrait avant/après + test.
> **Déjà appliqués** (MCP + Socket) sont listés en référence à la fin.

---

## A. Correctifs code ponctuels (à porter)

### 1. AUTH-01 — `requireTenantClaim` (config, trivial)
**Fichier** : configuration de déploiement (pas de code).
```ts
// avant (défaut)
server: { jwt: { secret: "…" } }
// après
server: { jwt: { secret: "…", requireTenantClaim: true } }
```
**Test** : un token **sans** claim `tenant` doit être rejeté (401) sur toute route `/api/:tenant/…`.

---

### 2. C-01 — `readOnlyFields` contournable par notation pointée (MEDIUM)
**Fichier** : `packages/core/server/api.ts` (fonction `assertOperatorUpdate`, ~L198-200).

```diff
 const readOnly = (col?.api?.readOnlyFields ?? []).map((field: string | RegExp) =>
-    typeof field === "string" ? (name: string) => name === field : (name: string) => field.test(name),
+    typeof field === "string"
+        ? (name: string) => name === field || name.startsWith(field + ".")
+        : (name: string) => { field.lastIndex = 0; return field.test(name); },
 );
```
**Test** : `updateOne` avec `{"update":{"$set":{"compte.role":"admin"}}}` où `readOnlyFields:['compte']` doit renvoyer 400 `READONLY_FIELD`.

---

### 3. E-01 — `_dnax/config` restreint à un rôle admin (LOW)
**Fichier** : `packages/core/server/api.ts:972-987`.

```diff
 const t = c.get('token');
 if (!t?.decoded || t?.expired || !t?.provided) return c.json({...}, 401);
+ if (t.decoded['role'] !== 'admin') return c.json({ message: 'Forbidden', code: 'FORBIDDEN' }, 403);
```
**Test** : token sans rôle `admin` → 403 ; token admin → 200.

---

### 4. C-02 — bloquer `$expr` dans `aggregate` (LOW)
**Fichier** : `packages/core/utils/func.ts` (`isSafeAggregatePipeline`, ~L1182).

```diff
 const UNAUTHORIZED_PIPELINE_KEYS = [
-    '$out', '$merge', '$function', '$where', '$accumulator',
+    '$out', '$merge', '$function', '$where', '$accumulator', '$expr',
     '$unionWith', ...
 ];
```
**Test** : `aggregate` avec `[{ $match: { $expr: … } }]` doit renvoyer 400 `UNAUTHORIZED_PIPELINE_KEYS`.

---

### 5. D-01 — `Content-Disposition` header injection via `filename` (LOW)
**Fichier** : `packages/core/server/api.ts:897-900` (validation `rawFile`).

```diff
- if (!rawFile || rawFile.startsWith('.') || rawFile.includes('..') || rawFile.includes('/') || rawFile.includes('\\')) {
+ if (!rawFile || rawFile.startsWith('.') || rawFile.includes('..') || rawFile.includes('/') || rawFile.includes('\\')
+     || /[\r\n"]/.test(rawFile)) {
     throw new AppError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
 }
```
**Test** : `GET /api/:t/files/:c/<id>."%0d%0aX-Injected:1` → 400.

---

### 6. D-02 — réplication SFTP : échapper `filename` (LOW)
**Fichier** : `packages/core/lib/files.ts:619-642` (`replicateToSFTP`).

```diff
- args.push(`${username}@${host}`);
- const result = await Bun.spawn(args, {
-     stdin: Buffer.from(`put "${localPath}" "${remotePath}/${filename}"\nquit\n`),
+ args.push(`${username}@${host}`);
+ const safeRemote = `${remotePath}/${filename}`.replace(/["\n\r]/g, '');
+ const result = await Bun.spawn(args, {
+     stdin: Buffer.from(`put "${localPath}" "${safeRemote}"\nquit\n`),
```
**Test** : upload d'un fichier avec `"`/CR dans le nom + réplication SFTP → pas d'injection.

---

### 7. LOG-REDACT — redaction au niveau du logger (LOW)
**Fichier** : `packages/core/utils/logger.ts` (`#write`, ~L233).

```diff
 import { redact, redactText } from "../lib/redact";
 // dans #write, avant de construire le payload :
+ if (isPlain(meta)) meta = redact(meta, redactKeys());
+ else if (typeof msg === 'string') msg = redactText(msg);
```
**Test** : `logger.info('login', { password: 'x' })` → `password: '[redacted]'` dans le fichier.

---

### 8. G-CHAIN-RECURSION — profondeur max workflow/script (LOW)
**Fichier** : `packages/core/database/workflow.ts` (`run`, ~L397).

```diff
+ const MAX_RECURSION = 32;
+ const depth = Number(requestCtxStorage.get('workflow_depth') ?? 0);
+ if (depth >= MAX_RECURSION) throw new AppError('Workflow recursion limit reached', { code: 'WORKFLOW_RECURSION', status: 429 });
+ requestCtxStorage.set('workflow_depth', depth + 1);
```
**Test** : workflow qui se rappelle récursivement → arrêt à 32.

---

## B. Décisions de conception (à arbitrer avant code)

| Finding | Question à trancher | Piste technique |
| --- | --- | --- |
| **F-01 (HIGH)** | Tenants mutuellement non fiables ou mono-opérateur ? | Si non fiables : secret JWT **par tenant**, séparer les process (Control/Execution Plane), retirer `database.uri` du `cfg` global. Sinon : documenter le modèle. |
| **AUTH-02 (MEDIUM)** | Refresh token rotatif requis ? | Ajouter un refresh token signé + rotation + révocation (ou assumer le modèle stateless 7 j). |
| **G-PROMPT-INJ (MEDIUM)** | Quels tools sont sensibles ? | `approval: true` + `guardrails.tool` sur les tools write/delete/admin ; exposer un `rest` restreint par tool. |
| **G-MEM-POISON (MEDIUM)** | `resource` = identité utilisateur ? | Dériver `resource` de `token.decoded.sub` (ou vérifier l'appartenance dans `server/agents.ts`). |
| **AUTH-05 (MEDIUM)** | Multi-instances en prod ? | Activer `rateLimit.redis` (déjà supporté) pour partager les compteurs. |

---

## C. Déjà appliqués (pour référence — ne pas re-porter)

### G-MCP-EXPOSE / G-MCP-ENUM / G-MCP-AUDIT
`types/mcp.d.ts` + `server/mcp.ts` : authN + tenant claim + `evaluateAccess` par tool/resource + audit (`argsFingerprint`) + rate-limit tenant + 404 générique.

### SOCKET-AUTH / SOCKET-TENANT
`types/websocket.d.ts` + `lib/sockets.ts` : `io.use` auth (token + claim), scoping `socket.data.tenant`, `evaluateAccess` par handler.

**Tests de non-régression** : `bun test packages/core/tests/mcp.test.ts` (6 pass) et tests infra (`security`, `metrics-cluster`, 14 pass).
