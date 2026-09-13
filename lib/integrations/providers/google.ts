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

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const GMAIL_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_ROOT = "https://www.googleapis.com/calendar/v3";
const PEOPLE_ROOT = "https://people.googleapis.com/v1";
const DRIVE_ROOT = "https://www.googleapis.com/drive/v3";
const CONTINUATION_PREFIX = "g1:";

const CAPABILITIES: readonly IntegrationCapability[] = [
  "mail.read", "mail.send",
  "calendar.read", "calendar.write",
  "contacts.read", "contacts.write",
  "files.read", "files.import",
];

export const GOOGLE_SCOPES: Record<IntegrationCapability, string[]> = {
  "mail.read": ["https://www.googleapis.com/auth/gmail.readonly"],
  "mail.send": ["https://www.googleapis.com/auth/gmail.send"],
  "calendar.read": ["https://www.googleapis.com/auth/calendar.events.readonly"],
  "calendar.write": ["https://www.googleapis.com/auth/calendar.events"],
  "contacts.read": ["https://www.googleapis.com/auth/contacts.readonly"],
  "contacts.write": ["https://www.googleapis.com/auth/contacts"],
  "files.read": ["https://www.googleapis.com/auth/drive.metadata.readonly"],
  "files.import": ["https://www.googleapis.com/auth/drive.readonly"],
  "directory.users.read": [],
  "directory.groups.read": [],
  "webhook.inbound": [],
  "webhook.outbound": [],
};

export function googleScopesForCapabilities(capabilities: string[]) {
  const scopes = new Set(["openid", "email", "profile"]);
  for (const capability of capabilities) {
    const values = GOOGLE_SCOPES[capability as IntegrationCapability] ?? [];
    for (const value of values) scopes.add(value);
  }
  return [...scopes];
}

