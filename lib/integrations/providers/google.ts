import {
  ConnectorError,
  type Connector,
  type ConnectorHealth,
  type ConnectorRuntimeContext,
  type ConnectorTokenSet,
  type IntegrationCapability,
} from "@/lib/integrations/connector";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

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
  normalizeError(error) {
    if (error instanceof ConnectorError) return error;
    return new ConnectorError(error instanceof Error ? error.message : "Erreur Google inconnue.", { code: "google_error", retryable: true });
  },
};

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

function authHealth(code: string, message: string): ConnectorHealth {
  return { ok: false, status: "authentication_required", code, message };
}
function rateHealth(code: string, retryAfter: string | null): ConnectorHealth {
  return { ok: false, status: "rate_limited", code, message: "Quota Google temporairement limité.", details: { retryAfterSeconds: parseRetryAfter(retryAfter) } };
}
function failedHealth(code: string, message: string, latencyMs?: number): ConnectorHealth {
  return { ok: false, status: "failed", code, message, latencyMs };
}
function httpError(code: string, status: number) {
  return new ConnectorError(`Google répond HTTP ${status}.`, { code, retryable: status >= 500 || status === 429, rateLimited: status === 429 });
}
function parseRetryAfter(value: string | null) {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 0 ? Math.min(seconds, 86400) : undefined;
}
function finitePositive(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
