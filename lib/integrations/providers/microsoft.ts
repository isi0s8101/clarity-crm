import {
  ConnectorError,
  type Connector,
  type ConnectorHealth,
  type ConnectorRuntimeContext,
  type ConnectorTokenSet,
  type IntegrationCapability,
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
  normalizeError(error) {
    if (error instanceof ConnectorError) return error;
    return new ConnectorError(error instanceof Error ? error.message : "Erreur Microsoft inconnue.", { code: "microsoft_error", retryable: true });
  },
};

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

function microsoftDirectory(configuration: Record<string, unknown>) {
  return String(configuration.directoryTenant ?? "organizations").trim() || "organizations";
}
function authHealth(code: string, message: string): ConnectorHealth {
  return { ok: false, status: "authentication_required", code, message };
}
function rateHealth(retryAfter: string | null): ConnectorHealth {
  return { ok: false, status: "rate_limited", code: "microsoft_rate_limited", message: "Quota Microsoft temporairement limité.", details: { retryAfterSeconds: parseRetryAfter(retryAfter) } };
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
