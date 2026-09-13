export const v12HelpProcedures = [
  {
    id: "USR-V12-PLAN-001", version: 1, title: "Réserver et déplacer un rendez-vous", description: "Utiliser le planning unifié avec disponibilités, tampons et protection contre les conflits.",
    roles: ["user", "admin"], contexts: ["planning", "crm", "appointment"], prerequisites: ["COM-CNX-001"], tags: ["planning", "rendez-vous", "disponibilité", "concurrence"],
    steps: [
      { title: "Choisir une ressource", instruction: "Sélectionner un utilisateur ou une équipe accessible dans votre scope.", expected: "Les créneaux sont calculés depuis la règle de disponibilité active." },
      { title: "Choisir un créneau", instruction: "Sélectionner un créneau proposé et confirmer le rendez-vous.", expected: "Le serveur revérifie le créneau avant écriture." },
      { title: "Déplacer si nécessaire", instruction: "Utiliser l'action de déplacement et choisir un nouveau créneau libre.", expected: "La réservation et la fiche appointment restent synchronisées." },
      { title: "Annuler", instruction: "Annuler depuis le planning plutôt que supprimer directement la fiche.", expected: "Le créneau est libéré et la timeline est conservée." },
    ], result: "Le rendez-vous reste dans le planning CRM unifié sans double réservation silencieuse.",
  },
  {
    id: "USR-V12-PUBLIC-001", version: 1, title: "Utiliser un formulaire ou une réservation publique", description: "Comprendre le parcours public explicitement publié par un administrateur.",
    roles: ["user", "admin"], contexts: ["public", "planning", "forms"], prerequisites: [], tags: ["public", "formulaire", "réservation", "idempotence"],
    steps: [
      { title: "Ouvrir le lien", instruction: "Utiliser uniquement un lien public actif communiqué par l'organisation.", expected: "Seuls les champs explicitement publiés sont affichés." },
      { title: "Saisir", instruction: "Renseigner les champs requis ou choisir un créneau proposé.", expected: "Aucun identifiant interne de tenant ou de ressource n'est exposé." },
      { title: "Valider", instruction: "Envoyer une seule fois puis attendre la confirmation affichée.", expected: "Une répétition technique avec la même clé d'idempotence ne crée pas de doublon." },
    ], result: "La soumission crée la fiche CRM attendue ou le rendez-vous sans accès au CRM interne.",
  },
  {
    id: "USR-V12-INBOX-001", version: 1, title: "Traiter une conversation Inbox", description: "Centraliser une conversation interne liée à une fiche CRM.",
    roles: ["user", "admin"], contexts: ["inbox", "crm"], prerequisites: ["COM-CNX-001"], tags: ["inbox", "conversation", "affectation", "historique"],
    steps: [
      { title: "Créer ou ouvrir", instruction: "Ouvrir une conversation puis, si nécessaire, la rattacher à une fiche CRM.", expected: "La conversation respecte le tenant et le scope de l'utilisateur." },
      { title: "Répondre", instruction: "Ajouter les messages internes nécessaires au suivi.", expected: "Les messages restent ordonnés et attribués." },
      { title: "Affecter", instruction: "Affecter la conversation à un membre autorisé de l'équipe.", expected: "L'affectation est visible et contrôlée côté serveur." },
      { title: "Clore", instruction: "Passer la conversation à l'état traité quand l'action est terminée.", expected: "L'historique reste consultable." },
    ], result: "L'Inbox reste une brique interne sans connecteur Gmail/Outlook ni moteur parallèle.",
  },
  {
    id: "USR-V12-MERGE-001", version: 1, title: "Détecter et fusionner un doublon", description: "Comparer deux fiches compatibles puis confirmer explicitement leur fusion.",
    roles: ["user", "admin"], contexts: ["crm", "duplicates", "merge"], prerequisites: ["COM-CNX-001"], tags: ["doublon", "fusion", "audit", "documents"],
    steps: [
      { title: "Analyser", instruction: "Ouvrir la détection de doublons et lire chaque raison de rapprochement.", expected: "Le score de confiance reste explicable et n'entraîne aucune fusion automatique." },
      { title: "Prévisualiser", instruction: "Choisir une fiche principale et une fiche secondaire puis ouvrir la comparaison champ par champ.", expected: "Les impacts sur relations, timeline, documents et conversations sont affichés." },
      { title: "Résoudre", instruction: "Pour chaque conflit utile, choisir la valeur à conserver.", expected: "La résolution est explicite avant écriture." },
      { title: "Confirmer", instruction: "Valider manuellement la fusion.", expected: "La secondaire est archivée, les références sont réaffectées et un ledger de fusion est créé." },
    ], result: "La fusion est transactionnelle, traçable et réversible par analyse du ledger, jamais automatique.",
  },
  {
    id: "USR-V12-INTEL-001", version: 1, title: "Interpréter scoring, inactivité et Next Best Action", description: "Lire les signaux proactifs déterministes sans les confondre avec une décision automatique.",
    roles: ["user", "admin"], contexts: ["crm", "scoring", "inactivity", "next_action"], prerequisites: ["COM-CNX-001"], tags: ["scoring", "inactivité", "nba", "explicabilité"],
    steps: [
      { title: "Lire le score", instruction: "Examiner le score, son niveau et la liste des facteurs positifs/négatifs.", expected: "Chaque facteur indique la règle, sa version, son poids et sa justification." },
      { title: "Lire l'inactivité", instruction: "Contrôler la dernière activité, les tâches/rendez-vous planifiés et le seuil configuré.", expected: "Un facteur protecteur n'efface pas les autres signaux : les raisons restent visibles." },
      { title: "Lire la recommandation", instruction: "Vérifier l'action suggérée, sa priorité, son échéance et les données déclenchantes.", expected: "La recommandation reste non destructive tant qu'elle n'est pas confirmée." },
      { title: "Confirmer", instruction: "Valider uniquement une action jugée pertinente.", expected: "Une tâche CRM est créée et l'acceptation est tracée." },
    ], result: "L'utilisateur garde le contrôle sur une intelligence explicable, paramétrable et sans IA obligatoire.",
  },
  {
    id: "ADM-V12-RULES-001", version: 1, title: "Administrer les règles proactives v1.2", description: "Versionner disponibilités, doublons, scoring, inactivité et NBA dans les configurations existantes.",
    roles: ["admin"], contexts: ["admin", "config", "planning", "scoring"], permissions: [{ object: "crm_configuration", action: "administer" }], prerequisites: ["ADM-CONF-001"], tags: ["configuration", "version", "scoring", "disponibilité"],
    steps: [
      { title: "Choisir le type", instruction: "Sélectionner availability, duplicate_rule, scoring_rule, inactivity_rule ou next_action_rule.", expected: "La règle utilise crm_configurations et crm_configuration_versions." },
      { title: "Définir", instruction: "Saisir une clé stable, les paramètres et les justifications métier nécessaires.", expected: "La validation serveur refuse les bornes, opérateurs ou types invalides." },
      { title: "Versionner", instruction: "Modifier une règle existante en conservant sa clé technique.", expected: "Une nouvelle version est créée avec contrôle de concurrence." },
      { title: "Désactiver", instruction: "Désactiver la règle plutôt que supprimer son historique.", expected: "Les résultats historiques restent interprétables." },
    ], result: "Les règles v1.2 restent auditées, explicables et gérées par le moteur de configuration existant.",
  },
  {
    id: "HELP-V12-PLAN-001", version: 1, title: "Un créneau vient d'être refusé", description: "Diagnostiquer un conflit de réservation sans contourner la cohérence PostgreSQL.",
    roles: ["user", "admin"], contexts: ["troubleshooting", "planning"], prerequisites: ["USR-V12-PLAN-001"], tags: ["dépannage", "planning", "conflit", "concurrence"],
    steps: [
      { title: "Rafraîchir", instruction: "Relire immédiatement les disponibilités de la même ressource.", expected: "Le créneau déjà réservé disparaît de la liste." },
      { title: "Choisir un autre créneau", instruction: "Sélectionner une proposition encore disponible.", expected: "La nouvelle tentative utilise un intervalle libre." },
      { title: "Ne pas forcer", instruction: "Ne pas écrire directement dans planning_reservations ni désactiver la contrainte d'exclusion.", expected: "L'invariant anti-chevauchement reste garanti." },
    ], result: "Un conflit concurrent est traité comme un état normal sans double réservation.",
  },
  {
    id: "HELP-V12-PUBLIC-001", version: 1, title: "Un lien public ne fonctionne plus", description: "Distinguer publication révoquée, expirée, limite anti-abus et formulaire désactivé.",
    roles: ["user", "admin"], contexts: ["troubleshooting", "public", "forms"], prerequisites: ["USR-V12-PUBLIC-001"], tags: ["dépannage", "public", "expiration", "rate-limit"],
    steps: [
      { title: "Vérifier la publication", instruction: "Depuis l'administration, contrôler son état et son expiration.", expected: "Une publication révoquée ou expirée reste inaccessible." },
      { title: "Vérifier le formulaire", instruction: "Confirmer que la configuration source est toujours active.", expected: "Le formulaire publié possède encore une définition valide." },
      { title: "Vérifier l'anti-abus", instruction: "En cas de 429, attendre la fenêtre prévue au lieu de multiplier les requêtes.", expected: "La protection publique reste active." },
    ], result: "L'accès public est rétabli uniquement par une publication administrativement valide.",
  },
];
