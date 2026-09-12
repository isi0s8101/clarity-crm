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
};

export function normalizeHelpContext(input = {}) {
  const view = typeof input.view === "string" ? input.view : "dashboard";
  return {
    ...input,
    view: helpContextByView[view] ?? view,
    role: input.role === "admin" ? "admin" : "user",
    permissions: Array.isArray(input.permissions) ? input.permissions : [],
  };
}