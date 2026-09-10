import { and, eq, sql } from "drizzle-orm";

import { getDb } from "@/db";
import {
  auditEvents,
  invitations,
  memberships,
  organizations,
  rolePermissions,
  teams,
  users,
} from "@/db/schema";
import { resolveAccessSelection } from "./access-resolution.js";
import { canUseScopedResource, tenantSelectorFromHeaders } from "./authz-policy.js";
import { CORE_RECORD_TYPES } from "./crm-policy.js";

export type PermissionAction =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "export"
  | "administer";

export type PermissionScope = "personal" | "team" | "tenant";

export type AuthContext = {
  userId: string;
  email: string;
  displayName: string;
  tenantId: string;
  teamId: string;
  role: "admin" | "user";
};

type RequestLike = {
  headers: Headers;
};

type AuditInput = {
  action: string;
  resourceType: string;
  resourceId: string;
  result: "success" | "denied" | "failure";
  before?: unknown;
  after?: unknown;
  details?: unknown;
};

const DEFAULT_TENANT_ID = "default";
const DEFAULT_TENANT_NAME = "Clarity CRM";
const DEFAULT_TEAM_ID = "default-sales";
const DEFAULT_TEAM_NAME = "Équipe commerciale";

const CRM_PERMISSION_OBJECTS = [...CORE_RECORD_TYPES, "crm_record"];

const defaultPermissions: Record<
  AuthContext["role"],
  Array<[string, PermissionAction, PermissionScope]>
> = {
  admin: [
    ["opportunity", "read", "tenant"],
    ["opportunity", "create", "tenant"],
    ["opportunity", "update", "tenant"],
    ["opportunity", "delete", "tenant"],
    ["opportunity", "export", "tenant"],
    ["opportunity", "administer", "tenant"],
    ...CRM_PERMISSION_OBJECTS.flatMap((object) => [
      [object, "read", "tenant"] as [string, PermissionAction, PermissionScope],
      [object, "create", "tenant"] as [string, PermissionAction, PermissionScope],
      [object, "update", "tenant"] as [string, PermissionAction, PermissionScope],
      [object, "delete", "tenant"] as [string, PermissionAction, PermissionScope],
      [object, "export", "tenant"] as [string, PermissionAction, PermissionScope],
    ]),
    ["crm_relation", "read", "tenant"],
    ["crm_relation", "create", "tenant"],
    ["crm_relation", "delete", "tenant"],
    ["timeline", "read", "tenant"],
    ["timeline", "create", "tenant"],
    ["crm_configuration", "read", "tenant"],
    ["crm_configuration", "administer", "tenant"],
    ["automation", "read", "tenant"],
    ["automation", "administer", "tenant"],
    ["module", "read", "tenant"],
    ["module", "administer", "tenant"],
    ["template", "read", "tenant"],
    ["template", "administer", "tenant"],
    ["webhook", "read", "tenant"],
    ["webhook", "administer", "tenant"],
    ["admin", "read", "tenant"],
    ["admin", "administer", "tenant"],
    ["audit", "read", "tenant"],
    ["audit", "export", "tenant"],
  ],
  user: [
    ["opportunity", "read", "team"],
    ["opportunity", "create", "team"],
    ["opportunity", "update", "team"],
    ["opportunity", "export", "personal"],
    ...CRM_PERMISSION_OBJECTS.flatMap((object) => [
      [object, "read", "team"] as [string, PermissionAction, PermissionScope],
      [object, "create", "team"] as [string, PermissionAction, PermissionScope],
      [object, "update", "team"] as [string, PermissionAction, PermissionScope],
      [object, "delete", "personal"] as [string, PermissionAction, PermissionScope],
      [object, "export", "personal"] as [string, PermissionAction, PermissionScope],
    ]),
    ["crm_relation", "read", "team"],
    ["crm_relation", "create", "team"],
    ["crm_relation", "delete", "personal"],
    ["timeline", "read", "team"],
    ["timeline", "create", "team"],
    ["crm_configuration", "read", "tenant"],
    ["automation", "read", "tenant"],
    ["module", "read", "tenant"],
    ["template", "read", "tenant"],
    ["audit", "read", "personal"],
  ],
};

export class AuthRequiredError extends Error {
  status = 401;
}

