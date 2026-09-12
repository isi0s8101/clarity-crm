import { helpCatalog } from "./catalog.js";
import { normalizeHelpContext } from "./contexts.js";

const roleOrder = { user: 1, admin: 2 };

export function hasPermission(permissions = [], required = []) {
  if (!required.length) return true;
  return required.some((need) => permissions.some((permission) => {
    if (need.object && permission.object !== need.object) return false;
    if (need.action && permission.action !== need.action) return false;
    return true;
  }));
}

export function procedureVisibleForContext(procedure, rawContext = {}) {
  const context = normalizeHelpContext(rawContext);
  const role = context.role ?? "user";
  if (!procedure.roles.includes(role)) {
    if (!(role === "admin" && procedure.roles.includes("user"))) return false;
  }
  if (!hasPermission(context.permissions, procedure.permissions ?? [])) return false;
  if (context.recordType && procedure.recordTypes?.length && !procedure.recordTypes.includes(context.recordType)) return false;
  return true;
}

export function filterProcedures(rawContext = {}, catalog = helpCatalog) {
  const context = normalizeHelpContext(rawContext);
  return catalog.filter((procedure) => procedureVisibleForContext(procedure, context));
}

export function scoreProcedure(procedure, rawContext = {}) {
  const context = normalizeHelpContext(rawContext);
  let score = 0;
  if (procedure.contexts.includes(context.view)) score += 60;
  if (context.recordType && procedure.recordTypes?.includes(context.recordType)) score += 35;
  if (context.action && procedure.contexts.includes(context.action)) score += 20;
  if (procedure.contexts.includes("common")) score += 4;
  if (procedure.id.startsWith("HELP-ERR")) score -= context.view === "troubleshooting" ? 0 : 20;
  if (context.role === "admin" && procedure.roles.includes("admin")) score += 6;
  if (roleOrder[context.role] >= 2 && procedure.roles.includes("admin")) score += 2;
  return score;
}

export function recommendProcedures(rawContext = {}, limit = 4, catalog = helpCatalog) {
  const context = normalizeHelpContext(rawContext);
  return filterProcedures(context, catalog)
    .map((procedure) => ({ procedure, score: scoreProcedure(procedure, context) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.procedure.id.localeCompare(b.procedure.id))
    .slice(0, Math.max(0, Math.min(4, limit)))
    .map((item) => item.procedure);
}

export function getProcedure(id, catalog = helpCatalog) {
  return catalog.find((procedure) => procedure.id === id) ?? null;
}