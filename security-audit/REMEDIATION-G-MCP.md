# Remediation — G-MCP-EXPOSE

> **Statut : APPLIQUÉ (code modifié) — validation tests en attente.** Le finding n'est pas déclaré « corrigé » tant que les tests staging ne sont pas passés.

## Objectif
Rendre l'endpoint MCP (`GET/POST /api/:tenant_id/mcp`) **authentifié**, **isolé par tenant** et **autorisé par tool/resource**, en réutilisant les primitives existantes (`evaluateAccess`, `getAccessToken`, tenant-claim).

## 1. Authentification + isolation tenant (handler global)

Fichier : `server/mcp.ts` (fonction `initializeMcp`, handler `app.all(patterns.mcp, …)`).

Ajouter, **avant** la construction du serveur MCP :

```ts
app.all(patterns.mcp, async (c) => {
    const tenantId = c.req.param('tenant_id') ?? '';

    // 1. Rejeter les requêtes anonymes, invalides ou expirées (même logique que /_dnax/config)
    const token = c.get('token') as { decoded: Record<string, unknown> | null; expired?: boolean; provided?: boolean } | undefined;
    if (!token?.decoded || token?.expired || !token?.provided) {
        return c.json({ message: 'Authentication required', code: 'AUTH_REQUIRED' }, 401);
    }

    // 2. Isolation tenant : le tenant authentifié (claim) doit correspondre au tenant de l'URL
    const claim = token.decoded['tenant'] ?? token.decoded['_tenant_'] ?? token.decoded['tenant_id'];
    if (claim !== undefined && String(claim) !== tenantId) {
        return c.json({ message: 'Token does not belong to this tenant', code: 'TENANT_MISMATCH' }, 401);
    }
    if (cfg.server.jwt?.requireTenantClaim === true && claim === undefined) {
        return c.json({ message: 'Tenant claim required', code: 'TENANT_CLAIM_REQUIRED' }, 401);
    }

    const tools = toolsByTenant.get(tenantId) ?? [];
    const resources = resourcesByTenant.get(tenantId) ?? [];
    // G-MCP-ENUM : réponse générique, sans écho de tenant_id ni de configuration
    if (!tools.length && !resources.length) {
        return c.json({ error: 'Not found' }, 404);
    }

    const server = buildServer(tenantId, tools, resources, c);
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
});
```

## 2. Types : `api.access` sur `McpTool` / `McpResource`

Fichier : `types/mcp.d.ts`.

Ajouter un champ optionnel `api` :

```ts
export type McpAccessContext = {
    rest: InstanceType<typeof useRest>;
    error: typeof fn.error;
    jwt: typeof jwt;
    token: { value: string | null; decoded: Record<string, unknown> | null; provided: boolean; expired: boolean };
    tenant: string;
    tool?: string;   // tools/call
    resource?: string; // resources/read
    args?: Record<string, any>;
    uri?: string;
};

// McpTool
api?: {
    access?: {
        call?: boolean | ((ctx: McpAccessContext) => boolean | Promise<boolean>);
        '*'?: boolean | ((ctx: McpAccessContext) => boolean | Promise<boolean>);
    };
};
// McpResource
api?: {
    access?: {
        read?: boolean | ((ctx: McpAccessContext) => boolean | Promise<boolean>);
        '*'?: boolean | ((ctx: McpAccessContext) => boolean | Promise<boolean>);
    };
};
```

## 3. Autorisation par tool / resource

Fichier : `server/mcp.ts` (fonction `buildServer` — signature passe à `buildServer(tenantId, tools, resources, c)` ; importer `evaluateAccess` depuis `./access`).

Dans `CallToolRequestSchema` (après validation Joi, avant `tool.exec`) :

```ts
const rest = new useRest({ tenant_id: tenantId });
await evaluateAccess(tool.api?.access as any, 'call', rest, `mcp:${tool.name}`, c, {
    tenant: tenantId, tool: tool.name, args: value,
});
const result = await tool.exec({ c, rest, args: value, agents: createAgents(tenantId, rest), api: createApi(rest) });
```

Dans `ReadResourceRequestSchema` (après `matchUri`, avant `resource.read`) :

```ts
const rest = new useRest({ tenant_id: tenantId });
await evaluateAccess(resource.api?.access as any, 'read', rest, `mcp:${resource.name}`, c, {
    tenant: tenantId, resource: resource.name, uri,
});
```

> `evaluateAccess` (no rule = denied) garantit : sans `api.access`, `tools/call` et `resources/read` sont refusés (401). `tools/list` / `resources/list` restent « authentifié seulement » (le listing est de la métadonnée, pas une exécution).

## 4. Audit (G-MCP-AUDIT)

Fichier : `server/mcp.ts`.

Après chaque exécution, écrire un événement d'audit structuré (args **jamais en clair** — empreinte) :

```ts
await rest.audit.log({
    action: 'mcp.tools/call',
    collection: tool.name,
    input: { tenant: tenantId, tool: tool.name, argsFingerprint: sha256(JSON.stringify(value)) },
    result: { isError: !!isError },
    error: isError ? { message: '<redacted>', code: 'MCP_TOOL_ERROR' } : undefined,
    duration,
});
```

Champs requis : principal (`token.decoded.sub` ou `"anonymous"`), tenant, tool/resource, timestamp (auto), succès/échec, correlation id (`trace.id`), hash des args.

## 5. Rate limiting

- **Global/IP** : déjà couvert (`server/hono.ts:441`, 100/min). Conserver.
- **Par tenant authentifié** : ajouter `app.use(patterns.mcp, rateLimit({ keyGenerator: c => `mcp:${c.get('token')?.decoded?.tenant ?? c.get('clientIp')}`, max: 300/min }))` avant `initializeMcp`.
- **Par tool** : nécessite le parsing du corps JSON-RPC ; proposer une limite par tenant (suffisant en première passe), à affiner si un tool coûteux est exposé.
- **Concurrence** : le `rateLimit` existant compte les requêtes ; ajouter un timeout/limite au niveau `tool.exec` (déjà possible via le `signal`).

## 6. Identité d'exécution (après correctif)
- MongoDB : connexion du tenant (inchangée) ; l'identité MongoDB effective reste **NOT_VERIFIED** (config URI) — à durcir séparément (compte DB dédié par tenant, moindre privilège).
- `internal` : reste un drapeau d'audit (non modifié).

## Validation
Voir `MCP-SECURITY-TEST-PLAN.md`. Le finding ne sera marqué « corrigé » qu'après validation des tests sur staging.