export const googleConnector: Connector = {
  metadata() {
    return {
      provider: "google",
      label: "Google Workspace",
      category: "workspace",
      authorization: "oauth2",
      documentationUrl: "https://developers.google.com/identity/protocols/oauth2/web-server",
    };
  },
  capabilities() {
    return CAPABILITIES;
  },
  validateConfiguration(configuration) {
    const clientId = String(configuration.clientId ?? "").trim();
    if (!/^[A-Za-z0-9._:-]{8,240}$/.test(clientId)) throw new ConnectorError("Client ID Google invalide.", { code: "invalid_configuration" });
    optionalIdentifier(configuration.calendarId, "calendarId");
  },
  beginAuthorization(connection, input) {
    this.validateConfiguration(connection.configuration);
    const clientId = String(connection.configuration.clientId);
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", input.scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("include_granted_scopes", "true");
    if (input.nonce) url.searchParams.set("nonce", input.nonce);
    if (connection.configuration.forceConsent === true) url.searchParams.set("prompt", "consent");
    return url;
  },
  async completeAuthorization(context, input) {
    const clientSecret = await context.getSecret("client_secret");
    const body = new URLSearchParams({
      client_id: String(context.connection.configuration.clientId),
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    });
    if (clientSecret) body.set("client_secret", clientSecret);
    return exchangeToken(context, body);
  },
  async refreshAuthorization(context, refreshToken) {
    const clientSecret = await context.getSecret("client_secret");
    const body = new URLSearchParams({
      client_id: String(context.connection.configuration.clientId),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    if (clientSecret) body.set("client_secret", clientSecret);
    return exchangeToken(context, body);
  },
  async revokeAuthorization(context, token) {
    const response = await context.fetch(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok && response.status !== 400) throw httpError("google_revoke_failed", response.status);
  },
  async testConnection(context) {
    const started = Date.now();
    if (!context.accessToken) return authHealth("missing_access_token", "Jeton d'accès Google absent.");
    const response = await context.fetch(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${context.accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) return authHealth("google_auth_rejected", "Google refuse les credentials.");
    if (response.status === 429) return rateHealth("google_rate_limited", response.headers.get("retry-after"));
    if (!response.ok) return failedHealth("google_test_failed", `Google répond HTTP ${response.status}.`, Date.now() - started);
    return {
      ok: true,
      status: "healthy",
      code: "ok",
      message: "Connexion Google opérationnelle.",
      latencyMs: Date.now() - started,
    } satisfies ConnectorHealth;
  },
  async pull(context, resourceType, cursor) {
    if (!context.accessToken) throw new ConnectorError("Jeton Google absent.", { code: "google_missing_access_token", authRequired: true });
    if (resourceType === "mail") {
      requireCapability(context, "mail.read");
      return pullGmail(context, cursor);
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
      return pullDrive(context, cursor);
    }
    throw new ConnectorError(`Ressource Google non prise en charge: ${resourceType}.`, { code: "google_resource_unsupported" });
  },
  normalizeError(error) {
    if (error instanceof ConnectorError) return error;
    return new ConnectorError(error instanceof Error ? error.message : "Erreur Google inconnue.", { code: "google_error", retryable: true });
  },
};

async function pullGmail(context: ConnectorRuntimeContext, cursor?: string): Promise<PullPage> {
  const continuation = decodeContinuation(cursor, "mail");
  if (!cursor || continuation?.mode === "full") {
    const checkpoint = continuation?.checkpoint ?? await gmailHistoryId(context);
    const params = new URLSearchParams({ maxResults: "25", labelIds: "INBOX" });
    if (continuation?.pageToken) params.set("pageToken", continuation.pageToken);
    const payload = await googleJson(context, `${GMAIL_ROOT}/messages?${params}`, "gmail_list_failed");
    const summaries = arrayOfObjects(payload.messages);
    const items: PullItem[] = [];
    for (const summary of summaries) {
      const id = safeExternalId(summary.id);
      if (!id) continue;
      items.push(await gmailMessage(context, id));
    }
    const nextPageToken = optionalString(payload.nextPageToken, 8192);
    return {
      items,
      hasMore: Boolean(nextPageToken),
      continuationCursor: nextPageToken ? encodeContinuation({ resource: "mail", mode: "full", pageToken: nextPageToken, checkpoint }) : undefined,
      checkpointCursor: nextPageToken ? undefined : checkpoint,
    };
  }

  const durableHistoryId = cursor;
  const params = new URLSearchParams({ startHistoryId: durableHistoryId, maxResults: "100" });
  if (continuation?.pageToken) params.set("pageToken", continuation.pageToken);
  let payload: Record<string, unknown>;
  try {
    payload = await googleJson(context, `${GMAIL_ROOT}/history?${params}`, "gmail_history_failed", new Set([404]));
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "gmail_history_failed_http_404") {
      throw new ConnectorError("Le checkpoint Gmail a expiré ; une resynchronisation complète est requise.", { code: "google_gmail_history_expired" });
    }
    throw error;
  }
  const added = new Set<string>();
  const deleted = new Set<string>();
  for (const history of arrayOfObjects(payload.history)) {
    for (const entry of arrayOfObjects(history.messagesAdded)) {
      const message = asObject(entry.message);
      const id = safeExternalId(message.id);
      if (id) added.add(id);
    }
    for (const entry of arrayOfObjects(history.messagesDeleted)) {
      const message = asObject(entry.message);
      const id = safeExternalId(message.id);
      if (id) deleted.add(id);
    }
  }
  const items: PullItem[] = [];
  for (const id of added) items.push(await gmailMessage(context, id));
  for (const id of deleted) {
    if (!added.has(id)) items.push({ externalId: id, deleted: true, data: { kind: "mail", provider: "google" } });
  }
  const nextPageToken = optionalString(payload.nextPageToken, 8192);
  const checkpoint = optionalString(payload.historyId, 128) ?? durableHistoryId;
  return {
    items,
    hasMore: Boolean(nextPageToken),
    continuationCursor: nextPageToken ? encodeContinuation({ resource: "mail", mode: "incremental", pageToken: nextPageToken, checkpoint: durableHistoryId }) : undefined,
    checkpointCursor: nextPageToken ? undefined : checkpoint,
  };
}

async function gmailHistoryId(context: ConnectorRuntimeContext) {
  const profile = await googleJson(context, `${GMAIL_ROOT}/profile`, "gmail_profile_failed");
  const historyId = optionalString(profile.historyId, 128);
  if (!historyId) throw new ConnectorError("Google n'a pas retourné de historyId Gmail.", { code: "google_missing_history_id", retryable: true });
  return historyId;
}

async function gmailMessage(context: ConnectorRuntimeContext, id: string): Promise<PullItem> {
  const params = new URLSearchParams({ format: "metadata" });
  for (const header of ["Subject", "From", "To", "Cc", "Message-ID", "Date"]) params.append("metadataHeaders", header);
  const message = await googleJson(context, `${GMAIL_ROOT}/messages/${encodeURIComponent(id)}?${params}`, "gmail_message_failed");
  const headers = arrayOfObjects(asObject(message.payload).headers);
  const header = (name: string) => String(headers.find((entry) => String(entry.name).toLowerCase() === name.toLowerCase())?.value ?? "").slice(0, 4096);
  const labels = Array.isArray(message.labelIds) ? message.labelIds.map(String) : [];
  const internalMs = Number(message.internalDate);
  const receivedAt = Number.isFinite(internalMs) && internalMs > 0 ? new Date(internalMs).toISOString() : safeDate(header("Date"));
  return {
    externalId: id,
    externalVersion: optionalString(message.historyId, 128),
    data: {
      kind: "mail",
      provider: "google",
      threadExternalId: optionalString(message.threadId, 1024) ?? id,
      subject: header("Subject") || "(sans objet)",
      from: header("From"),
      to: header("To"),
      cc: header("Cc"),
      internetMessageId: header("Message-ID"),
      receivedAt,
      bodyPreview: String(message.snippet ?? "").slice(0, 4096),
      direction: labels.includes("SENT") ? "outbound" : "inbound",
      labels: labels.slice(0, 100),
    },
  };
}

async function pullCalendar(context: ConnectorRuntimeContext, cursor?: string): Promise<PullPage> {
  const continuation = decodeContinuation(cursor, "calendar");
  const durable = continuation ? continuation.checkpoint : cursor;
  const calendarId = String(context.connection.configuration.calendarId ?? "primary").trim() || "primary";
  const params = new URLSearchParams({ maxResults: "250", showDeleted: "true", singleEvents: "true" });
  if (durable) params.set("syncToken", durable);
  if (continuation?.pageToken) params.set("pageToken", continuation.pageToken);
  let payload: Record<string, unknown>;
  try {
    payload = await googleJson(context, `${CALENDAR_ROOT}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, "calendar_list_failed", new Set([410]));
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "calendar_list_failed_http_410") {
      throw new ConnectorError("Le syncToken Google Calendar a expiré ; une resynchronisation complète est requise.", { code: "google_calendar_sync_expired" });
    }
    throw error;
  }
  const items = arrayOfObjects(payload.items).map(calendarItem).filter((item): item is PullItem => Boolean(item));
  const nextPageToken = optionalString(payload.nextPageToken, 8192);
  const nextSyncToken = optionalString(payload.nextSyncToken, 65536);
  return {
    items,
    hasMore: Boolean(nextPageToken),
    continuationCursor: nextPageToken ? encodeContinuation({ resource: "calendar", mode: durable ? "incremental" : "full", pageToken: nextPageToken, checkpoint: durable ?? "" }) : undefined,
    checkpointCursor: nextPageToken ? undefined : nextSyncToken,
  };
}

function calendarItem(value: Record<string, unknown>): PullItem | null {
  const id = safeExternalId(value.id);
  if (!id) return null;
  const cancelled = value.status === "cancelled";
  const start = asObject(value.start);
  const end = asObject(value.end);
  const startsAt = googleCalendarDateTime(start);
  const endsAt = googleCalendarDateTime(end);
  return {
    externalId: id,
    externalVersion: optionalString(value.updated, 128),
    etag: optionalString(value.etag, 512),
    deleted: cancelled,
    data: {
      kind: "appointment",
      provider: "google",
      title: String(value.summary ?? "Rendez-vous Google").slice(0, 160),
      startsAt,
      endsAt,
      timezone: String(start.timeZone ?? end.timeZone ?? "UTC").slice(0, 120),
      location: String(value.location ?? "").slice(0, 1000),
      description: String(value.description ?? "").slice(0, 20000),
      htmlLink: String(value.htmlLink ?? "").slice(0, 2048),
      cancelled,
    },
  };
}

async function pullContacts(context: ConnectorRuntimeContext, cursor?: string): Promise<PullPage> {
  const continuation = decodeContinuation(cursor, "contacts");
  const durable = continuation ? continuation.checkpoint : cursor;
  const params = new URLSearchParams({
    personFields: "names,emailAddresses,phoneNumbers,organizations,addresses,metadata",
    pageSize: "500",
    requestSyncToken: "true",
  });
  if (durable) params.set("syncToken", durable);
  if (continuation?.pageToken) params.set("pageToken", continuation.pageToken);
  const payload = await googleJson(context, `${PEOPLE_ROOT}/people/me/connections?${params}`, "contacts_list_failed");
  const items = arrayOfObjects(payload.connections).map(contactItem).filter((item): item is PullItem => Boolean(item));
  const nextPageToken = optionalString(payload.nextPageToken, 8192);
  const nextSyncToken = optionalString(payload.nextSyncToken, 65536);
  return {
    items,
    hasMore: Boolean(nextPageToken),
    continuationCursor: nextPageToken ? encodeContinuation({ resource: "contacts", mode: durable ? "incremental" : "full", pageToken: nextPageToken, checkpoint: durable ?? "" }) : undefined,
    checkpointCursor: nextPageToken ? undefined : nextSyncToken,
  };
}

function contactItem(value: Record<string, unknown>): PullItem | null {
  const id = safeExternalId(value.resourceName);
  if (!id) return null;
  const metadata = asObject(value.metadata);
  const deleted = metadata.deleted === true;
  const names = arrayOfObjects(value.names);
  const emails = arrayOfObjects(value.emailAddresses);
  const phones = arrayOfObjects(value.phoneNumbers);
  const organizations = arrayOfObjects(value.organizations);
  const addresses = arrayOfObjects(value.addresses);
  const name = String(names[0]?.displayName ?? emails[0]?.value ?? "Contact Google").slice(0, 160);
  return {
    externalId: id,
    externalVersion: optionalString(metadata.sources && Array.isArray(metadata.sources) ? asObject(metadata.sources[0]).etag : undefined, 512),
    deleted,
    data: {
      kind: "contact",
      provider: "google",
      title: name,
      email: String(emails[0]?.value ?? "").trim().toLowerCase().slice(0, 254),
      phone: String(phones[0]?.value ?? "").slice(0, 120),
      organization: String(organizations[0]?.name ?? "").slice(0, 240),
      jobTitle: String(organizations[0]?.title ?? "").slice(0, 240),
      address: String(addresses[0]?.formattedValue ?? "").slice(0, 2000),
      deleted,
    },
  };
}

async function pullDrive(context: ConnectorRuntimeContext, cursor?: string): Promise<PullPage> {
  const continuation = decodeContinuation(cursor, "files");
  if (!cursor || continuation?.mode === "full") {
    const checkpoint = continuation?.checkpoint ?? await driveStartPageToken(context);
    const params = new URLSearchParams({
      pageSize: "100",
      q: "trashed = false",
      fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,trashed,version,md5Checksum)",
    });
    if (continuation?.pageToken) params.set("pageToken", continuation.pageToken);
    const payload = await googleJson(context, `${DRIVE_ROOT}/files?${params}`, "drive_files_failed");
    const items = arrayOfObjects(payload.files).map(driveFileItem).filter((item): item is PullItem => Boolean(item));
    const nextPageToken = optionalString(payload.nextPageToken, 8192);
    return {
      items,
      hasMore: Boolean(nextPageToken),
      continuationCursor: nextPageToken ? encodeContinuation({ resource: "files", mode: "full", pageToken: nextPageToken, checkpoint }) : undefined,
      checkpointCursor: nextPageToken ? undefined : checkpoint,
    };
  }

  const durable = continuation ? continuation.checkpoint : cursor;
  const pageToken = continuation?.pageToken ?? durable;
  const params = new URLSearchParams({
    pageToken,
    pageSize: "100",
    includeRemoved: "true",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,size,webViewLink,trashed,version,md5Checksum))",
  });
  const payload = await googleJson(context, `${DRIVE_ROOT}/changes?${params}`, "drive_changes_failed");
  const items = arrayOfObjects(payload.changes).map((change) => driveChangeItem(change)).filter((item): item is PullItem => Boolean(item));
  const nextPageToken = optionalString(payload.nextPageToken, 8192);
  const newStartPageToken = optionalString(payload.newStartPageToken, 65536);
  return {
    items,
    hasMore: Boolean(nextPageToken),
    continuationCursor: nextPageToken ? encodeContinuation({ resource: "files", mode: "incremental", pageToken: nextPageToken, checkpoint: durable }) : undefined,
    checkpointCursor: nextPageToken ? undefined : newStartPageToken,
  };
}

async function driveStartPageToken(context: ConnectorRuntimeContext) {
  const payload = await googleJson(context, `${DRIVE_ROOT}/changes/startPageToken?supportsAllDrives=true`, "drive_start_token_failed");
  const token = optionalString(payload.startPageToken, 65536);
  if (!token) throw new ConnectorError("Google Drive n'a pas retourné de startPageToken.", { code: "google_drive_missing_start_token", retryable: true });
  return token;
}

function driveChangeItem(change: Record<string, unknown>): PullItem | null {
  const fileId = safeExternalId(change.fileId);
  if (!fileId) return null;
  if (change.removed === true) return { externalId: fileId, deleted: true, data: { kind: "document", provider: "google" } };
  return driveFileItem({ ...asObject(change.file), id: fileId });
}

function driveFileItem(value: Record<string, unknown>): PullItem | null {
  const id = safeExternalId(value.id);
  if (!id) return null;
  const deleted = value.trashed === true;
  return {
    externalId: id,
    externalVersion: optionalString(value.version, 128) ?? optionalString(value.modifiedTime, 128),
    deleted,
    data: {
      kind: "document",
      provider: "google",
      title: String(value.name ?? "Document Google Drive").slice(0, 160),
      fileName: String(value.name ?? "document").slice(0, 255),
      mimeType: String(value.mimeType ?? "application/octet-stream").slice(0, 120),
      url: String(value.webViewLink ?? "").slice(0, 2048),
      modifiedAt: safeDate(value.modifiedTime),
      sizeBytes: safeNonNegativeInteger(value.size),
      checksum: String(value.md5Checksum ?? "").slice(0, 128),
      deleted,
    },
  };
}

async function exchangeToken(context: ConnectorRuntimeContext, body: URLSearchParams): Promise<ConnectorTokenSet> {
  const response = await context.fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await safeJson(response);
  if (!response.ok) {
    const code = String(payload.error ?? `http_${response.status}`);
    const description = String(payload.error_description ?? "Échange OAuth Google refusé.");
    throw new ConnectorError(description, {
      code: `google_${code}`,
      retryable: response.status >= 500 || response.status === 429,
      authRequired: response.status === 400 || response.status === 401,
      rateLimited: response.status === 429,
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
    });
  }
  const accessToken = String(payload.access_token ?? "");
  if (!accessToken) throw new ConnectorError("Google n'a pas retourné d'access token.", { code: "google_missing_access_token" });
  return {
    accessToken,
    refreshToken: payload.refresh_token ? String(payload.refresh_token) : undefined,
    tokenType: payload.token_type ? String(payload.token_type) : undefined,
    expiresInSeconds: finitePositive(payload.expires_in),
    scope: typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : undefined,
    idToken: payload.id_token ? String(payload.id_token) : undefined,
  };
}

async function googleJson(
  context: ConnectorRuntimeContext,
  url: string,
  code: string,
  toleratedStatuses = new Set<number>(),
): Promise<Record<string, unknown>> {
  const response = await context.fetch(url, {
    headers: { authorization: `Bearer ${context.accessToken}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    if (toleratedStatuses.has(response.status)) throw new ConnectorError(`Google répond HTTP ${response.status}.`, { code: `${code}_http_${response.status}` });
    throw googleApiError(code, response);
  }
  return safeJson(response);
}

function googleApiError(code: string, response: Response) {
  return new ConnectorError(`Google répond HTTP ${response.status}.`, {
    code,
    retryable: response.status >= 500 || response.status === 408 || response.status === 429,
    authRequired: response.status === 401 || response.status === 403,
    rateLimited: response.status === 429,
    retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
  });
}

function requireCapability(context: ConnectorRuntimeContext, capability: IntegrationCapability) {
  if (!context.connection.capabilities.includes(capability)) {
    throw new ConnectorError(`Capacité Google non activée: ${capability}.`, { code: "google_capability_not_enabled" });
  }
}

function encodeContinuation(value: { resource: string; mode: "full" | "incremental"; pageToken: string; checkpoint: string }) {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (payload.length > 60000) throw new ConnectorError("Curseur Google trop volumineux.", { code: "google_cursor_too_large" });
  return CONTINUATION_PREFIX + payload;
}

function decodeContinuation(value: string | undefined, resource: string) {
  if (!value?.startsWith(CONTINUATION_PREFIX)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value.slice(CONTINUATION_PREFIX.length), "base64url").toString("utf8")) as Record<string, unknown>;
    if (decoded.resource !== resource || !["full", "incremental"].includes(String(decoded.mode))) throw new Error("resource");
    const pageToken = optionalString(decoded.pageToken, 8192);
    const checkpoint = optionalString(decoded.checkpoint, 65536) ?? "";
    if (!pageToken) throw new Error("pageToken");
    return { mode: decoded.mode as "full" | "incremental", pageToken, checkpoint };
  } catch {
    throw new ConnectorError("Curseur Google invalide.", { code: "google_invalid_cursor" });
  }
}

function googleCalendarDateTime(value: Record<string, unknown>) {
  if (typeof value.dateTime === "string") return safeDate(value.dateTime);
  if (typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) return `${value.date}T00:00:00.000Z`;
  return "";
}
function arrayOfObjects(value: unknown) { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : []; }
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function optionalString(value: unknown, max: number) { if (value === undefined || value === null) return undefined; const text = String(value); return text && text.length <= max && !/[\r\n\0]/.test(text) ? text : undefined; }
function safeExternalId(value: unknown) { return optionalString(value, 1024); }
function safeDate(value: unknown) { if (typeof value !== "string" || !value) return ""; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : ""; }
function safeNonNegativeInteger(value: unknown) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined; }
function optionalIdentifier(value: unknown, label: string) { if (value === undefined || value === null || value === "") return; const text = String(value); if (text.length > 512 || /[\r\n\0]/.test(text)) throw new ConnectorError(`${label} Google invalide.`, { code: "invalid_configuration" }); }
function authHealth(code: string, message: string): ConnectorHealth { return { ok: false, status: "authentication_required", code, message }; }
function rateHealth(code: string, retryAfter: string | null): ConnectorHealth { return { ok: false, status: "rate_limited", code, message: "Quota Google temporairement limité.", details: { retryAfterSeconds: parseRetryAfter(retryAfter) } }; }
function failedHealth(code: string, message: string, latencyMs?: number): ConnectorHealth { return { ok: false, status: "failed", code, message, latencyMs }; }
function httpError(code: string, status: number) { return new ConnectorError(`Google répond HTTP ${status}.`, { code, retryable: status >= 500 || status === 429, rateLimited: status === 429 }); }
function parseRetryAfter(value: string | null) { const seconds = Number(value); return Number.isInteger(seconds) && seconds >= 0 ? Math.min(seconds, 86400) : undefined; }
function finitePositive(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined; }
async function safeJson(response: Response): Promise<Record<string, unknown>> { try { const value = await response.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; } }
