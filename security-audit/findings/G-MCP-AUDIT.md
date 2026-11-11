# G-MCP-AUDIT — Absence de traçabilité d'audit des appels MCP

- **Statut** : CONFIRMED
- **Sévérité** : LOW
- **Confiance** : HIGH
- **Fichier** : `server/mcp.ts:77-116` (tools/call), `server/mcp.ts:146-171` (resources/read)

## Constat
Les handlers MCP journalisent via `logger.file(...)`/`logger.info/warn` (fichier de log), mais **n'écrivent pas** dans la collection `_audit_` (`rest.audit.log` / `addActivities`). Aucun événement d'audit structuré ne trace :
- l'identité de l'appelant (ou l'anonymat) ;
- le tenant, le tool, l'horodatage, le succès/échec, l'id de corrélation.

Les opérations DB réalisées *à l'intérieur* d'un tool via `rest.*` sont auditées (comme `internal:false`, sans token), mais l'invocation MCP elle-même (nom du tool, arguments, résultat) ne l'est pas.

## Impact
Traçabilité insuffisante des actions sensibles effectuées par MCP (détection d'abus, forensic, conformité). Aggravé par l'anonymat (G-MCP-EXPOSE).

## Remédiation
Appeler `rest.audit.log({ action: 'mcp.tools/call', collection: <tool>, input: { tenant, tool, argsFingerprint }, ... })` pour chaque `tools/call` et `resources/read`. Ne **jamais** journaliser les arguments en clair s'ils peuvent contenir des données personnelles ou secrets (empreinte/rédaction).

## Relation
Conséquence de l'absence de contrôle (G-MCP-EXPOSE). Finding distinct (traçabilité), à ne pas fusionner.
