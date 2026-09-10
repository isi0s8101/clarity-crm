export type TemplateConfig = {
  kind: "object" | "pipeline" | "form" | "automation" | "module";
  name: string;
  definition: Record<string, unknown>;
};

export type BuiltinTemplate = {
  key: string;
  name: string;
  description: string;
  configs: TemplateConfig[];
};

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    key: "services",
    name: "Entreprise de services",
    description: "Pipeline commercial, projets clients et relances simples.",
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
            { key: "budget", label: "Budget", type: "currency" },
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
        },
      },
    ],
  },
];

export function getBuiltinTemplate(key: string) {
  return BUILTIN_TEMPLATES.find((template) => template.key === key) ?? null;
}
