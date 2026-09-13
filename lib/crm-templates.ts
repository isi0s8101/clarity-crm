export type TemplateConfig = {
  kind: "object" | "pipeline" | "form" | "automation" | "module" | "relation";
  name: string;
  definition: Record<string, unknown>;
};

export type BuiltinTemplate = {
  key: string;
  name: string;
  description: string;
  prerequisites?: string[];
  impacts?: string[];
  configs: TemplateConfig[];
};

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    key: "services",
    name: "Entreprise de services",
    description: "Pipeline commercial, projets clients et relances simples.",
    impacts: ["Ajoute l'objet project et le module service_management."],
    configs: [
      {
        kind: "module",
        name: "Gestion de services",
        definition: { key: "service_management", dependsOn: [] },
      },
      {
        kind: "object",
        name: "Projet client",
        definition: {
          key: "project",
          label: "Projet",
          fields: [
            { key: "client_reference", label: "Référence client", type: "text" },
            { key: "start_date", label: "Date de début", type: "date" },
            { key: "end_date", label: "Date de fin", type: "date" },
            { key: "budget", label: "Budget", type: "currency", min: 0 },
            { key: "manager", label: "Responsable", type: "text" },
          ],
        },
      },
      {
        kind: "pipeline",
        name: "Pipeline commercial standard",
        definition: {
          key: "sales_standard",
          objectType: "opportunity",
          stages: [
            { key: "qualification", label: "Qualification" },
            { key: "discovery", label: "Découverte" },
            { key: "proposal", label: "Proposition" },
            { key: "negotiation", label: "Négociation" },
            { key: "won", label: "Gagné" },
            { key: "lost", label: "Perdu" },
          ],
        },
      },
      {
        kind: "form",
        name: "Qualification d'un lead",
        definition: {
          key: "lead_qualification",
          objectType: "lead",
          fields: [
            { key: "title", required: true },
            { key: "source" },
            { key: "email" },
            { key: "phone" },
          ],
        },
      },
      {
        kind: "automation",
        name: "Créer une tâche sur nouvelle opportunité",
        definition: {
          key: "opportunity_followup",
          trigger: { event: "record.created", type: "opportunity" },
          conditions: [],
          actions: [
            { kind: "create_task", title: "Suivre {{title}}" },
            { kind: "timeline", summary: "Relance initiale planifiée automatiquement" },
          ],
        },
      },
    ],
  },
  {
    key: "appointments",
    name: "Activité sur rendez-vous",
    description: "Contacts, rendez-vous et suivi client pour professions de service.",
    impacts: ["Ajoute le module appointments et les préférences client."],
    configs: [
      {
        kind: "module",
        name: "Rendez-vous client",
        definition: { key: "appointments", dependsOn: [] },
      },
      {
        kind: "object",
        name: "Préférence client",
        definition: {
          key: "client_preference",
          label: "Préférence client",
          fields: [
            { key: "category", label: "Catégorie", type: "text" },
            { key: "details", label: "Détails", type: "textarea" },
          ],
        },
      },
      {
        kind: "form",
        name: "Prise de rendez-vous",
        definition: {
          key: "appointment_booking",
          objectType: "appointment",
          fields: [
            { key: "title", required: true },
            { key: "startsAt", required: true },
            { key: "endsAt", required: true },
            { key: "contactId" },
          ],
        },
      },
      {
        kind: "automation",
        name: "Suivi après rendez-vous",
        definition: {
          key: "appointment_followup",
          trigger: { event: "record.updated", type: "appointment" },
          conditions: [{ field: "status", operator: "eq", value: "completed" }],
          actions: [{ kind: "create_task", title: "Suivi de {{title}}" }],
        },
      },
    ],
  },
  {
    key: "field-service",
    name: "Interventions terrain",
    description: "Clients, sites et interventions pour bâtiment, garage et maintenance.",
    impacts: ["Ajoute customer_site, intervention et leur cycle opérationnel."],
    configs: [
      {
        kind: "module",
        name: "Interventions terrain",
        definition: { key: "field_service", dependsOn: [] },
      },
      {
        kind: "object",
        name: "Site client",
        definition: {
          key: "customer_site",
          label: "Site client",
          fields: [
            { key: "address", label: "Adresse", type: "textarea" },
            { key: "access_notes", label: "Consignes d'accès", type: "textarea" },
          ],
        },
      },
      {
        kind: "object",
        name: "Intervention",
        definition: {
          key: "intervention",
          label: "Intervention",
          fields: [
            { key: "scheduled_at", label: "Planification", type: "datetime" },
            { key: "ends_at", label: "Fin prévue", type: "datetime" },
            { key: "technician", label: "Intervenant", type: "text" },
            { key: "result", label: "Compte rendu", type: "textarea" },
          ],
        },
      },
      {
        kind: "pipeline",
        name: "Cycle d'intervention",
        definition: {
          key: "intervention_cycle",
          objectType: "intervention",
          stages: [
            { key: "planned", label: "Planifiée" },
            { key: "in_progress", label: "En cours" },
            { key: "completed", label: "Terminée" },
            { key: "cancelled", label: "Annulée" },
          ],
          transitions: [
            { from: "planned", to: "in_progress" },
            { from: "planned", to: "cancelled" },
            { from: "in_progress", to: "completed" },
            { from: "in_progress", to: "cancelled" },
          ],
        },
      },
    ],
  },
  {
    key: "support",
    name: "Support, tickets et SAV",
    description: "Tickets, SLA, workflow support/SAV et portail client sécurisé.",
    impacts: ["Ajoute l'objet ticket, deux workflows et la politique SLA du module support."],
    configs: [
      {
        kind: "module",
        name: "Support et SLA",
        definition: {
          key: "support",
          dependsOn: [],
          sla: { responseMinutes: 60, resolutionMinutes: 480, reminderMinutes: 30 },
        },
      },
      {
        kind: "object",
        name: "Ticket",
        definition: {
          key: "ticket",
          label: "Ticket",
          fields: [
            { key: "priority", label: "Priorité", type: "select", required: true, options: ["low", "normal", "high", "urgent"] },
            { key: "category", label: "Catégorie", type: "select", required: true, options: ["support", "sav"] },
            { key: "description", label: "Description", type: "textarea", required: true, maxLength: 10000 },
            { key: "requester_user_id", label: "Demandeur", type: "text" },
            { key: "requester_email", label: "Email demandeur", type: "email" },
            { key: "assigned_to_user_id", label: "Assigné à", type: "text" },
            { key: "first_response_at", label: "Première réponse", type: "datetime" },
            { key: "resolved_at", label: "Résolution", type: "datetime" },
            { key: "response_due_at", label: "Échéance prise en charge", type: "datetime" },
            { key: "resolution_due_at", label: "Échéance résolution", type: "datetime" },
            { key: "response_escalated_at", label: "Escalade prise en charge", type: "datetime" },
            { key: "resolution_escalated_at", label: "Escalade résolution", type: "datetime" },
            { key: "sla_state", label: "État SLA", type: "select", options: ["within", "response_overdue", "resolution_overdue", "breached"] },
          ],
        },
      },
      {
        kind: "pipeline",
        name: "Workflow support",
        definition: {
          key: "ticket_support",
          objectType: "ticket",
          stages: [
            { key: "open", label: "Ouvert" },
            { key: "in_progress", label: "En cours" },
            { key: "waiting_customer", label: "Attente client" },
            { key: "resolved", label: "Résolu" },
            { key: "closed", label: "Clos" },
          ],
          transitions: [
            { from: "open", to: "in_progress" },
            { from: "in_progress", to: "waiting_customer" },
            { from: "waiting_customer", to: "in_progress" },
            { from: "in_progress", to: "resolved" },
            { from: "resolved", to: "closed" },
            { from: "resolved", to: "in_progress" },
          ],
        },
      },
      {
        kind: "pipeline",
        name: "Workflow SAV",
        definition: {
          key: "ticket_sav",
          objectType: "ticket",
          stages: [
            { key: "received", label: "Reçu" },
            { key: "diagnosis", label: "Diagnostic" },
            { key: "repair", label: "Réparation" },
            { key: "ready", label: "Prêt" },
            { key: "closed", label: "Clos" },
          ],
          transitions: [
            { from: "received", to: "diagnosis" },
            { from: "diagnosis", to: "repair" },
            { from: "repair", to: "ready" },
            { from: "ready", to: "closed" },
          ],
        },
      },
      {
        kind: "form",
        name: "Nouveau ticket",
        definition: {
          key: "ticket_create",
          objectType: "ticket",
          fields: [
            { key: "title", required: true },
            { key: "priority", required: true },
            { key: "category", required: true },
            { key: "description", required: true },
          ],
        },
      },
    ],
  },
  {
    key: "operations",
    name: "Projets, chantiers et planning",
    description: "Étend les projets et interventions existants avec chantiers et relations opérationnelles.",
    prerequisites: ["services", "field-service"],
    impacts: ["Nécessite les modules service_management et field_service actifs.", "Ajoute worksite et les relations projet/chantier/intervention."],
    configs: [
      {
        kind: "module",
        name: "Opérations",
        definition: { key: "operations", dependsOn: ["service_management", "field_service"] },
      },
      {
        kind: "object",
        name: "Chantier",
        definition: {
          key: "worksite",
          label: "Chantier",
          fields: [
            { key: "address", label: "Adresse", type: "textarea", required: true },
            { key: "start_date", label: "Début", type: "date" },
            { key: "end_date", label: "Fin", type: "date" },
            { key: "site_manager", label: "Responsable", type: "text" },
          ],
        },
      },
      {
        kind: "pipeline",
        name: "Cycle chantier",
        definition: {
          key: "worksite_cycle",
          objectType: "worksite",
          stages: [
            { key: "planned", label: "Planifié" },
            { key: "active", label: "En cours" },
            { key: "completed", label: "Terminé" },
          ],
          transitions: [
            { from: "planned", to: "active" },
            { from: "active", to: "completed" },
          ],
        },
      },
      { kind: "relation", name: "Projet vers chantier", definition: { key: "project_worksite", sourceType: "project", targetType: "worksite", cardinality: "one_to_many" } },
      { kind: "relation", name: "Chantier vers intervention", definition: { key: "worksite_intervention", sourceType: "worksite", targetType: "intervention", cardinality: "one_to_many" } },
    ],
  },
  {
    key: "commerce-ops",
    name: "Stock, abonnements, CPQ et fidélité",
    description: "Objets légers réutilisant produits, services, devis et automatisations existants.",
    impacts: ["Ajoute stock_location, subscription et loyalty_account ; les mouvements restent historisés dans les tables transactionnelles v1.1."],
    configs: [
      {
        kind: "module",
        name: "Commerce opérationnel",
        definition: { key: "commerce_ops", dependsOn: [] },
      },
      {
        kind: "object",
        name: "Emplacement de stock",
        definition: {
          key: "stock_location",
          label: "Emplacement de stock",
          fields: [
            { key: "code", label: "Code", type: "text", required: true, maxLength: 80 },
            { key: "description", label: "Description", type: "textarea" },
          ],
        },
      },
      {
        kind: "object",
        name: "Abonnement",
        definition: {
          key: "subscription",
          label: "Abonnement",
          fields: [
            { key: "company", label: "Société", type: "relation", targetType: "company", required: true },
            { key: "service", label: "Service", type: "relation", targetType: "service" },
            { key: "frequency", label: "Périodicité", type: "select", required: true, options: ["monthly", "quarterly", "yearly"] },
            { key: "amount", label: "Montant", type: "currency", min: 0 },
            { key: "start_date", label: "Début", type: "date", required: true },
            { key: "end_date", label: "Fin", type: "date" },
            { key: "renewal_date", label: "Prochain renouvellement", type: "date" },
          ],
        },
      },
      {
        kind: "object",
        name: "Compte fidélité",
        definition: {
          key: "loyalty_account",
          label: "Compte fidélité",
          fields: [
            { key: "company", label: "Société", type: "relation", targetType: "company", required: true },
            { key: "points_balance", label: "Solde de points", type: "number", min: 0 },
            { key: "tier", label: "Niveau", type: "select", options: ["standard", "silver", "gold"] },
          ],
        },
      },
    ],
  },
];

export function getBuiltinTemplate(key: string) {
  return BUILTIN_TEMPLATES.find((template) => template.key === key) ?? null;
}
