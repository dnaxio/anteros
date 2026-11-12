# G-MCP-ENUM — Oracle d'énumération de tenants MCP

- **Statut** : CONFIRMED
- **Sévérité** : LOW
- **Confiance** : HIGH
- **Fichier** : `server/mcp.ts:199-201`

## Constat
Le message d'erreur `No MCP tools or resources for tenant '${tenantId}'` est renvoyé en **404** pour un tenant inexistant **et** pour un tenant existant sans tools. En revanche, un tenant **avec** tools passe au serveur MCP et produit une réponse de protocole MCP (JSON-RPC / SSE) différente. Un attaquant peut donc distinguer, par statut/corps/taille, quels `tenant_id` disposent de tools MCP.

## Impact
Énumération des tenants exposant des tools MCP — facilite le ciblage de G-MCP-EXPOSE. Divulgation de l'identifiant demandé dans la réponse.

## Remédiation
Réponse **générique** (ex. 404 sans écho de `tenant_id` ni d'indication de configuration). Cette mesure ne remplace **pas** l'authentification/autorisation (G-MCP-EXPOSE).

## Relation
Découle de G-MCP-EXPOSE (le correctif principal supprime le vecteur). À ne pas fusionner : c'est une faiblesse d'information distincte.
