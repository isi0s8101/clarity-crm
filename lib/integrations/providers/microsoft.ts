import {
  ConnectorError,
  type Connector,
  type ConnectorHealth,
  type ConnectorRuntimeContext,
  type ConnectorTokenSet,
  type IntegrationCapability,
  type PullItem,
  type PullPage,
} from "@/lib/integrations/connector";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";
const CAPABILITIES: readonly IntegrationCapability[] = [
  "mail.read", "mail.send",
  "calendar.read", "calendar.write",
  "contacts.read", "contacts.write",
  "files.read", "files.import",
];

export const MICROSOFT_SCOPES: Record<IntegrationCapability, string[]> = {
  "mail.read": ["Mail.Read"],
  "mail.send": ["Mail.Send"],
  "calendar.read": ["Calendars.Read"],
  "calendar.write": ["Calendars.ReadWrite"],
  "contacts.read": ["Contacts.Read"],
  "contacts.write": ["Contacts.ReadWrite"],
  "files.read": ["Files.Read"],
  "files.import": ["Files.Read.All"],
  "directory.users.read": [],
  "directory.groups.read": [],
  "webhook.inbound": [],
  "webhook.outbound": [],
};

export function microsoftScopesForCapabilities(capabilities: string[]) {
  const scopes = new Set(["openid", "profile", "offline_access", "User.Read"]);
  for (const capability of capabilities) {
    const values = MICROSOFT_SCOPES[capability as IntegrationCapability] ?? [];
    for (const value of values) scopes.add(value);
  }
  return [...scopes];
}

