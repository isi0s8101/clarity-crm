export const v11HelpProcedures = [
  {
    id: "USR-V11-TICKET-001", version: 1, title: "Créer et suivre un ticket", description: "Créer une demande support ou SAV et suivre son traitement.",
    roles: ["user", "admin"], contexts: ["crm", "ticket", "support"], prerequisites: ["COM-CNX-001"], tags: ["ticket", "support", "sav", "sla"],
    steps: [
      { title: "Choisir le type", instruction: "Ouvrir les tickets puis choisir support ou SAV.", expected: "Le workflow correspondant est sélectionné." },
      { title: "Décrire la demande", instruction: "Renseigner un titre, une priorité et une description exploitable.", expected: "Les champs obligatoires sont renseignés." },
      { title: "Créer", instruction: "Valider la création.", expected: "Le ticket reçoit ses échéances SLA côté serveur." },
      { title: "Suivre", instruction: "Consulter l'étape, le statut SLA, la timeline et les documents liés.", expected: "L'état opérationnel du ticket est visible." },
    ], result: "Le ticket est suivi dans le moteur CRM générique et son historique reste traçable.",
  },
  {
    id: "USR-V11-PORTAL-001", version: 1, title: "Utiliser le portail client", description: "Créer et consulter uniquement ses propres tickets et documents autorisés.",
    roles: ["client"], contexts: ["portal", "ticket"], permissions: [{ object: "portal", action: "read" }], prerequisites: [], tags: ["portail", "client", "ticket", "document"],
    steps: [
      { title: "Ouvrir le portail", instruction: "Ouvrir /portal avec un compte client invité.", expected: "Le portail affiche uniquement les tickets du compte courant." },
      { title: "Créer une demande", instruction: "Renseigner titre, description, priorité et catégorie puis créer le ticket.", expected: "Le ticket apparaît dans Mes tickets." },
      { title: "Mettre à jour", instruction: "Modifier uniquement la description autorisée depuis le portail.", expected: "Les champs internes, l'affectation et le SLA ne sont pas modifiables." },
      { title: "Documents", instruction: "Télécharger uniquement les documents explicitement partagés par l'équipe.", expected: "Les documents non autorisés restent invisibles." },
    ], result: "Le portail reste isolé du CRM interne et des tickets des autres clients.",
  },
  {
    id: "USR-V11-OPS-001", version: 1, title: "Suivre projets, chantiers et interventions", description: "Utiliser les objets opérationnels et leurs relations sans calendrier parallèle.",
    roles: ["user", "admin"], contexts: ["crm", "planning", "project", "worksite", "intervention"], prerequisites: ["COM-CNX-001"], tags: ["projet", "chantier", "intervention", "planning"],
    steps: [
      { title: "Créer le projet", instruction: "Créer un projet avec ses dates et son responsable.", expected: "Le projet est persisté dans crm_records." },
      { title: "Créer le chantier", instruction: "Créer un chantier et renseigner son adresse et ses dates.", expected: "Le chantier utilise le pipeline opérationnel." },
      { title: "Planifier l'intervention", instruction: "Créer une intervention avec horaire et intervenant puis la relier au chantier.", expected: "L'affectation et la relation sont persistées." },
      { title: "Consulter le planning", instruction: "Ouvrir la vue planning unifiée.", expected: "Tâches, rendez-vous, projets, chantiers et interventions sont agrégés sans duplication." },
    ], result: "Les opérations sont liées et planifiées à partir des enregistrements CRM existants.",
  },
  {
    id: "USR-V11-STOCK-001", version: 1, title: "Enregistrer un mouvement de stock", description: "Tracer une entrée ou sortie et surveiller le seuil.",
    roles: ["user", "admin"], contexts: ["crm", "inventory"], prerequisites: ["COM-CNX-001"], tags: ["stock", "mouvement", "seuil"],
    steps: [
      { title: "Choisir le produit", instruction: "Identifier le produit et l'emplacement de stock.", expected: "Les deux ressources sont accessibles dans votre scope." },
      { title: "Saisir le mouvement", instruction: "Indiquer une quantité positive pour une entrée ou négative pour une sortie.", expected: "Le serveur verrouille le solde avant calcul." },
      { title: "Contrôler le résultat", instruction: "Vérifier la quantité après mouvement et le seuil.", expected: "Aucun stock négatif n'est accepté." },
      { title: "Historique", instruction: "Consulter les mouvements de l'emplacement.", expected: "Chaque mouvement est historisé avec acteur et date." },
    ], result: "Le stock est cohérent, historisé et protégé contre les sorties concurrentes invalides.",
  },
  {
    id: "USR-V11-COMMERCE-001", version: 1, title: "Utiliser abonnement, CPQ et fidélité", description: "Gérer les fonctions commerciales légères de v1.1.",
    roles: ["user", "admin"], contexts: ["crm", "cpq", "loyalty"], prerequisites: ["COM-CNX-001"], tags: ["abonnement", "cpq", "devis", "fidélité"],
    steps: [
      { title: "Abonnement", instruction: "Créer un abonnement en reliant société, service, périodicité et dates.", expected: "L'abonnement est un objet CRM générique exploitable par les automatisations." },
      { title: "CPQ", instruction: "Sélectionner produits/services et quantités pour générer un devis.", expected: "Les prix sont relus côté serveur avant calcul." },
      { title: "Fidélité", instruction: "Ajouter ou consommer des points sur le compte fidélité.", expected: "Le solde et le ledger sont mis à jour atomiquement." },
      { title: "Vérifier", instruction: "Consulter timeline et audit pour les opérations sensibles.", expected: "Les actions critiques sont traçables." },
    ], result: "Les fonctions commerciales réutilisent produits, services, devis, CRM, automatisations et audit existants.",
  },
  {
    id: "ADM-V11-MOD-001", version: 1, title: "Installer ou retirer un module v1.1", description: "Utiliser le catalogue tenant-aware avec prérequis, conflits et rollback.",
    roles: ["admin"], contexts: ["admin", "config", "modules"], permissions: [{ object: "module", action: "administer" }], prerequisites: ["ADM-CONF-001"], tags: ["module", "template", "rollback", "prérequis"],
    steps: [
      { title: "Lire le catalogue", instruction: "Consulter les prérequis et impacts du template avant installation.", expected: "Les dépendances nécessaires sont connues." },
      { title: "Installer", instruction: "Installer le template par le cycle modules v1.1.", expected: "Les configurations sont créées atomiquement et auditées." },
      { title: "Relancer", instruction: "Répéter l'installation pour vérifier l'idempotence si nécessaire.", expected: "Aucun doublon n'est créé." },
      { title: "Rollback", instruction: "Demander le rollback seulement si les configurations gérées ne contiennent pas de données incompatibles.", expected: "Le serveur refuse toute désactivation destructive." },
    ], result: "Le cycle du module est traçable, tenant-aware et sans suppression silencieuse.",
  },
  {
    id: "ADM-V11-SLA-001", version: 1, title: "Configurer et diagnostiquer le SLA support", description: "Comprendre échéances, rappels et escalades gérés par le worker existant.",
    roles: ["admin"], contexts: ["admin", "ticket", "support", "automations"], permissions: [{ object: "automation", action: "administer" }], prerequisites: ["ADM-V11-MOD-001"], tags: ["sla", "support", "worker", "escalade"],
    steps: [
      { title: "Vérifier le module", instruction: "Confirmer que le module support est actif et que sa politique SLA est valide.", expected: "Les délais de prise en charge et résolution sont connus." },
      { title: "Vérifier le worker", instruction: "Contrôler l'état du worker automation existant.", expected: "Le même worker traite les échéances SLA." },
      { title: "Consulter le ticket", instruction: "Lire response_due_at, resolution_due_at et sla_state via les outils d'administration.", expected: "L'échéance et l'état sont cohérents." },
      { title: "Contrôler les traces", instruction: "Vérifier notification, timeline et audit sla.escalated.", expected: "L'escalade est prouvée sans moteur parallèle." },
    ], result: "Le SLA est diagnostiqué depuis les fondations d'automatisation et de traçabilité existantes.",
  },
  {
    id: "ADM-V11-PORTAL-001", version: 1, title: "Administrer le portail client", description: "Inviter un client et partager explicitement un document de ticket.",
    roles: ["admin"], contexts: ["admin", "portal", "rights"], permissions: [{ object: "portal", action: "administer" }], prerequisites: ["ADM-ACC-001"], tags: ["portail", "client", "rbac", "document"],
    steps: [
      { title: "Inviter", instruction: "Créer une invitation avec le rôle client.", expected: "Le compte utilise l'authentification et les memberships existants." },
      { title: "Vérifier les droits", instruction: "Conserver le rôle client limité à portal read/create/update en scope personal.", expected: "Le CRM interne n'est pas accessible au client." },
      { title: "Partager un document", instruction: "Depuis un document lié à un ticket, activer explicitement sa visibilité portail.", expected: "Seul ce document devient téléchargeable par le demandeur du ticket." },
      { title: "Contrôler l'audit", instruction: "Vérifier la trace portal.document.visibility.updated.", expected: "Le partage est attribuable." },
    ], result: "Le portail conserve le moindre privilège et une exposition documentaire explicite.",
  },
  {
    id: "HELP-V11-STOCK-001", version: 1, title: "Une sortie de stock est refusée", description: "Diagnostiquer un refus de mouvement sans contourner les verrous.",
    roles: ["user", "admin"], contexts: ["troubleshooting", "inventory"], prerequisites: ["USR-V11-STOCK-001"], tags: ["dépannage", "stock", "concurrence"],
    steps: [
      { title: "Lire le refus", instruction: "Vérifier si le serveur indique Stock insuffisant.", expected: "La règle bloquante est identifiée." },
      { title: "Relire le solde", instruction: "Rafraîchir le produit et l'emplacement.", expected: "Le solde courant après transactions concurrentes est visible." },
      { title: "Ne pas forcer", instruction: "Ne pas modifier la base ni réutiliser une autre clé d'idempotence pour contourner le refus.", expected: "L'intégrité du ledger reste préservée." },
    ], result: "Le refus est traité sans créer de stock négatif ni de mouvement dupliqué.",
  },
  {
    id: "HELP-V11-PORTAL-001", version: 1, title: "Un ticket ou document n'apparaît pas dans le portail", description: "Distinguer propriété du ticket, visibilité documentaire et accès refusé.",
    roles: ["client", "admin"], contexts: ["troubleshooting", "portal"], prerequisites: ["USR-V11-PORTAL-001"], tags: ["dépannage", "portail", "idor", "document"],
    steps: [
      { title: "Vérifier le compte", instruction: "Confirmer que la session utilise le compte client concerné.", expected: "L'identité portail est connue." },
      { title: "Vérifier le ticket", instruction: "Confirmer que requester_user_id correspond au client sans modifier cette valeur côté portail.", expected: "Le ticket appartient réellement au client." },
      { title: "Vérifier le partage", instruction: "Pour un document, demander à un administrateur de contrôler portal_visible.", expected: "Seuls les documents explicitement autorisés sont exposés." },
      { title: "Respecter le refus", instruction: "Un 404 sur une ressource d'un autre client est un comportement de sécurité normal.", expected: "Aucun contournement IDOR/BOLA n'est tenté." },
    ], result: "L'absence est expliquée par la propriété, le partage ou le contrôle d'accès attendu.",
  },
];