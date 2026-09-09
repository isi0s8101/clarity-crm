export function canUseScopedResource(actor, scope, resource) {
  if (!actor || !resource || resource.tenantId !== actor.tenantId) return false;
  if (scope === "tenant") return true;
  if (scope === "team") return Boolean(actor.teamId) && resource.teamId === actor.teamId;
  if (scope === "personal") return resource.ownerId === actor.userId;
  return false;
}

export function normalizeTenantSelector(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 100) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(normalized) ? normalized : null;
}