export const microsoftConnector: Connector = {
  metadata() {
    return {
      provider: "microsoft",
      label: "Microsoft 365",
      category: "workspace",
      authorization: "oauth2",
      documentationUrl: "https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow",
    };
  },
  capabilities() {
    return CAPABILITIES;
  },
  validateConfiguration(configuration) {
    const clientId = String(configuration.clientId ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw new ConnectorError("Client ID Microsoft invalide.", { code: "invalid_configuration" });
    const directory = microsoftDirectory(configuration);
    if (!/^(?:common|organizations|consumers|[0-9a-f-]{36})$/i.test(directory)) {
      throw new ConnectorError("Tenant Microsoft invalide.", { code: "invalid_configuration" });
    }
    optionalGraphId(configuration.mailFolderId, "mailFolderId");
    optionalGraphId(configuration.contactsFolderId, "contactsFolderId");
    boundedConfigurationInteger(configuration.calendarPastDays, 1, 3650, "calendarPastDays");
    boundedConfigurationInteger(configuration.calendarFutureDays, 1, 3650, "calendarFutureDays");
  },
  beginAuthorization(connection, input) {
    this.validateConfiguration(connection.configuration);
    const directory = microsoftDirectory(connection.configuration);
    const url = new URL(`https://login.microsoftonline.com/${directory}/oauth2/v2.0/authorize`);
    url.searchParams.set("client_id", String(connection.configuration.clientId));
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", input.scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (input.nonce) url.searchParams.set("nonce", input.nonce);
    return url;
  },
  async completeAuthorization(context, input) {
    const clientSecret = await context.getSecret("client_secret");
    const body = new URLSearchParams({
      client_id: String(context.connection.configuration.clientId),
      scope: input.scopes.join(" "),
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
      code_verifier: input.codeVerifier,
    });
    if (clientSecret) body.set("client_secret", clientSecret);
    return exchangeToken(context, body);
  },
  async refreshAuthorization(context, refreshToken) {
    const clientSecret = await context.getSecret("client_secret");
    const body = new URLSearchParams({
      client_id: String(context.connection.configuration.clientId),
      scope: context.connection.scopes.join(" "),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    if (clientSecret) body.set("client_secret", clientSecret);
    return exchangeToken(context, body);
  },
  async testConnection(context) {
    const started = Date.now();
    if (!context.accessToken) return authHealth("missing_access_token", "Jeton d'accès Microsoft absent.");
    const response = await context.fetch(`${GRAPH_ROOT}/me?$select=id,displayName,userPrincipalName`, {
      headers: { authorization: `Bearer ${context.accessToken}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) return authHealth("microsoft_auth_rejected", "Microsoft Graph refuse les credentials.");
    if (response.status === 429) return rateHealth(response.headers.get("retry-after"));
    if (!response.ok) return { ok: false, status: "failed", code: "microsoft_test_failed", message: `Microsoft Graph répond HTTP ${response.status}.`, latencyMs: Date.now() - started };
    return {
      ok: true,
      status: "healthy",
      code: "ok",
      message: "Connexion Microsoft 365 opérationnelle.",
      latencyMs: Date.now() - started,
    } satisfies ConnectorHealth;
  },
  async pull(context, resourceType, cursor) {
    if (!context.accessToken) throw new ConnectorError("Jeton Microsoft absent.", { code: "microsoft_missing_access_token", authRequired: true });
    if (resourceType === "mail") {
      requireCapability(context, "mail.read");
      return pullMail(context, cursor);
    }
    if (resourceType === "calendar") {
      requireCapability(context, "calendar.read");
      return pullCalendar(context, cursor);
    }
    if (resourceType === "contacts") {
      requireCapability(context, "contacts.read");
      return pullContacts(context, cursor);
    }
    if (resourceType === "files") {
      requireCapability(context, "files.read");
      return pullFiles(context, cursor);
    }
    throw new ConnectorError(`Ressource Microsoft non prise en charge: ${resourceType}.`, { code: "microsoft_resource_unsupported" });
  },
  normalizeError(error) {
    if (error instanceof ConnectorError) return error;
    return new ConnectorError(error instanceof Error ? error.message : "Erreur Microsoft inconnue.", { code: "microsoft_error", retryable: true });
  },
};

async function pullMail(context: ConnectorRuntimeContext, cursor?: string): Promise<PullPage> {
  const folder = String(context.connection.configuration.mailFolderId ?? "inbox").trim() || "inbox";
  const pathPrefix = `/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages/delta`;
  const initial = `${GRAPH_ROOT}/me/mailFolders/${encodeURIComponent(folder)}/messages/delta?${new URLSearchParams({
    "$select": "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,internetMessageId,bodyPreview,lastModifiedDateTime,parentFolderId",
  })}`;
  const url = cursor ? validateGraphCursor(cursor, pathPrefix) : initial;
  const payload = await graphJson(context, url, "microsoft_mail_delta_failed", { Prefer: "odata.maxpagesize=50" });
  const items = arrayOfObjects(payload.value).map(mailItem).filter((item): item is PullItem => Boolean(item));
  return graphPage(payload, items, pathPrefix);
}

function mailItem(value: Record<string, unknown>): PullItem | null {
  const id = safeExternalId(value.id);
  if (!id) return null;
  if (value["@removed"]) return { externalId: id, deleted: true, data: { kind: "mail", provider: "microsoft" } };
  const from = asObject(asObject(value.from).emailAddress);
  const to = arrayOfObjects(value.toRecipients).map((entry) => addressString(asObject(entry.emailAddress))).filter(Boolean).join(", ");
  const cc = arrayOfObjects(value.ccRecipients).map((entry) => addressString(asObject(entry.emailAddress))).filter(Boolean).join(", ");
  return {
    externalId: id,
    externalVersion: optionalString(value.lastModifiedDateTime, 128),
    etag: optionalString(value["@odata.etag"], 512),
    data: {
      kind: "mail",
      provider: "microsoft",
      threadExternalId: optionalString(value.conversationId, 1024) ?? id,
      subject: String(value.subject ?? "(sans objet)").slice(0, 240),
      from: addressString(from),
      to: to.slice(0, 4096),
      cc: cc.slice(0, 4096),
      internetMessageId: String(value.internetMessageId ?? "").slice(0, 1024),
      receivedAt: safeDate(value.receivedDateTime) || safeDate(value.sentDateTime),
      bodyPreview: String(value.bodyPreview ?? "").slice(0, 4096),
      direction: "inbound",
    },
  };
}

async function pullCalendar(context: ConnectorRuntimeContext, cursor?: string): Promise<PullPage> {
  const pathPrefix = "/v1.0/me/calendarView/delta";
  let url: string;
  if (cursor) {
    url = validateGraphCursor(cursor, pathPrefix);
  } else {
    const pastDays = boundedInteger(context.connection.configuration.calendarPastDays, 365, 1, 3650);
    const futureDays = boundedInteger(context.connection.configuration.calendarFutureDays, 730, 1, 3650);
    const start = new Date(Date.now() - pastDays * 86400000).toISOString();
    const end = new Date(Date.now() + futureDays * 86400000).toISOString();
    url = `${GRAPH_ROOT}/me/calendarView/delta?${new URLSearchParams({ startDateTime: start, endDateTime: end })}`;
  }
  const payload = await graphJson(context, url, "microsoft_calendar_delta_failed", {
    Prefer: 'odata.maxpagesize=100, outlook.timezone="UTC"',
  });
  const items = arrayOfObjects(payload.value).map(calendarItem).filter((item): item is PullItem => Boolean(item));
  return graphPage(payload, items, pathPrefix);
}

function calendarItem(value: Record<string, unknown>): PullItem | null {
  const id = safeExternalId(value.id);
  if (!id) return null;
  if (value["@removed"]) return { externalId: id, deleted: true, data: { kind: "appointment", provider: "microsoft", cancelled: true } };
  const start = asObject(value.start);
  const end = asObject(value.end);
  const organizer = asObject(asObject(value.organizer).emailAddress);
  return {
    externalId: id,
    externalVersion: optionalString(value.lastModifiedDateTime, 128),
    etag: optionalString(value["@odata.etag"], 512),
    deleted: value.isCancelled === true,
    data: {
      kind: "appointment",
      provider: "microsoft",
      title: String(value.subject ?? "Rendez-vous Microsoft").slice(0, 160),
      startsAt: graphDateTime(start),
      endsAt: graphDateTime(end),
      timezone: String(start.timeZone ?? end.timeZone ?? "UTC").slice(0, 120),
      location: String(asObject(value.location).displayName ?? "").slice(0, 1000),
      description: String(asObject(value.body).content ?? "").slice(0, 20000),
      webLink: String(value.webLink ?? "").slice(0, 2048),
      organizer: addressString(organizer),
      cancelled: value.isCancelled === true,
    },
  };
}

async function pullContacts(context: ConnectorRuntimeContext, cursor?: string): Promise<PullPage> {
  const folder = String(context.connection.configuration.contactsFolderId ?? "").trim();
  if (!folder) return pullDefaultContacts(context, cursor);
  const pathPrefix = `/v1.0/me/contactFolders/${encodeURIComponent(folder)}/contacts/delta`;
  const initial = `${GRAPH_ROOT}/me/contactFolders/${encodeURIComponent(folder)}/contacts/delta?${new URLSearchParams({
    "$select": "id,displayName,emailAddresses,businessPhones,mobilePhone,companyName,jobTitle,businessAddress,homeAddress",
  })}`;
  const url = cursor ? validateGraphCursor(cursor, pathPrefix) : initial;
  const payload = await graphJson(context, url, "microsoft_contacts_delta_failed", { Prefer: "odata.maxpagesize=100" });
  const items = arrayOfObjects(payload.value).map(contactItem).filter((item): item is PullItem => Boolean(item));
  return graphPage(payload, items, pathPrefix);
}

async function pullDefaultContacts(context: ConnectorRuntimeContext, cursor?: string): Promise<PullPage> {
  const pathPrefix = "/v1.0/me/contacts";
  let url = `${GRAPH_ROOT}/me/contacts?${new URLSearchParams({
    "$top": "100",
    "$select": "id,displayName,emailAddresses,businessPhones,mobilePhone,companyName,jobTitle,businessAddress,homeAddress",
  })}`;
  if (cursor) url = validateGraphCursor(cursor, pathPrefix);
  const payload = await graphJson(context, url, "microsoft_contacts_list_failed");
  const items = arrayOfObjects(payload.value).map(contactItem).filter((item): item is PullItem => Boolean(item));
  const next = optionalString(payload["@odata.nextLink"], 65536);
  return {
    items,
    hasMore: Boolean(next),
    continuationCursor: next ? validateGraphCursor(next, pathPrefix) : undefined,
    checkpointCursor: next ? undefined : `full:${new Date().toISOString()}`,
  };
}

function contactItem(value: Record<string, unknown>): PullItem | null {
  const id = safeExternalId(value.id);
  if (!id) return null;
  if (value["@removed"]) return { externalId: id, deleted: true, data: { kind: "contact", provider: "microsoft", deleted: true } };
  const emails = arrayOfObjects(value.emailAddresses);
  const businessPhones = Array.isArray(value.businessPhones) ? value.businessPhones.map(String) : [];
  const businessAddress = asObject(value.businessAddress);
  const homeAddress = asObject(value.homeAddress);
  return {
    externalId: id,
    etag: optionalString(value["@odata.etag"], 512),
    data: {
      kind: "contact",
      provider: "microsoft",
      title: String(value.displayName ?? asObject(emails[0]).address ?? "Contact Microsoft").slice(0, 160),
      email: String(asObject(emails[0]).address ?? "").trim().toLowerCase().slice(0, 254),
      phone: String(businessPhones[0] ?? value.mobilePhone ?? "").slice(0, 120),
      organization: String(value.companyName ?? "").slice(0, 240),
      jobTitle: String(value.jobTitle ?? "").slice(0, 240),
      address: graphAddress(Object.keys(businessAddress).length ? businessAddress : homeAddress),
      deleted: false,
    },
  };
}

async function pullFiles(context: ConnectorRuntimeContext, cursor?: string): Promise<PullPage> {
  const pathPrefix = "/v1.0/me/drive/root/delta";
  const url = cursor ? validateGraphCursor(cursor, pathPrefix) : `${GRAPH_ROOT}/me/drive/root/delta`;
  const payload = await graphJson(context, url, "microsoft_drive_delta_failed", { deltaExcludeParent: "true" });
  const items = arrayOfObjects(payload.value).map(fileItem).filter((item): item is PullItem => Boolean(item));
  return graphPage(payload, items, pathPrefix);
}

function fileItem(value: Record<string, unknown>): PullItem | null {
  const id = safeExternalId(value.id);
  if (!id) return null;
  const deleted = Boolean(value.deleted);
  const file = asObject(value.file);
  return {
    externalId: id,
    externalVersion: optionalString(value.lastModifiedDateTime, 128),
    etag: optionalString(value.eTag, 512) ?? optionalString(value.cTag, 512),
    deleted,
    data: {
      kind: "document",
      provider: "microsoft",
      title: String(value.name ?? "Document Microsoft 365").slice(0, 160),
      fileName: String(value.name ?? "document").slice(0, 255),
      mimeType: String(file.mimeType ?? "application/octet-stream").slice(0, 120),
      url: String(value.webUrl ?? "").slice(0, 2048),
      modifiedAt: safeDate(value.lastModifiedDateTime),
      sizeBytes: safeNonNegativeInteger(value.size),
      checksum: String(asObject(file.hashes).quickXorHash ?? asObject(file.hashes).sha1Hash ?? "").slice(0, 256),
      deleted,
    },
  };
}

function graphPage(payload: Record<string, unknown>, items: PullItem[], pathPrefix: string): PullPage {
  const next = optionalString(payload["@odata.nextLink"], 65536);
  const delta = optionalString(payload["@odata.deltaLink"], 65536);
  return {
    items,
    hasMore: Boolean(next),
    continuationCursor: next ? validateGraphCursor(next, pathPrefix) : undefined,
    checkpointCursor: next ? undefined : delta ? validateGraphCursor(delta, pathPrefix) : undefined,
  };
}

async function exchangeToken(context: ConnectorRuntimeContext, body: URLSearchParams): Promise<ConnectorTokenSet> {
  const directory = microsoftDirectory(context.connection.configuration);
  const response = await context.fetch(`https://login.microsoftonline.com/${directory}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await safeJson(response);
  if (!response.ok) {
    const code = String(payload.error ?? `http_${response.status}`);
    const description = String(payload.error_description ?? "Échange OAuth Microsoft refusé.");
    throw new ConnectorError(description, {
      code: `microsoft_${code}`,
      retryable: response.status >= 500 || response.status === 429,
      authRequired: response.status === 400 || response.status === 401,
      rateLimited: response.status === 429,
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
    });
  }
  const accessToken = String(payload.access_token ?? "");
  if (!accessToken) throw new ConnectorError("Microsoft n'a pas retourné d'access token.", { code: "microsoft_missing_access_token" });
  return {
    accessToken,
    refreshToken: payload.refresh_token ? String(payload.refresh_token) : undefined,
    tokenType: payload.token_type ? String(payload.token_type) : undefined,
    expiresInSeconds: finitePositive(payload.expires_in),
    scope: typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : undefined,
    idToken: payload.id_token ? String(payload.id_token) : undefined,
  };
}

async function graphJson(context: ConnectorRuntimeContext, url: string, code: string, extraHeaders: Record<string, string> = {}) {
  const response = await context.fetch(url, {
    headers: { authorization: `Bearer ${context.accessToken}`, accept: "application/json", ...extraHeaders },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw graphError(code, response);
  return safeJson(response);
}

function graphError(code: string, response: Response) {
  return new ConnectorError(`Microsoft Graph répond HTTP ${response.status}.`, {
    code,
    retryable: response.status >= 500 || response.status === 408 || response.status === 429,
    authRequired: response.status === 401 || response.status === 403,
    rateLimited: response.status === 429,
    retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
  });
}

function validateGraphCursor(value: string, pathPrefix: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 65536) throw new ConnectorError("Curseur Microsoft invalide.", { code: "microsoft_invalid_cursor" });
  let url: URL;
  try { url = new URL(value); } catch { throw new ConnectorError("Curseur Microsoft invalide.", { code: "microsoft_invalid_cursor" }); }
  if (url.protocol !== "https:" || url.hostname !== "graph.microsoft.com" || !url.pathname.startsWith(pathPrefix)) {
    throw new ConnectorError("Curseur Microsoft hors domaine autorisé.", { code: "microsoft_invalid_cursor" });
  }
  if (url.username || url.password || url.hash) throw new ConnectorError("Curseur Microsoft invalide.", { code: "microsoft_invalid_cursor" });
  return url.toString();
}

function requireCapability(context: ConnectorRuntimeContext, capability: IntegrationCapability) {
  if (!context.connection.capabilities.includes(capability)) throw new ConnectorError(`Capacité Microsoft non activée: ${capability}.`, { code: "microsoft_capability_not_enabled" });
}
function microsoftDirectory(configuration: Record<string, unknown>) { return String(configuration.directoryTenant ?? "organizations").trim() || "organizations"; }
function addressString(value: Record<string, unknown>) { const name = String(value.name ?? "").trim(); const address = String(value.address ?? "").trim(); return address ? (name ? `${name} <${address}>` : address) : name; }
function graphAddress(value: Record<string, unknown>) { return [value.street, value.city, value.state, value.postalCode, value.countryOrRegion].map((item) => String(item ?? "").trim()).filter(Boolean).join(", ").slice(0, 2000); }
function graphDateTime(value: Record<string, unknown>) { const raw = String(value.dateTime ?? "").trim(); if (!raw) return ""; const timezone = String(value.timeZone ?? "UTC"); const candidate = /(?:Z|[+-]\d\d:\d\d)$/i.test(raw) ? raw : timezone.toUpperCase() === "UTC" ? `${raw}Z` : `${raw}Z`; return safeDate(candidate); }
function authHealth(code: string, message: string): ConnectorHealth { return { ok: false, status: "authentication_required", code, message }; }
function rateHealth(retryAfter: string | null): ConnectorHealth { return { ok: false, status: "rate_limited", code: "microsoft_rate_limited", message: "Quota Microsoft temporairement limité.", details: { retryAfterSeconds: parseRetryAfter(retryAfter) } }; }
function parseRetryAfter(value: string | null) { const seconds = Number(value); return Number.isInteger(seconds) && seconds >= 0 ? Math.min(seconds, 86400) : undefined; }
function finitePositive(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined; }
function boundedInteger(value: unknown, fallback: number, min: number, max: number) { const parsed = Number(value); return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function boundedConfigurationInteger(value: unknown, min: number, max: number, label: string) { if (value === undefined || value === null || value === "") return; const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new ConnectorError(`${label} Microsoft invalide.`, { code: "invalid_configuration" }); }
function optionalGraphId(value: unknown, label: string) { if (value === undefined || value === null || value === "") return; const text = String(value); if (text.length > 1024 || /[\r\n\0]/.test(text)) throw new ConnectorError(`${label} Microsoft invalide.`, { code: "invalid_configuration" }); }
function arrayOfObjects(value: unknown) { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : []; }
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function optionalString(value: unknown, max: number) { if (value === undefined || value === null) return undefined; const text = String(value); return text && text.length <= max && !/[\r\n\0]/.test(text) ? text : undefined; }
function safeExternalId(value: unknown) { return optionalString(value, 1024); }
function safeDate(value: unknown) { if (typeof value !== "string" || !value) return ""; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : ""; }
function safeNonNegativeInteger(value: unknown) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined; }
async function safeJson(response: Response): Promise<Record<string, unknown>> { try { const value = await response.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; } }
