# Internal & Administrative Endpoints — Analysis

## `/_dnax/config/:tenant_id`

Fichier : `server/api.ts:972-987`.

### 1. Accessible sans authentification ?
**Non.** Le handler exige un token **vérifié, non expiré et fourni** :
```ts
const t = c.get('token');
if (!t?.decoded || t?.expired || !t?.provided) {
    return c.json({ message: 'Authentication required', code: 'AUTH_REQUIRED' }, 401);
}
```
De plus, le middleware global de rejet des tokens invalides/expirés (`server/hono.ts:514`) s'applique avant. Le préfixe `_dnax` **n'est pas** un mécanisme de protection en soi (correctement traité : la vérification est explicite).

### 2. Permission spécifique requise ?
**Non.** Tout token JWT valide (quel que soit son rôle/tenant) est accepté. Aucun contrôle de rôle administrateur, ni de `api.access`.

### 3. `safePublicConfig()` réellement utilisé ?
**Oui** — `server/api.ts:979` → `server/config.ts:55-112`. C'est la version filtrée (pas la config brute).

### 4. Propriétés exposées
`safePublicConfig()` ne renvoie **pas** : `database.uri`, `jwt.secret`, `encryption.secret/privateKey`, clés, chaînes de connexion.

Elle renvoie :
- `tenants` : `id`, `name`
- `collections` : `_tenant_`, `slug`, `type`, `actions` (liste), `fields` (`name`, `type`, `description`, `required`, `nullable`, `empty`, `relation` (dont `relation.to`), `enumOptions`, `randomOptions`, `defaultValue`, `studio`), `readOnlyFields`, `studio`
- `services` : `_tenant_`, `name`, `enabled`, `actions`
- `fileCollections` : idem collections

### 5. Informations sensibles ?
Pas de secrets. Mais **divulgation de schéma** (noms de collections, noms/types de champs, relations, enum, valeurs par défaut) à tout utilisateur authentifié — utile pour l'énumération et la reconnaissance pré-attaque. `defaultValue` peut, si un développeur y met une valeur sensible, fuiter (smell de config, pas un bug framework).

### 6. Utilisateur non autorisé peut consulter la config d'un autre tenant ?
Le middleware tenant-claim (`server/hono.ts:526-545`) extrait `tenant_id` = `segments[2]` pour `/_dnax/config/…` et rejette si `claim !== tenant_id`. **MAIS** : avec `requireTenantClaim: false` (défaut), un token **sans claim `tenant`** (émis hors login framework) n'est pas rejeté → accès à la config de n'importe quel tenant. C'est le constat **AUTH-01**, confirmé ici.

### 7. Mise en cache et isolation ?
Pas de `Cache-Control` spécifique sur cet endpoint (pas de cache HTTP). La réponse est filtrée par `tenant_id` côté serveur.

## Autres endpoints internes / système
- `/health` (mono) — `server/hono.ts:423`, public (métriques + IP), non rate-limité (constat AUTH-06).
- `/health` (cluster master sur `metricsPort`) — `server/boot.ts:276-289`, public (constat B-02).
- Collections système accessibles en `aggregate` `$lookup` : `_audit_`, `_locks_`, `_workflows_` (constat C-04).

## Conclusion
Aucun endpoint interne n'est exposé **sans authentification** (hors `/health` volontairement public). Le risque principal est :
1. **E-01** — `_dnax/config` accessible à tout token valide (divulgation de schéma), sans rôle admin.
2. **AUTH-01** — cross-tenant possible via token sans claim `tenant` (défaut `requireTenantClaim: false`).
