export const helpContextByView = {
  dashboard: "dashboard",
  crm: "crm",
  forms: "forms",
  config: "config",
  automations: "automations",
  webhooks: "webhooks",
  notifications: "notifications",
  pipeline: "pipeline",
  objects: "crm",
  rights: "rights",
  modules: "config",
  data: "crm",
  audit: "audit",
  portal: "portal",
  ticket: "ticket",
  support: "support",
  inventory: "inventory",
  planning: "planning",
  cpq: "cpq",
  loyalty: "loyalty",
};

export function normalizeHelpContext(input = {}) {
  const view = typeof input.view === "string" ? input.view : "dashboard";
  const role = input.role === "admin" ? "admin" : input.role === "client" ? "client" : "user";
  return {
    ...input,
    view: helpContextByView[view] ?? view,
    role,
    permissions: Array.isArray(input.permissions) ? input.permissions : [],
  };
}