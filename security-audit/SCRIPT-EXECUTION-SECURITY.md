# Script Execution & Code Execution Security

## Modèle de confiance (frontière)

Le code exécuté par Anteros provient **exclusivement du filesystem**, déployé par l'opérateur avec l'application. Il n'est **jamais** fourni par un client HTTP.

- Collections → `{tenant.dir}/collections/**/*.model.ts`
- Services → `{tenant.dir}/services/**/*.service.ts`
- Scripts → `{tenant.dir}/scripts/**/*.run.ts`
- Workflows → `{tenant.dir}/workflows/**/*.workflow.ts`
- Routes → `{tenant.dir}/routes/**/*.route.ts`
- Middlewares → `middlewares/**/*.middleware.ts` (global) et `{tenant.dir}/middlewares/` (tenant)
- Agents/tools → `{tenant.dir}/agents/`, `{tenant.dir}/mcp/`

Chargement : `import(file)` au boot (`lib/load.ts`, `lib/scripts.ts`, `lib/workflow.ts`, `lib/services.ts`, `lib/middleware.ts`…).

## Réponse aux investigations obligatoires

| Question | Réponse |
| --- | --- |
| Qui peut déclarer le code ? | L'opérateur (fichiers sur disque). Pas les clients API. |
| Qui peut le modifier ? | L'opérateur (accès filesystem). |
| Qui peut le déclencher ? | Scripts : boot (ou `runScripts`). Workflows : `rest.workflow(id).run()` (pas de route HTTP directe). Services/actions : route HTTP (protégée `evaluateAccess`) ou code interne. |
| Sous quelle identité ? | Processus serveur (`internal: true`). Aucune identité utilisateur OS distincte. |
| Quels privilèges ? | Tous ceux du processus (FS, réseau, env, DB). Aucun sandbox. |
| Quelles ressources ? | `process.env` complet, `cfg` global (tous les tenants), filesystem, réseau. |
| Isolation/limites ? | Heavy scripts : subprocess + timeout optionnel. Workflows : timeout/retries/backoff par étape. **Aucune** limite CPU/mémoire pour les scripts non-heavy. |

## Résultat RCE

**Aucun vecteur d'exécution de code à distance depuis un client.** Recherche `eval(`, `new Function`, `Function(`, `node:vm`, `runInContext`, `compileFunction` dans le core : **aucun résultat** (seuls des noms de fonctions DuckDB contiennent « Function( »).

- Les handlers de workflow (`stepDef.exec`), services (`actions[action]`), actions collection (`col.actions[action]`) sont des **références de fonctions déclarées**, pas des chaînes évaluées.
- `runAction`/`runService` vérifient que l'action **existe** dans la définition (`Object.hasOwn`) avant invocation.
- Le `data` utilisateur est passé en paramètre à une fonction de confiance ; la fonction est responsable de sa propre validation.

## Constats

| ID | Constat | Criticité | Statut |
| --- | --- | --- | --- |
| F-01 | **Pas d'isolation tenant au niveau code** : processus partagé, `cfg` global (contient tous les `database.uri` des tenants), `process.env` partagé (JWT_SECRET HS256 commun). Un code d'un tenant peut lire la config/les secrets d'un autre tenant et forger des tokens. | MEDIUM | CONFIRMED |
| F-02 | `runHeavyScript` passe `process.env` **complet** au sous-processus (`env: {...process.env}`) | LOW | CONFIRMED |
| F-03 | Scripts/services/actions/hooks/workflows exécutés avec `internal: true` + accès DB complet (pas de contrôle d'accès) — par conception (code de confiance) | INFO | CONFIRMED |
| F-04 | Scripts non-heavy sans timeout/limite CPU/mémoire (exécutés in-process) ; heavy = timeout optionnel seulement | LOW | CONFIRMED |

## Contrôles positifs
- Pas d'`eval`/`new Function`/`vm` (RCE client impossible).
- Workflows : `validateWorkflowContext` (coercition/validation), timeout + retries/backoff + `AbortController`, verrou distribué + compensation (saga).
- Heavy scripts : subprocess séparé, timeout hard (kill), config tenant via **stdin** (pas argv → pas de fuite dans `ps`).
- Chaque `rest` est lié au `tenant_id` de son contexte.
