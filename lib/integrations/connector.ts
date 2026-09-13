export type IntegrationConnectionStatus =
  | "draft"
  | "connecting"
  | "connected"
  | "degraded"
  | "reauth_required"
  | "rate_limited"
  | "error"
  | "disabled"
  | "revoked";

export type IntegrationCapability =
  | "mail.read"
  | "mail.send"
  | "calendar.read"
  | "calendar.write"
  | "contacts.read"
  | "contacts.write"
  | "files.read"
  | "files.import"
  | "directory.users.read"
  | "directory.groups.read"
  | "webhook.inbound"
  | "webhook.outbound";

export type IntegrationConnectionConfig = {
  id: string;
  tenantId: string;
  provider: string;
  name: string;
  status: IntegrationConnectionStatus;
  capabilities: string[];
  scopes: string[];
  configuration: Record<string, unknown>;
  syncPolicy: Record<string, unknown>;
};

export type ConnectorMetadata = {
  provider: string;
  label: string;
  category: "workspace" | "automation" | "directory" | "test";
  authorization: "oauth2" | "credentials" | "webhook" | "none";
  documentationUrl?: string;
};

export type ConnectorHealth = {
  ok: boolean;
  status: "healthy" | "degraded" | "authentication_required" | "rate_limited" | "failed";
  code: string;
  message: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
};

export type ConnectorTokenSet = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresInSeconds?: number;
  scope?: string[];
  idToken?: string;
};

export type PullItem = {
  externalId: string;
  externalVersion?: string;
  etag?: string;
  deleted?: boolean;
  data: Record<string, unknown>;
};

export type PullPage = {
  items: PullItem[];
  nextCursor?: string;
  hasMore?: boolean;
  quota?: { retryAfterSeconds?: number; remaining?: number; bucket?: string };
};

export type PushResult = {
  externalId: string;
  externalVersion?: string;
  etag?: string;
};

export type ConnectorRuntimeContext = {
  connection: IntegrationConnectionConfig;
  correlationId: string;
  accessToken?: string;
  getSecret(kind: string): Promise<string | null>;
  fetch: typeof fetch;
};

export type ConnectorAuthorizationInput = {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  nonce?: string;
  scopes: string[];
};

export type ConnectorCompleteAuthorizationInput = {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  scopes: string[];
};

export type Connector = {
  metadata(): ConnectorMetadata;
  capabilities(): readonly IntegrationCapability[];
  validateConfiguration(configuration: Record<string, unknown>): void;
  beginAuthorization?(connection: IntegrationConnectionConfig, input: ConnectorAuthorizationInput): URL;
  completeAuthorization?(context: ConnectorRuntimeContext, input: ConnectorCompleteAuthorizationInput): Promise<ConnectorTokenSet>;
  refreshAuthorization?(context: ConnectorRuntimeContext, refreshToken: string): Promise<ConnectorTokenSet>;
  revokeAuthorization?(context: ConnectorRuntimeContext, token: string): Promise<void>;
  testConnection(context: ConnectorRuntimeContext): Promise<ConnectorHealth>;
  pull?(context: ConnectorRuntimeContext, resourceType: string, cursor?: string): Promise<PullPage>;
  push?(context: ConnectorRuntimeContext, resourceType: string, value: Record<string, unknown>): Promise<PushResult>;
  getHealth?(context: ConnectorRuntimeContext): Promise<ConnectorHealth>;
  normalizeError(error: unknown): ConnectorError;
};

export class ConnectorError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly authRequired: boolean;
  readonly rateLimited: boolean;
  readonly retryAfterSeconds?: number;

  constructor(message: string, options: {
    code?: string;
    retryable?: boolean;
    authRequired?: boolean;
    rateLimited?: boolean;
    retryAfterSeconds?: number;
  } = {}) {
    super(message);
    this.name = "ConnectorError";
    this.code = options.code ?? "connector_error";
    this.retryable = options.retryable ?? false;
    this.authRequired = options.authRequired ?? false;
    this.rateLimited = options.rateLimited ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