export class ForbiddenError extends Error {
  status = 403;
}

export function readAuthenticatedIdentity(request: RequestLike) {
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  const email = request.headers
    .get("oai-authenticated-user-email")
    ?.trim()
    .toLowerCase();

  if (!userId || !email) {
    throw new AuthRequiredError("Authentification obligatoire.");
  }

  const encodedFullName = request.headers.get("oai-authenticated-user-full-name");
  const fullNameEncoding = request.headers.get(
    "oai-authenticated-user-full-name-encoding",
  );
  const decodedName =
    encodedFullName && fullNameEncoding === "percent-encoded-utf-8"
      ? safeDecodeURIComponent(encodedFullName)
      : null;

  return {
    userId,
    email,
    displayName: decodedName || email,
  };
}

export async function resolveAuthContext(
  request: RequestLike,
): Promise<AuthContext> {
  const identity = readAuthenticatedIdentity(request);
  const db = getDb();
  const selector = tenantSelectorFromHeaders(request.headers);
  const tenantSelector = selector.value;

  if (selector.present && !tenantSelector) {
    throw new ForbiddenError("Tenant invalide.");
  }

  const [membershipRows, pendingInvitationRows, membershipCountRows] = await Promise.all([
    db.select().from(memberships).where(eq(memberships.userId, identity.userId)),
    db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.email, identity.email),
          eq(invitations.status, "pending"),
        ),
      ),
    db.select({ count: sql<number>`count(*)` }).from(memberships),
  ]);

  const access = resolveAccessSelection({
    tenantSelector,
    memberships: membershipRows,
    pendingInvitations: pendingInvitationRows,
    totalMembershipCount: Number(membershipCountRows[0]?.count ?? 0),
  });

  if (access.kind === "denied") {
    if (access.reason === "tenant_selection_required") {
      throw new ForbiddenError("Sélection explicite du tenant requise.");
    }
    if (access.reason === "invitation_required") {
      throw new ForbiddenError("Invitation requise pour rejoindre une organisation.");
    }
    throw new ForbiddenError("Accès au tenant refusé.");
  }

  const membership = access.kind === "membership" ? access.membership : null;
  const pendingInvitation = access.kind === "invitation" ? access.invitation : null;

  if (membership && membership.status !== "active") {
    throw new ForbiddenError("Compte désactivé.");
  }

  let tenantId: string;
  let teamId: string;
  let role: "admin" | "user";

  if (membership) {
    tenantId = membership.tenantId;
    teamId = await resolveTeamForTenant(tenantId, membership.teamId);
    role = membership.role === "admin" ? "admin" : "user";

    if (!membership.teamId) {
      await db
        .update(memberships)
        .set({ teamId, updatedAt: new Date().toISOString() })
        .where(eq(memberships.id, membership.id));
    }
  } else if (pendingInvitation) {
    tenantId = pendingInvitation.tenantId;
    await requireOrganization(tenantId);
    teamId = await resolveTeamForTenant(tenantId, pendingInvitation.teamId);
    role = pendingInvitation.role === "admin" ? "admin" : "user";

    await upsertUser(identity);
    await db.insert(memberships).values({
      id: `${tenantId}:${identity.userId}`,
      tenantId,
      userId: identity.userId,
      teamId,
      role,
      status: "active",
    });
    await db
      .update(invitations)
      .set({ status: "accepted", updatedAt: new Date().toISOString() })
      .where(eq(invitations.id, pendingInvitation.id));
  } else {
    tenantId = DEFAULT_TENANT_ID;
    await ensureBootstrapTenant();
    teamId = DEFAULT_TEAM_ID;
    role = "admin";

    await upsertUser(identity);
    await db.insert(memberships).values({
      id: `${tenantId}:${identity.userId}`,
      tenantId,
      userId: identity.userId,
      teamId,
      role,
      status: "active",
    });
  }

  await upsertUser(identity);
  await seedRolePermissions(tenantId);

  return {
    userId: identity.userId,
    email: identity.email,
    displayName: identity.displayName,
    tenantId,
    teamId,
    role,
  };
}

export async function requirePermission(
  actor: AuthContext,
  object: string,
  action: PermissionAction,
): Promise<PermissionScope> {
  const scope = await getPermissionScope(actor, object, action);
  if (!scope) {
    throw new ForbiddenError("Autorisation insuffisante.");
  }
  return scope;
}

