# Remediation — SOCKET-AUTH / SOCKET-TENANT (appliquée)

> Statut : **APPLIQUÉ** — validation tests en attente.

## Findings corrigés
- **SOCKET-AUTH (HIGH)** : connexions Socket.IO sans authentification, handlers avec `rest` tenant complet.
- **SOCKET-TENANT (MEDIUM)** : `/socket.io/` global déclenchait tous les handlers de tous les tenants.

## Correctif appliqué

### 1. Types (`types/websocket.d.ts`)
Ajout de `WebSocketAccessContext`, `WebSocketAccess` et `api.access` sur `WebSocketHandler` (même contrat que agents/MCP : `connect` ou `*`).

### 2. Authentification + isolation tenant (`lib/sockets.ts`)
- **Middleware `io.use`** (`registerSocketAuth`, enregistré au boot) :
  - exige un token (`socket.handshake.auth.token` ou `query.token`) ;
  - vérifie via `func.jwt.verify` (rejet invalide/expiré) ;
  - vérifie le tenant claim (`requireTenantClaim` + correspondance `claim` vs `tenant` demandé) ;
  - stocke `socket.data.token` / `rawToken` / `tenant`.
- **Scoping tenant** : chaque handler n'est exécuté que si `socket.data.tenant === tenant.id` (une connexion ne déclenche plus tous les tenants).
- **Autorisation par handler** : `evaluateAccess(handler.api?.access, 'connect', …)` avant `handler.exec` — **no rule = denied**.

### 3. Comportement résultant
- Connexion sans token → rejetée (`AUTH_REQUIRED`).
- Token tenant A sur tenant B → rejetée (`TENANT_MISMATCH`).
- Handler sans `api.access` → `Access denied` + déconnexion.
- Handler avec `api.access.connect = true` (ou `*`) → exécuté (utilisateur authentifié du tenant).

## Rupture de compatibilité
- Les clients Socket.IO doivent désormais se connecter avec `io(url, { auth: { token, tenant } })`.
- Tout handler `.ws.ts` existant sans `api.access` est **refusé** (secure-by-default) — ajouter `api: { access: { connect: true } }` (ou une règle) pour l'activer.

## Validation
Voir `MCP-SECURITY-TEST-PLAN.md` (mêmes scénarios, transposés à WebSocket) : connexion anonyme, token invalide/expiré, cross-tenant, sans `api.access`, avec `api.access`.
