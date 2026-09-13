export const v13HelpProcedures = [
  {
    id: "ADM-V13-INTEGRATION-001", version: 1, title: "Créer et sécuriser une connexion externe", description: "Créer une connexion Google, Microsoft, n8n ou LDAP/Active Directory sans stocker de secret dans la configuration.",
    roles: ["admin"], contexts: ["admin", "integrations", "security"], permissions: [{ object: "integration", action: "administer" }], prerequisites: ["COM-CNX-001"], tags: ["integration", "oauth", "credential", "ldap", "n8n"],
    steps: [
      { title: "Choisir le fournisseur", instruction: "Créer la connexion depuis Integration Manager et activer uniquement les capacités nécessaires.", expected: "La connexion est créée dans le tenant courant avec un propriétaire administrateur." },
      { title: "Configurer sans secret", instruction: "Renseigner clientId, URL, base DN ou options techniques dans la configuration. Ne jamais y placer token, password ou secret.", expected: "Les clés sensibles sont refusées côté serveur." },
      { title: "Enregistrer le credential", instruction: "Utiliser le champ credential dédié pour client_secret, webhook_secret ou bind_password.", expected: "La valeur est chiffrée dans integration_credentials et n'est jamais retournée par l'API." },
      { title: "Tester", instruction: "Lancer Tester avant toute synchronisation.", expected: "Le Health Center enregistre le résultat et un correlationId." },
    ], result: "La connexion est prête sans exposer les secrets dans la configuration, les logs ou le navigateur.",
  },
  {
    id: "ADM-V13-OAUTH-001", version: 1, title: "Autoriser Google Workspace ou Microsoft 365", description: "Exécuter le flux OAuth2 PKCE d'une connexion administrée.",
    roles: ["admin"], contexts: ["admin", "integrations", "oauth"], permissions: [{ object: "integration_authorization", action: "administer" }], prerequisites: ["ADM-V13-INTEGRATION-001"], tags: ["oauth2", "pkce", "google", "microsoft"],
    steps: [
      { title: "Vérifier les capacités", instruction: "Contrôler les capacités/scopes demandés avant de lancer l'autorisation.", expected: "Seuls les scopes nécessaires aux capacités choisies sont demandés." },
      { title: "Autoriser", instruction: "Cliquer sur Autoriser OAuth puis terminer le consentement chez le fournisseur.", expected: "State, nonce et PKCE sont vérifiés et expirent automatiquement." },
      { title: "Revenir dans Clarity", instruction: "Après le callback, relancer Tester.", expected: "La connexion passe à connected si les credentials sont valides." },
    ], result: "Les tokens sont stockés chiffrés et renouvelés par le moteur d'intégration existant.",
  },
  {
    id: "ADM-V13-SYNC-001", version: 1, title: "Configurer mappings et synchronisations", description: "Définir la ressource, la direction, la cible Clarity et la politique de conflit avant synchronisation.",
    roles: ["admin"], contexts: ["admin", "integrations", "sync", "mapping"], permissions: [{ object: "integration_sync", action: "administer" }], prerequisites: ["ADM-V13-INTEGRATION-001"], tags: ["mapping", "sync", "checkpoint", "conflict"],
    steps: [
      { title: "Choisir la ressource", instruction: "Utiliser mail, calendar, contacts, files, directory.users ou directory.groups selon le fournisseur.", expected: "Une ressource non prise en charge est refusée par le connecteur." },
      { title: "Définir le mapping", instruction: "Choisir clarityType, direction et conflictPolicy. Utiliser external_wins uniquement si le fournisseur doit piloter les champs mappés.", expected: "Le mapping reste versionné par état courant et audité." },
      { title: "Synchroniser", instruction: "Lancer une synchronisation manuelle ou activer syncPolicy avec intervalMinutes et resources.", expected: "Les jobs passent par automation_jobs et le worker existant." },
      { title: "Contrôler", instruction: "Lire le run dans Health Center : reçu, créé, mis à jour, ignoré et échec.", expected: "Chaque anomalie dispose d'un code et d'un correlationId." },
    ], result: "Les données externes sont normalisées vers CRM, Inbox ou Planning sans moteur métier parallèle.",
  },
  {
    id: "HELP-V13-CHECKPOINT-001", version: 1, title: "Reprendre après un checkpoint ou delta token invalide", description: "Réinitialiser uniquement l'état incrémental concerné sans supprimer la connexion.",
    roles: ["admin"], contexts: ["troubleshooting", "integrations", "checkpoint"], prerequisites: ["ADM-V13-SYNC-001"], tags: ["checkpoint", "delta", "historyId", "syncToken", "recovery"],
    steps: [
      { title: "Identifier la ressource", instruction: "Dans Health Center, relever la ressource et le code d'erreur du run.", expected: "La panne est limitée à une connexion et une ressource." },
      { title: "Réinitialiser", instruction: "Utiliser Réinitialiser checkpoint pour cette ressource uniquement.", expected: "Le curseur durable est supprimé et l'action est auditée." },
      { title: "Relancer", instruction: "Lancer une synchronisation manuelle.", expected: "Le fournisseur repart d'un état initial sans supprimer les liens Clarity existants." },
      { title: "Vérifier l'idempotence", instruction: "Contrôler created/updated/skipped et les liens de ressources.", expected: "Les objets déjà connus sont réconciliés plutôt que dupliqués." },
    ], result: "La reprise incrémentale reste ciblée, traçable et non destructive.",
  },
  {
    id: "ADM-V13-N8N-001", version: 1, title: "Configurer un webhook n8n signé", description: "Déclencher n8n via HTTPS avec protection SSRF et signature HMAC.",
    roles: ["admin"], contexts: ["admin", "integrations", "n8n", "webhook"], prerequisites: ["ADM-V13-INTEGRATION-001"], tags: ["n8n", "hmac", "ssrf", "webhook"],
    steps: [
      { title: "Configurer l'URL", instruction: "Utiliser une URL HTTPS publique ou une cible explicitement autorisée par la politique de déploiement.", expected: "DNS et adresses privées/réservées sont contrôlés avant envoi." },
      { title: "Définir le secret", instruction: "Enregistrer webhook_secret dans le coffre de credentials.", expected: "Le secret n'apparaît pas dans configuration ou Health Center." },
      { title: "Déclencher", instruction: "Utiliser l'action dispatch avec un payload sans clé sensible.", expected: "La requête porte une signature HMAC horodatée et ne suit pas de redirection arbitraire." },
    ], result: "n8n reçoit un événement vérifiable sans affaiblir les contrôles webhooks existants.",
  },
  {
    id: "ADM-V13-LDAP-001", version: 1, title: "Configurer LDAP / Active Directory en lecture seule", description: "Synchroniser des utilisateurs et groupes via LDAPS sans write-back annuaire.",
    roles: ["admin"], contexts: ["admin", "integrations", "ldap", "active-directory"], prerequisites: ["ADM-V13-INTEGRATION-001"], tags: ["ldap", "active-directory", "ldaps", "directory"],
    steps: [
      { title: "Configurer LDAPS", instruction: "Renseigner une URL ldaps://, baseDn et bindDn de compte de service à privilèges minimaux.", expected: "TLS 1.2+ et validation du certificat restent actifs." },
      { title: "Stocker le mot de passe", instruction: "Enregistrer bind_password uniquement via Credentials.", expected: "Le mot de passe reste chiffré au repos." },
      { title: "Mapper les utilisateurs", instruction: "Mapper directory.users vers contact ou un type CRM autorisé.", expected: "Les comptes annuaire sont importés en lecture seule dans Clarity." },
      { title: "Traiter les groupes explicitement", instruction: "Ne mapper directory.groups que si une cible Clarity métier est réellement définie.", expected: "Aucun groupe AD n'est transformé arbitrairement par défaut." },
    ], result: "L'annuaire reste source externe en lecture seule et Clarity conserve sa gouvernance métier.",
  },
];