export async function requireRecordPermission(
  actor: AuthContext,
  type: string,
  action: PermissionAction,
): Promise<PermissionScope> {
  const exact = await getPermissionScope(actor, type, action);
  if (exact) return exact;
  const generic = await getPermissionScope(actor, "crm_record", action);
  if (generic) return generic;
  throw new ForbiddenError("Autorisation insuffisante.");
}

export async function requireAdmin(actor: AuthContext) {
  await requirePermission(actor, "admin", "administer");
}

export async function getPermissionScope(
  actor: AuthContext,
  object: string,
  action: PermissionAction,
): Promise<PermissionScope | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(rolePermissions)
    .where(
      and(
        eq(rolePermissions.tenantId, actor.tenantId),
        eq(rolePermissions.role, actor.role),
        eq(rolePermissions.object, object),
        eq(rolePermissions.action, action),
      ),
    )
    .limit(1);

  const scope = rows[0]?.scope;
  return scope === "tenant" || scope === "team" || scope === "personal"
    ? scope
    : null;
}

export function canUseResource(
  actor: AuthContext,
  scope: PermissionScope,
  resource: { tenantId: string; teamId: string; ownerId: string },
): boolean {
  return Boolean(canUseScopedResource(actor, scope, resource));
}

export async function audit(actor: AuthContext, input: AuditInput) {
  const db = getDb();
  await db.insert(auditEvents).values({
    tenantId: actor.tenantId,
    teamId: actor.teamId || null,
    actorId: actor.userId,
    actorEmail: actor.email,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    result: input.result,
    before: input.before === undefined ? "" : JSON.stringify(input.before),
    after: input.after === undefined ? "" : JSON.stringify(input.after),
    entityType: input.resourceType,
    entityId: input.resourceId,
    details: input.details === undefined ? "" : JSON.stringify(input.details),
  });
}

export function authErrorResponse(error: unknown) {
  if (error instanceof AuthRequiredError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ForbiddenError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return null;
}

async function upsertUser(identity: {
  userId: string;
  email: string;
  displayName: string;
}) {
  const db = getDb();
  await db
    .insert(users)
    .values({
      id: identity.userId,
      email: identity.email,
      displayName: identity.displayName,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: identity.email,
        displayName: identity.displayName,
        updatedAt: new Date().toISOString(),
      },
    });
}

async function requireOrganization(tenantId: string) {
  const db = getDb();
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, tenantId))
    .limit(1);
  if (!rows[0]) {
    throw new ForbiddenError("Organisation introuvable.");
  }
}

async function ensureBootstrapTenant() {
  const db = getDb();
  await db
    .insert(organizations)
    .values({ id: DEFAULT_TENANT_ID, name: DEFAULT_TENANT_NAME })
    .onConflictDoNothing();
  await db
    .insert(teams)
    .values({ id: DEFAULT_TEAM_ID, tenantId: DEFAULT_TENANT_ID, name: DEFAULT_TEAM_NAME })
    .onConflictDoNothing();
}

async function resolveTeamForTenant(tenantId: string, requestedTeamId: string | null) {
  const db = getDb();
  if (requestedTeamId) {
    const rows = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, requestedTeamId), eq(teams.tenantId, tenantId)))
      .limit(1);
    if (!rows[0]) {
      throw new ForbiddenError("Équipe incohérente avec le tenant.");
    }
    return requestedTeamId;
  }

  const defaultTeamId =
    tenantId === DEFAULT_TENANT_ID ? DEFAULT_TEAM_ID : `team:${tenantId}:default`;
  await db
    .insert(teams)
    .values({ id: defaultTeamId, tenantId, name: DEFAULT_TEAM_NAME })
    .onConflictDoNothing();
  return defaultTeamId;
}

async function seedRolePermissions(tenantId: string) {
  const db = getDb();
  const values = Object.entries(defaultPermissions).flatMap(([role, permissions]) =>
    permissions.map(([object, action, scope]) => ({
      id: `${tenantId}:${role}:${object}:${action}`,
      tenantId,
      role,
      object,
      action,
      scope,
    })),
  );

  await db.insert(rolePermissions).values(values).onConflictDoNothing();
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
