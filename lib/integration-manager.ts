import { getPool } from "@/db";
import { audit, requirePermission, type AuthContext } from "@/lib/authz";
import {
  decryptIntegrationValue,
  encryptIntegrationValue,
  generatePkcePair,
  hashOpaque,
  randomOpaque,
  rotateIntegrationEnvelope,
  safeHashEqual,
  type IntegrationEnvelope,
} from "@/lib/integration-crypto.mjs";
import {
  ConnectorError,
  type ConnectorHealth,
  type ConnectorRuntimeContext,
  type IntegrationConnectionConfig,
  type IntegrationConnectionStatus,
} from "@/lib/integrations/connector";
import {
  getIntegrationConnector,
  listIntegrationConnectors,
  suggestedIntegrationScopes,
  validateCapabilities,
} from "@/lib/integrations/registry";

const ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const PROVIDER_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const SECRET_KIND_RE = /^[a-z][a-z0-9._:-]{0,63}$/;
const MANUAL_SECRET_KINDS = new Set(["client_secret", "webhook_secret", "bind_password"]);
const CONNECTION_STATUSES = new Set<IntegrationConnectionStatus>([
  "draft", "connecting", "connected", "degraded", "reauth_required", "rate_limited", "error", "disabled", "revoked",
]);
const MAX_JSON_BYTES = 64 * 1024;
const OAUTH_TTL_SECONDS = 600;

