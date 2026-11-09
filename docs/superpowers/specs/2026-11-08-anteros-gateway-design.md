# Anteros Gateway — reverse proxy passif (design)

- **Date**: 2026-11-08
- **Statut**: proposé, en attente d'approbation
- **Portée**: nouveau paquet `@anteros/gateway` (`packages/gateway/`), contrat de jeton plateforme, configuration et tests. **Aucun changement du core.** Le backend d'auth (utilisateurs, rôles, login) est **hors périmètre** : il est fourni par l'application, ce document fixe le contrat qu'il doit respecter.
- **Décisions déjà prises avec l'utilisateur**: backends séparés, routage par microservice dans le chemin (le segment est aussi le tenant Anteros), secret JWT partagé, un login unique via un backend d'auth, **un seul jeton plateforme**, gateway **passif** (aucun contrôle).

## Terminologie

« Gateway » est le **nom du produit**, pas la description de son rôle. Techniquement, c'est un
**reverse proxy L7 passif** (ou routeur d'ingress) : il transfère les requêtes, il ne les contrôle pas.

Ce n'est **pas** un **API gateway** au sens de Kong, APISIX ou KrakenD : pas d'authentification, pas de
quotas, pas de transformation, pas d'agrégation, pas de découverte de services. Ce n'est pas non plus une
**edge gateway** : le TLS, le WAF et le WebSocket restent à Caddy/Traefik devant.

Le nom `@anteros/gateway` est **retenu**. Il est volontairement prospectif : des fonctionnalités de
contrôle (vérification de jeton, quotas, retries) pourront s'y ajouter. **La v1 n'en a aucune** — la doc
doit décrire un « reverse proxy pour microservices Anteros » et ne jamais laisser croire que l'auth ou les
quotas sont déjà là.

## Contexte et intention

Trois déploiements Anteros indépendants — pharmacie, facturation, stats — doivent être joignables derrière un point d'entrée unique. Aujourd'hui, chaque app expose déjà `POST /api/:tenant_id/<famille>/…`, `/health` et Socket.IO. Le gateway n'a donc pas à réécrire les URLs : il choisit l'upstream à partir du premier segment, qui nomme le microservice **et** le tenant attendu par ce backend.

L'intention est un **routeur L7 minimal**, pas un API management : pas d'authentification, pas de rate limit, pas d'agrégation, pas de réécriture. Le backend d'auth est le seul à connaître les utilisateurs et à signer les jetons ; les backends métier restent les seuls à décider de l'accès.

## Objectifs

- Router `/api/<microservice>/…` vers l'upstream déclaré pour ce microservice, en préservant méthode, chemin, query, en-têtes, corps et flux de réponse.
- Supporter les corps en streaming, les réponses longues et le **SSE** sans bufferisation.
- Être **stateless**, démarrable en un processus Bun, configurable par un fichier TypeScript.
- Échouer proprement : 404 pour un microservice inconnu, 502 pour un upstream injoignable, 504 si les en-têtes de réponse tardent.
- Fournir des logs d'accès utiles (sans jeton ni cookie) et un `/health` local.

## Non-objectifs (v1)

- Vérifier un JWT, authentifier, autoriser, limiter le débit, bloquer une requête : **le gateway ne fait aucun contrôle**.
- Réécrire le chemin, retirer ou ajouter un préfixe, agréger des réponses, mettre en cache.
- Proxifier Socket.IO / WebSocket : `/socket.io/` ne porte pas de microservice, un proxy HTTP ne peut pas l'upgrader. Voir la recette Caddy plus bas.
- Découverte de services, load balancing interne, retries, circuit breaker (v2 si le besoin existe).
- Terminer TLS : Caddy/Traefik devant.
- Construire le backend d'auth, provisionner les utilisateurs ou synchroniser les rôles existants des trois applications.

## Évolutions prévues (hors v1)

Le nom « gateway » anticipe ces ajouts, qui ne font pas partie de cette livraison : vérification JWT au
bord, quotas/rate limit par microservice, retries et circuit breaker, découverte de services, proxy
WebSocket. Chacun fera l'objet d'un design séparé.

## Anti-objectifs

- Un gateway qui signe, vérifie ou rafraîchit des jetons.
- Un gateway qui décide quel utilisateur voit quoi : cette décision appartient aux backends et à leurs règles `api.access`.
- Exposer les backends directement sur Internet « puisque le gateway est devant » : le gateway n'est pas une frontière de sécurité.

## Contraintes du dépôt

- `server/hono.ts` vérifie la signature du jeton puis refuse un `tenant` claim différent du tenant de l'URL ; un jeton **sans** claim tenant est accepté tant que `server.jwt.requireTenantClaim` n'est pas `true` (défaut `false`). Le cas est couvert par `tests/jwt-tenant.test.ts`.
- `utils/func.ts` signe et vérifie en **HS256** avec `server.jwt.secret` ou `JWT_SECRET` — pas de JWKS.
- Une action de collection `login` **injecte** `tenant: tenant_id` dans le jeton (`server/api.ts`). Le backend d'auth ne doit donc pas utiliser `api.auth.onLogin` pour émettre le jeton plateforme.
- Sans règles `api.access`, l'accès est **refusé** (`server/access.ts`) ; une règle booléenne `true` autorise **sans jeton**. Les collections protégées doivent utiliser des règles fonction.
- Le log d'accès du core expose `sub` comme `user_id` (`server/hono.ts`) : le jeton plateforme est donc correctement attribué dans les traces.
- Le core génère son propre `traceId` par requête et **ne lit pas** `x-request-id`.
- Socket.IO est servi sur `/socket.io/` hors Hono (`server/boot.ts`) ; `/health` existe déjà dans l'app Hono.
- Le dépôt privilégie les paquets opt-in séparés (`@anteros/reco`, `@anteros/duckdb`), avec Bun + TypeScript et des tests `bun test`.

## Architecture retenue

```text
Client
  │ HTTPS
  ▼
Caddy / Traefik                 TLS, éventuellement WAF et WebSocket
  │ HTTP privé
  ▼
@anteros/gateway                routeur L7, aucun contrôle
  ├─ /api/auth/…          → http://auth:4000/api/auth/…
  ├─ /api/pharmacie/…     → http://pharmacie:4000/api/pharmacie/…
  ├─ /api/facturation/…   → http://facturation:4000/api/facturation/…
  └─ /api/stats/…         → http://stats:4000/api/stats/…
                                    │
                                    ├─ auth          : users, login, émission du jeton plateforme  (hors périmètre)
                                    ├─ pharmacie     : vérifie le jeton + rôles du tenant
                                    ├─ facturation   : idem
                                    └─ stats         : idem
```

### Routage

- Seule forme routée : `/api/<microservice>/<reste>` (toutes méthodes, query conservée).
- Table `microservice → URL d'upstream`, déclarée dans la config. Pas de wildcard, pas de regex, pas d'upstream fourni par le client.
- Upstream construit : `new URL(path + search, upstreamBase)`. Le chemin est **préservé** ; aucun préfixe n'est ajouté ou retiré.
- **`microservice` est le nom du déploiement et le premier segment de l'URL ; il doit être l'identifiant de tenant Anteros attendu par ce backend**, puisque le chemin n'est pas réécrit. `pharmacie` dans la config ⇒ `/api/pharmacie/…` sur le backend `pharmacie`.
- Microservice inconnu → `404 { code: "MICROSERVICE_NOT_FOUND" }`, sans appel upstream.
- `/health` → réponse locale `{ status: "ok", microservices }`.
- Tout le reste → 404 local.

### Comportement du proxy

- Transmet : méthode, chemin, query, corps, `authorization`, `cookie`, `content-type`, en-têtes applicatifs.
- Retire les en-têtes **hop-by-hop** dans les deux sens : `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`, et `host`.
- Ajoute : `x-forwarded-for` (IP cliente), `x-forwarded-proto`, `x-forwarded-host`, `x-request-id` (réutilise l'entrant s'il existe).
- Corps en streaming (`duplex: "half"` côté Bun), réponse en streaming (`new Response(upstream.body, …)`).
- Aucune compression ajoutée ; le SSE doit passer octet pour octet.
- `redirect: "manual"` : un 3xx est relayé tel quel.
- `OPTIONS` est relayé (préflight CORS géré par le backend).
- **Timeout sur l'arrivée des en-têtes upstream** (`timeoutMs`, défaut 30 s) : il couvre la connexion et le temps jusqu'aux en-têtes de réponse, **pas le corps**. Un flux SSE ou un gros téléchargement vit ensuite tant qu'un des côtés le maintient. Dépassement → 504.
- Upstream en échec (connexion refusée, DNS) → 502. Aucun retry.
- **CORS opt-in** : absent/`false` = pass-through. Sinon le gateway répond au préflight localement, applique la politique et **retire les en-têtes `access-control-*` de l'upstream** (deux `Access-Control-Allow-Origin` font rejeter la réponse par le navigateur). `credentials: true` est refusé avec `origins: "*"`. **Surcharge par microservice** : `microservice.cors` (objet ou `false`) → `cors` global → pass-through ; un 404 utilise le global.
- Logs : `timestamp` (ISO 8601, début de la requête), `level` (`error` sur 5xx, sinon `info`), `logger` (`logging.name`), `logging.fields` statiques, méthode, microservice, upstream, statut, durée, `x-request-id`. **Jamais** `authorization`, `cookie` ni corps **par défaut** ; `logging.captureBody` (opt-in) ajoute `requestBody` depuis `request.clone()`, avec `maxBytes`, méthodes/types textuels et redaction récursive des clés sensibles. Stockage : `logging.engine` = `stdout` (défaut), `file` (JSONL dans `.logs/gateway.log`) ou `duckdb` (table `logs` dans `.logs/gateway.duckdb`) ; le moteur fichier accepte `rotate` (`size`/`hourly`/`daily`/`weekly`/`monthly`/`yearly`), `maxSize`, `maxFiles` et `compress` ; DuckDB accepte `ttl` (rétention), `purgeEvery` (défaut 1h) et `purgeOnStart` (DELETE des lignes plus anciennes) ; un sink qui jette est avalé (stderr) et ne casse pas la requête ; `stop()` asynchrone pour flush. Périmètre configurable : `logging.enabled` (défaut `true`) et `logging.microservices` (`"*"` par défaut, ou une liste de noms). Un 404 n'a pas de microservice : il n'est loggé que si le périmètre est `"*"`.

### Contrat du jeton plateforme

Émis par le backend d'auth, signé HS256 avec le `JWT_SECRET` partagé :

```json
{
  "sub": "usr_123",
  "roles": {
    "pharmacie": ["admin"],
    "facturation": ["reader"],
    "stats": ["reader"]
  },
  "iss": "auth",
  "aud": "anteros-platform",
  "iat": 1730000000,
  "exp": 1730000900
}
```

- **Aucun** des claims `tenant`, `_tenant_`, `tenant_id` : c'est ce qui permet au même jeton d'être accepté sur les trois backends.
- `roles` est indexé par le slug de tenant du backend — qui est aussi le nom du microservice dans cette configuration. Chaque backend ne lit que sa propre entrée.
- TTL décidé par le backend d'auth (15 min recommandé), **pas par le gateway**. Pas de rafraîchissement serveur en v1 : à l'expiration, le client se reconnecte. Pas de révocation serveur (jeton stateless) — un TTL court est la seule limite.
- Le backend d'auth émet ce jeton depuis une **action de service** (ou une route), pas depuis `api.auth.onLogin`, qui ajouterait un claim `tenant`.
- L'émission, les utilisateurs et le provisioning des `roles` relèvent du backend d'auth (hors périmètre).

Exemple indicatif (l'API exacte de `define.Service` reste à caler côté application) :

```ts
const token = await jwt.sign(
  { sub: user.id, roles: user.roles },
  { expiresIn: "15m", issuer: "auth", audience: "anteros-platform" },
);
```

### Contrat des backends métier

- Même `JWT_SECRET` sur les quatre déploiements ; `server.jwt.requireTenantClaim` laissé à `false`.
- Hono vérifie la signature et l'expiration ; le jeton sans claim tenant est accepté sur toutes les routes.
- **Chaque collection protégée doit déclarer une règle fonction** qui lit `token.decoded.roles[rest.tenant_id]` :

```ts
api: {
  access: {
    "*": ({ token, rest }) => {
      const roles = (token.decoded?.roles as Record<string, string[]> | undefined)?.[rest.tenant_id] ?? [];
      return roles.includes("admin") || roles.includes("reader");
    },
  },
}
```

- Interdits pour une collection protégée : `access: { "*": true }` (autorise **sans** jeton) et l'absence de règle (refus, mais l'erreur est plus obscure).
- Les routes de login des backends métier deviennent inutiles : le seul login est celui du backend d'auth.
- `trustProxy: true` sur les backends, pour que l'IP cliente soit celle du `x-forwarded-for` du gateway.
- Pour corréler de bout en bout, ajouter un middleware applicatif qui lit `x-request-id` (le core génère sinon son propre `traceId`) ; sans ce middleware, la corrélation reste côté gateway.

## Temps réel et WebSocket

Le gateway ne proxifie pas `/socket.io/`. Si le temps réel est nécessaire, exposer dans Caddy un **host dédié** qui ne route **que** `/socket.io/*` vers le backend et renvoie 404 pour tout le reste — le REST du backend reste ainsi privé. Sans ce besoin, aucune exposition supplémentaire : le gateway reste l'unique entrée HTTP.

## Modèles de jeton considérés

| Modèle | Décision | Raison |
| --- | --- | --- |
| Trois jetons (un par tenant) | écarté | isolation intacte, mais le client gère trois jetons ; l'utilisateur veut un seul jeton. |
| Jeton multi-tenant (`tenants: [...]`) | écarté | aurait exigé une évolution du core et une nouvelle sémantique de sécurité. |
| **Jeton plateforme sans claim tenant** | **retenu** | aucun changement du core, gateway passif, un seul jeton ; l'autorisation par tenant repose entièrement sur `api.access`. |

## Approches d'implémentation considérées

| Approche | Décision | Compromis |
| --- | --- | --- |
| **Paquet `@anteros/gateway` dédié (Bun + Hono)** | **retenu** | un composant et un hop de plus, mais routeur typé, testable, indépendant des apps. |
| Gateway comme app Anteros (routes proxys dans un tenant) | écarté | embarque Mongo, le boot, l'audit et les tenants pour un simple proxy ; config moins directe. |
| Caddy/Traefik seuls | écarté comme gateway applicatif | excellent pour TLS/WS/load balancing, mais aucune notion de microservice Anteros ni de table `microservice → upstream` versionnée dans le dépôt. Caddy reste **devant** pour TLS et WebSocket. |

## Sécurité — à lire avant de déployer

- **Le jeton plateforme ouvre tous les tenants de tous les backends qui partagent le secret.** La seule barrière par tenant est la règle `api.access`. Une collection protégée sans règle fonction, ou avec `true`, est exposée à tout porteur d'un jeton valide.
- **Le secret est symétrique et partagé** : un backend compromis peut forger des jetons plateforme. Tous les backends sont également de confiance ; c'est le prix du HS256 partagé.
- **Pas de révocation** : un jeton volé reste valide jusqu'à `exp`. D'où le TTL court.
- Rotation du secret : les quatre déploiements doivent changer **ensemble** ; prévoir une fenêtre ou un mécanisme double-secret (hors v1).
- Le gateway **n'est pas une frontière de sécurité** : les backends doivent être sur un réseau privé, et le gateway exposé uniquement derrière TLS.
- Ne jamais logguer `authorization`, `cookie`, ni le corps. `x-request-id` suffit à corréler côté gateway.
- CORS : le gateway ne l'ajoute pas ; chaque backend doit autoriser l'origine du frontend, et le préflight `OPTIONS` est relayé.

## Configuration et paquet

`packages/gateway/`, paquet `@anteros/gateway`, version `0.0.1`, Bun, dépendance `hono`.

```ts
import { defineGateway } from "@anteros/gateway";

export default defineGateway({
  port: 8080,
  microservices: [
    { name: "auth", upstream: "http://auth:4000" },
    { name: "pharmacie", upstream: "http://pharmacie:4000" },
    { name: "facturation", upstream: "http://facturation:4000" },
    { name: "stats", upstream: "http://stats:4000" },
  ],
  timeoutMs: 30_000,
});
```

`name` est le segment `/api/<name>/…` **et** le tenant Anteros attendu par le backend. Le tableau (plutôt qu'une map) laisse la place à des options par microservice plus tard : timeout, en-têtes statiques.

- `createGateway(config)` → `{ server, stop() }`, testable sans fichier.
- Binaire `anteros-gateway ./gateway.config.ts` (bunx / `bin`).
- Surcharges d'environnement : `GATEWAY_PORT`, URLs par microservice (optionnel).
- `/health` local, sans vérifier les upstreams (le gateway ne doit pas devenir un superviseur).
- Logs JSON structurés sur stdout ; pas de dépendance logger du core.

## Tests

Tests `bun test` avec des upstreams factices (`Bun.serve`, port 0) :

1. route par microservice, chemin et query préservés ;
2. méthode, corps et en-têtes transmis, `authorization` inclus ;
3. en-têtes hop-by-hop retirés dans les deux sens ;
4. réponse SSE lue en streaming (premier chunk avant la fin de l'upstream) et non coupée par `timeoutMs` ;
5. microservice inconnu → 404 sans appel upstream ;
6. upstream arrêté → 502 ; upstream lent à envoyer ses **en-têtes** → 504 ;
7. `OPTIONS` relayé ;
8. `x-request-id` conservé s'il est fourni, généré sinon ;
9. requête **sans** jeton relayée telle quelle — preuve que le gateway ne contrôle rien ;
10. `/health` local.

Le comportement du jeton sans claim tenant est déjà couvert par `packages/core/tests/jwt-tenant.test.ts` (`requireTenantClaim` désactivé → accepté ; activé → `TENANT_CLAIM_REQUIRED`). Aucun test core supplémentaire n'est livré.

## Livrables

- `packages/gateway/` : `index.ts`, `lib/`, `types/`, `tests/`, `README.md`, `tsconfig.json`, `package.json`, `bin/`.
- `docd/content/docs/07.packages/03.gateway.md` : configuration, routage, limites, sécurité, contrat du jeton, recette Caddy pour le temps réel.
- Ligne dans le tableau des paquets du README racine, entrée `[Unreleased]` du changelog.
- `.memory/gateway.md` : décisions, pièges (Socket.IO, jeton sans tenant, `access: true`, timeout), preuves.

## Ce qui reste à décider par le builder

- Découpage exact des fichiers (`lib/router.ts`, `lib/proxy.ts`, `lib/config.ts`).
- Forme des types de config et de `defineGateway` (identité typée).
- Choix de relayer ou non `x-forwarded-*` déjà présents (proposition : les compléter, ne pas les écraser).
- Format exact des logs et des métriques (v1 : logs seulement).
- Nom du binaire et mode de chargement du fichier de config.

## Vérification de la livraison

- `bun test` du paquet : les 10 cas ci-dessus verts.
- `bunx tsc --noEmit -p packages/gateway/tsconfig.json` propre.
- Scénario réel : deux upstreams factices + un `JWT_SECRET`, un jeton plateforme signé sans claim tenant traverse le gateway, l'upstream reçoit l'`authorization` intact et répond ; un microservice inconnu ne touche aucun upstream.
- `bun run generate` dans `docd` : page `/docs/packages/gateway` préréndue, aucun lien mort.
