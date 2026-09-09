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

export function tenantSelectorFromHeaders(headers) {
  if (!headers || typeof headers.get !== "function") {
    return { present: false, value: null };
  }

  const headerValue = headers.get("x-clarity-tenant-id");
  if (headerValue !== null) {
    return { present: true, value: normalizeTenantSelector(headerValue) };
  }

  const cookieHeader = headers.get("cookie") || "";
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("clarity_tenant="));

  if (!cookie) return { present: false, value: null };

  const encoded = cookie.slice("clarity_tenant=".length);
  try {
    return { present: true, value: normalizeTenantSelector(decodeURIComponent(encoded)) };
  } catch {
    return { present: true, value: null };
  }
}