export type IntegrationConnectionView = {
  id: string;
  tenantId: string;
  provider: string;
  name: string;
  status: IntegrationConnectionStatus;
  ownerAdminId: string;
  capabilities: string[];
  scopes: string[];
  configuration: Record<string, unknown>;
  syncPolicy: Record<string, unknown>;
  lastErrorCode: string;
  lastErrorMessage: string;
  lastSuccessAt: string | null;
  disabledAt: string | null;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export async function listConnectorCatalog(actor: AuthContext) {
  await requireIntegrationPermission(actor, "read");
  return listIntegrationConnectors();
}

export async function listIntegrationConnections(actor: AuthContext) {
  await requireIntegrationPermission(actor, "read");
  const result = await getPool().query(
    `SELECT * FROM integration_connections WHERE tenant_id=$1 ORDER BY updated_at DESC, id`,
    [actor.tenantId],
  );
  return result.rows.map(decodeConnection);
}

export async function getIntegrationConnection(actor: AuthContext, connectionId: string) {
  await requireIntegrationPermission(actor, "read");
  return getConnectionForTenant(actor.tenantId, normalizeId(connectionId));
}

export async function createIntegrationConnection(actor: AuthContext, input: {
  provider: string;
  name: string;
  capabilities?: string[];
  scopes?: string[];
  configuration?: Record<string, unknown>;
  syncPolicy?: Record<string, unknown>;
  secrets?: Record<string, string>;
}) {
  await requireIntegrationPermission(actor, "create");
  const provider = normalizeProvider(input.provider);
  const connector = getIntegrationConnector(provider);
  const name = normalizeName(input.name);
  const configuration = normalizeObject(input.configuration, "Configuration invalide.");
  connector.validateConfiguration(configuration);
  const capabilities = normalizeStringArray(input.capabilities ?? [], 32, 120);
  validateCapabilities(connector, capabilities);
  const scopes = normalizeStringArray(input.scopes ?? suggestedIntegrationScopes(provider, capabilities), 64, 512);
  const syncPolicy = normalizeObject(input.syncPolicy, "Politique de synchronisation invalide.");
  assertJsonSize(configuration, "Configuration trop volumineuse.");
  assertJsonSize(syncPolicy, "Politique de synchronisation trop volumineuse.");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO integration_connections
       (id,tenant_id,provider,name,status,owner_admin_id,capabilities,scopes,configuration,sync_policy,created_by,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'draft',$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$5,$10,$10)`,
      [id, actor.tenantId, provider, name, actor.userId, JSON.stringify(capabilities), JSON.stringify(scopes), JSON.stringify(configuration), JSON.stringify(syncPolicy), now],
    );
    for (const [kind, value] of Object.entries(input.secrets ?? {})) {
      if (!MANUAL_SECRET_KINDS.has(kind)) throw new IntegrationValidationError(`Type de secret non autorisé: ${kind}.`);
      await upsertCredentialWithClient(client, actor.tenantId, id, kind, normalizeSecret(value), null, {});
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await audit(actor, {
    action: "integration.created",
    resourceType: "integration_connection",
    resourceId: id,
    result: "success",
    details: { provider, capabilities, scopes, credentialKinds: Object.keys(input.secrets ?? {}) },
  });
  return getConnectionForTenant(actor.tenantId, id);
}

export async function updateIntegrationConnection(actor: AuthContext, connectionId: string, patch: {
  name?: string;
  capabilities?: string[];
  scopes?: string[];
  configuration?: Record<string, unknown>;
  syncPolicy?: Record<string, unknown>;
  status?: "disabled" | "draft";
}) {
  await requireIntegrationPermission(actor, "update");
  const current = await getConnectionForTenant(actor.tenantId, normalizeId(connectionId));
  if (current.status === "revoked") throw new IntegrationConflictError("Une connexion révoquée ne peut pas être modifiée.");
  const connector = getIntegrationConnector(current.provider);
  const name = patch.name === undefined ? current.name : normalizeName(patch.name);
  const configuration = patch.configuration === undefined ? current.configuration : normalizeObject(patch.configuration, "Configuration invalide.");
  connector.validateConfiguration(configuration);
  const capabilities = patch.capabilities === undefined ? current.capabilities : normalizeStringArray(patch.capabilities, 32, 120);
  validateCapabilities(connector, capabilities);
  const scopes = patch.scopes === undefined ? current.scopes : normalizeStringArray(patch.scopes, 64, 512);
  const syncPolicy = patch.syncPolicy === undefined ? current.syncPolicy : normalizeObject(patch.syncPolicy, "Politique de synchronisation invalide.");
  assertJsonSize(configuration, "Configuration trop volumineuse.");
  assertJsonSize(syncPolicy, "Politique de synchronisation trop volumineuse.");
  const status = patch.status ?? current.status;
  if (!CONNECTION_STATUSES.has(status)) throw new IntegrationValidationError("Statut de connexion invalide.");

  await getPool().query(
    `UPDATE integration_connections SET name=$1,capabilities=$2::jsonb,scopes=$3::jsonb,configuration=$4::jsonb,
     sync_policy=$5::jsonb,status=$6,disabled_at=CASE WHEN $6='disabled' THEN CURRENT_TIMESTAMP ELSE disabled_at END,
     updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$7 AND id=$8`,
    [name, JSON.stringify(capabilities), JSON.stringify(scopes), JSON.stringify(configuration), JSON.stringify(syncPolicy), status, actor.tenantId, current.id],
  );
  await audit(actor, {
    action: "integration.updated",
    resourceType: "integration_connection",
    resourceId: current.id,
    result: "success",
    before: publicAuditConnection(current),
    after: { name, capabilities, scopes, configuration, syncPolicy, status },
  });
  return getConnectionForTenant(actor.tenantId, current.id);
}

export async function setIntegrationCredential(actor: AuthContext, connectionId: string, kind: string, value: string, metadata: Record<string, unknown> = {}) {
  await requireIntegrationPermission(actor, "administer");
  const connection = await getConnectionForTenant(actor.tenantId, normalizeId(connectionId));
  const secretKind = normalizeSecretKind(kind);
  if (!MANUAL_SECRET_KINDS.has(secretKind)) throw new IntegrationValidationError("Ce type de credential ne peut pas être défini manuellement.");
  const cleanMetadata = normalizeObject(metadata, "Métadonnées de credential invalides.");
  assertJsonSize(cleanMetadata, "Métadonnées de credential trop volumineuses.");
  await upsertCredential(actor.tenantId, connection.id, secretKind, normalizeSecret(value), null, cleanMetadata);
  await audit(actor, {
    action: "integration.credential_replaced",
    resourceType: "integration_connection",
    resourceId: connection.id,
    result: "success",
    details: { kind: secretKind },
  });
  return listCredentialMetadata(actor, connection.id);
}

export async function listCredentialMetadata(actor: AuthContext, connectionId: string) {
  await requireIntegrationPermission(actor, "read");
  const connection = await getConnectionForTenant(actor.tenantId, normalizeId(connectionId));
  const result = await getPool().query(
    `SELECT secret_kind,key_id,metadata,expires_at,last_rotated_at,created_at,updated_at
     FROM integration_credentials WHERE tenant_id=$1 AND connection_id=$2 ORDER BY secret_kind`,
    [actor.tenantId, connection.id],
  );
  return result.rows.map((row) => ({
    kind: String(row.secret_kind),
    configured: true,
    keyId: String(row.key_id),
    metadata: asObject(row.metadata),
    expiresAt: isoOrNull(row.expires_at),
    lastRotatedAt: iso(row.last_rotated_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));
}

export async function rotateIntegrationCredentials(actor: AuthContext, connectionId: string) {
  await requireIntegrationPermission(actor, "administer");
  const connection = await getConnectionForTenant(actor.tenantId, normalizeId(connectionId));
  const client = await getPool().connect();
  let rotated = 0;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT * FROM integration_credentials WHERE tenant_id=$1 AND connection_id=$2 FOR UPDATE`,
      [actor.tenantId, connection.id],
    );
    for (const row of result.rows) {
      const kind = String(row.secret_kind);
      const envelope = envelopeFromCredentialRow(row);
      const rotation = rotateIntegrationEnvelope(envelope, { aad: credentialAad(actor.tenantId, connection.id, kind) });
      if (!rotation.rotated) continue;
      await client.query(
        `UPDATE integration_credentials SET key_id=$1,iv_b64=$2,auth_tag_b64=$3,ciphertext_b64=$4,
         last_rotated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$5 AND connection_id=$6 AND secret_kind=$7`,
        [rotation.envelope.keyId, rotation.envelope.ivB64, rotation.envelope.authTagB64, rotation.envelope.ciphertextB64, actor.tenantId, connection.id, kind],
      );
      rotated += 1;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(actor, {
    action: "integration.credentials_rotated",
    resourceType: "integration_connection",
    resourceId: connection.id,
    result: "success",
    details: { rotated },
  });
  return { rotated };
}

export async function beginIntegrationAuthorization(actor: AuthContext, connectionId: string, redirectUri: string) {
  await requireIntegrationAuthorization(actor);
  const connection = await getConnectionForTenant(actor.tenantId, normalizeId(connectionId));
  if (connection.status === "disabled" || connection.status === "revoked") throw new IntegrationConflictError("Connexion inactive.");
  const connector = getIntegrationConnector(connection.provider);
  if (!connector.beginAuthorization || !connector.completeAuthorization) throw new IntegrationValidationError("Ce connecteur n'utilise pas OAuth2.");
  const safeRedirectUri = validateOAuthRedirectUri(redirectUri);
  const state = randomOpaque(32);
  const nonce = randomOpaque(32);
  const pkce = generatePkcePair();
  const transactionId = crypto.randomUUID();
  const verifierEnvelope = encryptIntegrationValue(pkce.verifier, {
    aad: oauthVerifierAad(actor.tenantId, connection.id, transactionId),
  });
  const expiresAt = new Date(Date.now() + OAUTH_TTL_SECONDS * 1000).toISOString();
  await getPool().query(
    `INSERT INTO integration_oauth_transactions
     (id,tenant_id,connection_id,initiated_by,state_hash,pkce_challenge,pkce_verifier_key_id,pkce_verifier_iv_b64,
      pkce_verifier_auth_tag_b64,pkce_verifier_ciphertext_b64,nonce_hash,redirect_uri,requested_scopes,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`,
    [transactionId, actor.tenantId, connection.id, actor.userId, hashOpaque(state), pkce.challenge, verifierEnvelope.keyId,
      verifierEnvelope.ivB64, verifierEnvelope.authTagB64, verifierEnvelope.ciphertextB64, hashOpaque(nonce), safeRedirectUri,
      JSON.stringify(connection.scopes), expiresAt],
  );
  await getPool().query(
    `UPDATE integration_connections SET status='connecting',last_error_code='',last_error_message='',updated_at=CURRENT_TIMESTAMP
     WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, connection.id],
  );
  const authorizationUrl = connector.beginAuthorization(toConnectionConfig(connection), {
    redirectUri: safeRedirectUri,
    state,
    codeChallenge: pkce.challenge,
    nonce,
    scopes: connection.scopes,
  });
  await audit(actor, {
    action: "integration.authorization_started",
    resourceType: "integration_connection",
    resourceId: connection.id,
    result: "success",
    details: { provider: connection.provider, scopes: connection.scopes, expiresAt },
  });
  return { authorizationUrl: authorizationUrl.toString(), expiresAt };
}

export async function completeIntegrationAuthorization(actor: AuthContext, input: { state: string; code: string }) {
  await requireIntegrationAuthorization(actor);
  const state = normalizeOpaqueInput(input.state, "State OAuth invalide.");
  const code = normalizeOpaqueInput(input.code, "Code OAuth invalide.", 8192);
  const stateHash = hashOpaque(state);
  const client = await getPool().connect();
  let transaction: Record<string, unknown>;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE integration_oauth_transactions SET used_at=CURRENT_TIMESTAMP
       WHERE tenant_id=$1 AND initiated_by=$2 AND state_hash=$3 AND used_at IS NULL AND expires_at>CURRENT_TIMESTAMP
       RETURNING *`,
      [actor.tenantId, actor.userId, stateHash],
    );
    if (!result.rows[0]) throw new IntegrationAuthorizationError("Contexte OAuth invalide, expiré ou déjà utilisé.");
    transaction = result.rows[0] as Record<string, unknown>;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (!safeHashEqual(String(transaction.state_hash), state)) throw new IntegrationAuthorizationError("State OAuth invalide.");
  const connection = await getConnectionForTenant(actor.tenantId, String(transaction.connection_id));
  const connector = getIntegrationConnector(connection.provider);
  if (!connector.completeAuthorization) throw new IntegrationAuthorizationError("Connecteur OAuth incomplet.");
  const verifier = decryptIntegrationValue({
    algorithm: "aes-256-gcm",
    keyId: String(transaction.pkce_verifier_key_id),
    ivB64: String(transaction.pkce_verifier_iv_b64),
    authTagB64: String(transaction.pkce_verifier_auth_tag_b64),
    ciphertextB64: String(transaction.pkce_verifier_ciphertext_b64),
  }, { aad: oauthVerifierAad(actor.tenantId, connection.id, String(transaction.id)) });

  const runtime = await buildRuntimeContext(connection, crypto.randomUUID(), false);
  let tokens;
  try {
    tokens = await connector.completeAuthorization(runtime, {
      code,
      redirectUri: String(transaction.redirect_uri),
      codeVerifier: verifier,
      scopes: normalizeStringArray(transaction.requested_scopes, 64, 512),
    });
    verifyOidcNonce(transaction, tokens.idToken);
  } catch (error) {
    const normalized = connector.normalizeError(error);
    await recordConnectorFailure(connection, normalized, runtime.correlationId);
    throw normalized;
  }

  const expiresAt = tokens.expiresInSeconds ? new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString() : null;
  await upsertCredential(actor.tenantId, connection.id, "access_token", tokens.accessToken, expiresAt, { tokenType: tokens.tokenType ?? "Bearer" });
  if (tokens.refreshToken) await upsertCredential(actor.tenantId, connection.id, "refresh_token", tokens.refreshToken, null, {});
  const scopes = tokens.scope?.length ? normalizeStringArray(tokens.scope, 64, 512) : connection.scopes;
  await getPool().query(
    `UPDATE integration_connections SET status='connected',scopes=$1::jsonb,last_error_code='',last_error_message='',last_success_at=CURRENT_TIMESTAMP,
     disabled_at=NULL,revoked_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$2 AND id=$3`,
    [JSON.stringify(scopes), actor.tenantId, connection.id],
  );
  await audit(actor, {
    action: "integration.authorization_completed",
    resourceType: "integration_connection",
    resourceId: connection.id,
    result: "success",
    details: { provider: connection.provider, scopes, refreshTokenConfigured: Boolean(tokens.refreshToken) },
  });
  return getConnectionForTenant(actor.tenantId, connection.id);
}

export async function testIntegrationConnection(actor: AuthContext, connectionId: string) {
  await requireIntegrationPermission(actor, "administer");
  const connection = await getConnectionForTenant(actor.tenantId, normalizeId(connectionId));
  if (connection.status === "disabled" || connection.status === "revoked") throw new IntegrationConflictError("Connexion inactive.");
  const connector = getIntegrationConnector(connection.provider);
  const correlationId = crypto.randomUUID();
  const runtime = await buildRuntimeContext(connection, correlationId, true);
  let health: ConnectorHealth;
  try {
    health = await connector.testConnection(runtime);
  } catch (error) {
    const normalized = connector.normalizeError(error);
    health = connectorErrorHealth(normalized);
  }
  await applyHealthResult(connection, health, correlationId);
  await audit(actor, {
    action: "integration.connection_tested",
    resourceType: "integration_connection",
    resourceId: connection.id,
    result: health.ok ? "success" : "failure",
    details: { status: health.status, code: health.code, correlationId },
  });
  return { ...health, correlationId };
}

export async function getIntegrationHealth(actor: AuthContext, connectionId: string) {
  await requireIntegrationLogsPermission(actor);
  const connection = await getConnectionForTenant(actor.tenantId, normalizeId(connectionId));
  const [events, runs, credentials] = await Promise.all([
    getPool().query(
      `SELECT severity,code,message,details,correlation_id,created_at FROM integration_health_events
       WHERE tenant_id=$1 AND connection_id=$2 ORDER BY created_at DESC LIMIT 25`,
      [actor.tenantId, connection.id],
    ),
    getPool().query(
      `SELECT id,resource_type,direction,trigger_kind,status,correlation_id,cursor_before,cursor_after,received,created_count,
       updated_count,skipped_count,failed_count,retry_count,error_code,error_message,started_at,finished_at,created_at
       FROM integration_sync_runs WHERE tenant_id=$1 AND connection_id=$2 ORDER BY created_at DESC LIMIT 25`,
      [actor.tenantId, connection.id],
    ),
    getPool().query(
      `SELECT secret_kind,key_id,expires_at,last_rotated_at FROM integration_credentials
       WHERE tenant_id=$1 AND connection_id=$2 ORDER BY secret_kind`,
      [actor.tenantId, connection.id],
    ),
  ]);
  return {
    connection,
    credentials: credentials.rows.map((row) => ({ kind: String(row.secret_kind), configured: true, keyId: String(row.key_id), expiresAt: isoOrNull(row.expires_at), lastRotatedAt: iso(row.last_rotated_at) })),
    events: events.rows.map((row) => ({ severity: row.severity, code: row.code, message: row.message, details: asObject(row.details), correlationId: row.correlation_id, createdAt: iso(row.created_at) })),
    runs: runs.rows.map(decodeSyncRun),
  };
}

export async function disableIntegrationConnection(actor: AuthContext, connectionId: string) {
  await requireIntegrationPermission(actor, "administer");
  const connection = await getConnectionForTenant(actor.tenantId, normalizeId(connectionId));
  if (connection.status === "revoked") throw new IntegrationConflictError("Connexion déjà révoquée.");
  await getPool().query(
    `UPDATE integration_connections SET status='disabled',disabled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND id=$2`,
    [actor.tenantId, connection.id],
  );
  await audit(actor, { action: "integration.disabled", resourceType: "integration_connection", resourceId: connection.id, result: "success" });
  return getConnectionForTenant(actor.tenantId, connection.id);
}

export async function revokeIntegrationConnection(actor: AuthContext, connectionId: string) {
  await requireIntegrationRevokePermission(actor);
  const connection = await getConnectionForTenant(actor.tenantId, normalizeId(connectionId));
  const connector = getIntegrationConnector(connection.provider);
  const correlationId = crypto.randomUUID();
  let remoteRevocation = "not_supported";
  if (connector.revokeAuthorization) {
    const token = await readCredential(actor.tenantId, connection.id, "refresh_token") ?? await readCredential(actor.tenantId, connection.id, "access_token");
    if (token) {
      try {
        const runtime = await buildRuntimeContext(connection, correlationId, false);
        await connector.revokeAuthorization(runtime, token);
        remoteRevocation = "success";
      } catch (error) {
        remoteRevocation = "failed";
        const normalized = connector.normalizeError(error);
        await insertHealthEvent(connection, "warning", "remote_revocation_failed", normalized.message, { providerCode: normalized.code }, correlationId);
      }
    }
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM integration_credentials WHERE tenant_id=$1 AND connection_id=$2`, [actor.tenantId, connection.id]);
    await client.query(
      `UPDATE integration_connections SET status='revoked',revoked_at=CURRENT_TIMESTAMP,last_error_code='',last_error_message='',updated_at=CURRENT_TIMESTAMP
       WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, connection.id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await audit(actor, {
    action: "integration.revoked",
    resourceType: "integration_connection",
    resourceId: connection.id,
    result: "success",
    details: { remoteRevocation, correlationId },
  });
  return getConnectionForTenant(actor.tenantId, connection.id);
}

export async function refreshIntegrationAccessToken(connection: IntegrationConnectionView, correlationId = crypto.randomUUID()) {
  const connector = getIntegrationConnector(connection.provider);
  if (!connector.refreshAuthorization) return readCredential(connection.tenantId, connection.id, "access_token");
  const accessMeta = await getCredentialRow(connection.tenantId, connection.id, "access_token");
  if (accessMeta?.expires_at && new Date(accessMeta.expires_at as string | Date).getTime() > Date.now() + 120_000) {
    return decryptCredentialRow(accessMeta, connection.tenantId, connection.id, "access_token");
  }
  const refreshToken = await readCredential(connection.tenantId, connection.id, "refresh_token");
  if (!refreshToken) {
    await markConnectionStatus(connection, "reauth_required", "refresh_token_missing", "Réauthentification requise.");
    return null;
  }
  const runtime = await buildRuntimeContext(connection, correlationId, false);
  try {
    const tokens = await connector.refreshAuthorization(runtime, refreshToken);
    const expiresAt = tokens.expiresInSeconds ? new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString() : null;
    await upsertCredential(connection.tenantId, connection.id, "access_token", tokens.accessToken, expiresAt, { tokenType: tokens.tokenType ?? "Bearer" });
    if (tokens.refreshToken) await upsertCredential(connection.tenantId, connection.id, "refresh_token", tokens.refreshToken, null, {});
    await markConnectionStatus(connection, "connected", "", "");
    return tokens.accessToken;
  } catch (error) {
    const normalized = connector.normalizeError(error);
    await recordConnectorFailure(connection, normalized, correlationId);
    if (normalized.authRequired) return null;
    throw normalized;
  }
}

export async function buildRuntimeContext(connection: IntegrationConnectionView, correlationId: string, includeAccessToken: boolean): Promise<ConnectorRuntimeContext> {
  const accessToken = includeAccessToken ? await refreshIntegrationAccessToken(connection, correlationId) : undefined;
  return {
    connection: toConnectionConfig(connection),
    correlationId,
    accessToken: accessToken ?? undefined,
    getSecret: (kind) => readCredential(connection.tenantId, connection.id, normalizeSecretKind(kind)),
    fetch,
  };
}

export async function requireIntegrationSyncPermission(actor: AuthContext) {
  await ensureIntegrationRolePermissions(actor.tenantId);
  return requirePermission(actor, "integration_sync", "administer");
}

export async function requireIntegrationLogsPermission(actor: AuthContext) {
  await ensureIntegrationRolePermissions(actor.tenantId);
  return requirePermission(actor, "integration_logs", "read");
}

export function integrationErrorResponse(error: unknown) {
  if (error instanceof IntegrationValidationError || error instanceof IntegrationAuthorizationError || error instanceof IntegrationNotFoundError || error instanceof IntegrationConflictError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ConnectorError) {
    const status = error.authRequired ? 401 : error.rateLimited ? 429 : error.retryable ? 503 : 400;
    return Response.json({ error: error.message, code: error.code }, { status });
  }
  return null;
}

async function requireIntegrationPermission(actor: AuthContext, action: "read" | "create" | "update" | "administer") {
  await ensureIntegrationRolePermissions(actor.tenantId);
  return requirePermission(actor, "integration", action);
}
async function requireIntegrationAuthorization(actor: AuthContext) {
  await ensureIntegrationRolePermissions(actor.tenantId);
  return requirePermission(actor, "integration_authorization", "administer");
}
async function requireIntegrationRevokePermission(actor: AuthContext) {
  await ensureIntegrationRolePermissions(actor.tenantId);
  return requirePermission(actor, "integration_revoke", "administer");
}

async function ensureIntegrationRolePermissions(tenantId: string) {
  const values: Array<[string, string, string, string]> = [
    ["admin", "integration", "read", "tenant"],
    ["admin", "integration", "create", "tenant"],
    ["admin", "integration", "update", "tenant"],
    ["admin", "integration", "administer", "tenant"],
    ["admin", "integration_authorization", "administer", "tenant"],
    ["admin", "integration_sync", "administer", "tenant"],
    ["admin", "integration_revoke", "administer", "tenant"],
    ["admin", "integration_logs", "read", "tenant"],
  ];
  for (const [role, object, action, scope] of values) {
    const id = `${tenantId}:${role}:${object}:${action}`;
    await getPool().query(
      `INSERT INTO role_permissions(id,tenant_id,role,object,action,scope) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [id, tenantId, role, object, action, scope],
    );
  }
}

async function getConnectionForTenant(tenantId: string, connectionId: string): Promise<IntegrationConnectionView> {
  const result = await getPool().query(`SELECT * FROM integration_connections WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, connectionId]);
  if (!result.rows[0]) throw new IntegrationNotFoundError("Connexion introuvable.");
  return decodeConnection(result.rows[0]);
}

async function upsertCredential(tenantId: string, connectionId: string, kind: string, value: string, expiresAt: string | null, metadata: Record<string, unknown>) {
  const client = await getPool().connect();
  try {
    await upsertCredentialWithClient(client, tenantId, connectionId, kind, value, expiresAt, metadata);
  } finally {
    client.release();
  }
}

async function upsertCredentialWithClient(client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, tenantId: string, connectionId: string, kind: string, value: string, expiresAt: string | null, metadata: Record<string, unknown>) {
  const envelope = encryptIntegrationValue(value, { aad: credentialAad(tenantId, connectionId, kind) });
  await client.query(
    `INSERT INTO integration_credentials
     (id,tenant_id,connection_id,secret_kind,algorithm,key_id,iv_b64,auth_tag_b64,ciphertext_b64,metadata,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
     ON CONFLICT(tenant_id,connection_id,secret_kind) DO UPDATE SET
       algorithm=excluded.algorithm,key_id=excluded.key_id,iv_b64=excluded.iv_b64,auth_tag_b64=excluded.auth_tag_b64,
       ciphertext_b64=excluded.ciphertext_b64,metadata=excluded.metadata,expires_at=excluded.expires_at,
       last_rotated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP`,
    [crypto.randomUUID(), tenantId, connectionId, kind, envelope.algorithm, envelope.keyId, envelope.ivB64, envelope.authTagB64,
      envelope.ciphertextB64, JSON.stringify(metadata), expiresAt],
  );
}

async function readCredential(tenantId: string, connectionId: string, kind: string) {
  const row = await getCredentialRow(tenantId, connectionId, kind);
  return row ? decryptCredentialRow(row, tenantId, connectionId, kind) : null;
}
async function getCredentialRow(tenantId: string, connectionId: string, kind: string) {
  const result = await getPool().query(
    `SELECT * FROM integration_credentials WHERE tenant_id=$1 AND connection_id=$2 AND secret_kind=$3 LIMIT 1`,
    [tenantId, connectionId, kind],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}
function decryptCredentialRow(row: Record<string, unknown>, tenantId: string, connectionId: string, kind: string) {
  return decryptIntegrationValue(envelopeFromCredentialRow(row), { aad: credentialAad(tenantId, connectionId, kind) });
}
function envelopeFromCredentialRow(row: Record<string, unknown>): IntegrationEnvelope {
  return {
    algorithm: "aes-256-gcm",
    keyId: String(row.key_id),
    ivB64: String(row.iv_b64),
    authTagB64: String(row.auth_tag_b64),
    ciphertextB64: String(row.ciphertext_b64),
  };
}

function verifyOidcNonce(transaction: Record<string, unknown>, idToken: string | undefined) {
  const expected = String(transaction.nonce_hash ?? "");
  if (!expected) return;
  if (!idToken) throw new IntegrationAuthorizationError("ID token OIDC absent : nonce non vérifiable.");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new IntegrationAuthorizationError("ID token OIDC invalide.");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new IntegrationAuthorizationError("ID token OIDC invalide.");
  }
  if (!safeHashEqual(expected, String(payload.nonce ?? ""))) throw new IntegrationAuthorizationError("Nonce OIDC invalide.");
}

async function applyHealthResult(connection: IntegrationConnectionView, health: ConnectorHealth, correlationId: string) {
  const status: IntegrationConnectionStatus = health.ok ? "connected"
    : health.status === "authentication_required" ? "reauth_required"
      : health.status === "rate_limited" ? "rate_limited"
        : health.status === "degraded" ? "degraded" : "error";
  await getPool().query(
    `UPDATE integration_connections SET status=$1,last_error_code=$2,last_error_message=$3,
     last_success_at=CASE WHEN $4::boolean THEN CURRENT_TIMESTAMP ELSE last_success_at END,updated_at=CURRENT_TIMESTAMP
     WHERE tenant_id=$5 AND id=$6`,
    [status, health.ok ? "" : health.code, health.ok ? "" : health.message, health.ok, connection.tenantId, connection.id],
  );
  await insertHealthEvent(connection, health.ok ? "info" : health.status === "degraded" || health.status === "rate_limited" ? "warning" : "error", health.code, health.message, health.details ?? {}, correlationId);
}

async function recordConnectorFailure(connection: IntegrationConnectionView, error: ConnectorError, correlationId: string) {
  const status: IntegrationConnectionStatus = error.authRequired ? "reauth_required" : error.rateLimited ? "rate_limited" : "error";
  await markConnectionStatus(connection, status, error.code, error.message);
  await insertHealthEvent(connection, error.rateLimited ? "warning" : "error", error.code, error.message, { retryable: error.retryable, retryAfterSeconds: error.retryAfterSeconds }, correlationId);
}

async function markConnectionStatus(connection: IntegrationConnectionView, status: IntegrationConnectionStatus, code: string, message: string) {
  await getPool().query(
    `UPDATE integration_connections SET status=$1,last_error_code=$2,last_error_message=$3,
     last_success_at=CASE WHEN $1='connected' THEN CURRENT_TIMESTAMP ELSE last_success_at END,updated_at=CURRENT_TIMESTAMP
     WHERE tenant_id=$4 AND id=$5`,
    [status, code.slice(0, 120), message.slice(0, 2000), connection.tenantId, connection.id],
  );
}

async function insertHealthEvent(connection: IntegrationConnectionView, severity: "info" | "warning" | "error", code: string, message: string, details: Record<string, unknown>, correlationId: string) {
  await getPool().query(
    `INSERT INTO integration_health_events(id,tenant_id,connection_id,severity,code,message,details,correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [crypto.randomUUID(), connection.tenantId, connection.id, severity, normalizeHealthCode(code), message.slice(0, 2000) || "Événement intégration", JSON.stringify(sanitizeHealthDetails(details)), correlationId.slice(0, 120)],
  );
}

function connectorErrorHealth(error: ConnectorError): ConnectorHealth {
  return {
    ok: false,
    status: error.authRequired ? "authentication_required" : error.rateLimited ? "rate_limited" : error.retryable ? "degraded" : "failed",
    code: error.code,
    message: error.message,
    details: { retryable: error.retryable, retryAfterSeconds: error.retryAfterSeconds },
  };
}

function toConnectionConfig(connection: IntegrationConnectionView): IntegrationConnectionConfig {
  return {
    id: connection.id,
    tenantId: connection.tenantId,
    provider: connection.provider,
    name: connection.name,
    status: connection.status,
    capabilities: connection.capabilities,
    scopes: connection.scopes,
    configuration: connection.configuration,
    syncPolicy: connection.syncPolicy,
  };
}

function decodeConnection(row: Record<string, unknown>): IntegrationConnectionView {
  const status = String(row.status) as IntegrationConnectionStatus;
  if (!CONNECTION_STATUSES.has(status)) throw new Error("Statut d'intégration inconnu en base.");
  return {
    id: String(row.id), tenantId: String(row.tenant_id), provider: String(row.provider), name: String(row.name), status,
    ownerAdminId: String(row.owner_admin_id), capabilities: normalizeStringArray(row.capabilities, 32, 120), scopes: normalizeStringArray(row.scopes, 64, 512),
    configuration: asObject(row.configuration), syncPolicy: asObject(row.sync_policy), lastErrorCode: String(row.last_error_code ?? ""),
    lastErrorMessage: String(row.last_error_message ?? ""), lastSuccessAt: isoOrNull(row.last_success_at), disabledAt: isoOrNull(row.disabled_at),
    revokedAt: isoOrNull(row.revoked_at), createdBy: String(row.created_by), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}
function decodeSyncRun(row: Record<string, unknown>) {
  return {
    id: String(row.id), resourceType: String(row.resource_type), direction: String(row.direction), triggerKind: String(row.trigger_kind), status: String(row.status),
    correlationId: String(row.correlation_id), cursorBefore: String(row.cursor_before ?? ""), cursorAfter: String(row.cursor_after ?? ""),
    received: Number(row.received ?? 0), created: Number(row.created_count ?? 0), updated: Number(row.updated_count ?? 0), skipped: Number(row.skipped_count ?? 0),
    failed: Number(row.failed_count ?? 0), retryCount: Number(row.retry_count ?? 0), errorCode: String(row.error_code ?? ""), errorMessage: String(row.error_message ?? ""),
    startedAt: isoOrNull(row.started_at), finishedAt: isoOrNull(row.finished_at), createdAt: iso(row.created_at),
  };
}
function publicAuditConnection(connection: IntegrationConnectionView) {
  return { id: connection.id, provider: connection.provider, name: connection.name, status: connection.status, capabilities: connection.capabilities, scopes: connection.scopes, configuration: connection.configuration, syncPolicy: connection.syncPolicy };
}
function validateOAuthRedirectUri(value: string) {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new IntegrationValidationError("Redirect URI OAuth invalide."); }
  const insecureLocal = process.env.CLARITY_ALLOW_INSECURE_LOCAL_OAUTH === "1" && url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !insecureLocal) throw new IntegrationValidationError("Redirect URI OAuth HTTPS requise.");
  if (url.username || url.password || url.hash || url.search) throw new IntegrationValidationError("Redirect URI OAuth invalide.");
  if (url.pathname !== "/api/integrations/oauth/callback") throw new IntegrationValidationError("Callback OAuth non autorisé.");
  const publicBase = String(process.env.CLARITY_PUBLIC_BASE_URL ?? "").trim();
  if (publicBase) {
    let base: URL;
    try { base = new URL(publicBase); } catch { throw new Error("CLARITY_PUBLIC_BASE_URL invalide."); }
    if (url.origin !== base.origin) throw new IntegrationValidationError("Origine du callback OAuth non autorisée.");
  }
  return url.toString();
}
function credentialAad(tenantId: string, connectionId: string, kind: string) { return `clarity:v1.3:${tenantId}:${connectionId}:credential:${kind}`; }
function oauthVerifierAad(tenantId: string, connectionId: string, transactionId: string) { return `clarity:v1.3:${tenantId}:${connectionId}:oauth:${transactionId}`; }
function normalizeProvider(value: string) { const provider = String(value ?? "").trim().toLowerCase(); if (!PROVIDER_RE.test(provider)) throw new IntegrationValidationError("Fournisseur invalide."); return provider; }
function normalizeId(value: string) { const id = String(value ?? "").trim(); if (!ID_RE.test(id)) throw new IntegrationValidationError("Identifiant de connexion invalide."); return id; }
function normalizeName(value: string) { const name = String(value ?? "").trim(); if (!name || name.length > 160) throw new IntegrationValidationError("Nom de connexion invalide."); return name; }
function normalizeSecretKind(value: string) { const kind = String(value ?? "").trim(); if (!SECRET_KIND_RE.test(kind)) throw new IntegrationValidationError("Type de secret invalide."); return kind; }
function normalizeSecret(value: string) { if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 16384) throw new IntegrationValidationError("Secret invalide."); return value; }
function normalizeOpaqueInput(value: string, message: string, max = 2048) { if (typeof value !== "string" || value.length < 8 || value.length > max || /[\r\n\0]/.test(value)) throw new IntegrationAuthorizationError(message); return value; }
function normalizeStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new IntegrationValidationError("Liste invalide.");
  const result = value.map((item) => String(item ?? "").trim());
  if (result.some((item) => !item || item.length > maxLength || /[\r\n\0]/.test(item))) throw new IntegrationValidationError("Liste invalide.");
  return [...new Set(result)];
}
function normalizeObject(value: unknown, message: string): Record<string, unknown> { if (value === undefined || value === null) return {}; if (!value || typeof value !== "object" || Array.isArray(value)) throw new IntegrationValidationError(message); return value as Record<string, unknown>; }
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function assertJsonSize(value: unknown, message: string) { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_JSON_BYTES) throw new IntegrationValidationError(message); }
function iso(value: unknown) { return new Date(value as string | Date).toISOString(); }
function isoOrNull(value: unknown) { return value ? iso(value) : null; }
function normalizeHealthCode(value: string) { const clean = String(value || "integration_event").replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 120); return clean || "integration_event"; }
function sanitizeHealthDetails(value: Record<string, unknown>) {
  const denied = /token|secret|password|authorization|credential|cookie/i;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !denied.test(key)).map(([key, item]) => [key, typeof item === "string" ? item.slice(0, 1000) : item]));
}

export class IntegrationValidationError extends Error { readonly status = 400; }
export class IntegrationAuthorizationError extends Error { readonly status = 400; }
export class IntegrationNotFoundError extends Error { readonly status = 404; }
export class IntegrationConflictError extends Error { readonly status = 409; }
