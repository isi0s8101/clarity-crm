import { and, eq, sql } from "drizzle-orm";

import { getDb } from "@/db";
import {
  auditEvents,
  memberships,
  organizations,
  rolePermissions,
  teams,
  users,
} from "@/db/schema";

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

  await db
    .insert(organizations)
    .values({ id: DEFAULT_TENANT_ID, name: DEFAULT_TENANT_NAME })
    .onConflictDoNothing();

  await db
    .insert(teams)
    .values({ id: DEFAULT_TEAM_ID, tenantId: DEFAULT_TENANT_ID, name: DEFAULT_TEAM_NAME })
    .onConflictDoNothing();

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

  await seedRolePermissions(DEFAULT_TENANT_ID);

  const existingMembership = await db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, DEFAULT_TENANT_ID),
        eq(memberships.userId, identity.userId),
      ),
    )
    .limit(1);

  let membership = existingMembership[0];
  if (!membership) {
    const membershipCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(memberships)
      .where(eq(memberships.tenantId, DEFAULT_TENANT_ID));

    const role = Number(membershipCount[0]?.count ?? 0) === 0 ? "admin" : "user";
    const inserted = await db
      .insert(memberships)
      .values({
        id: `${DEFAULT_TENANT_ID}:${identity.userId}`,
        tenantId: DEFAULT_TENANT_ID,
        userId: identity.userId,
        teamId: DEFAULT_TEAM_ID,
        role,
      })
      .returning();
    membership = inserted[0];
  }

  return {
    userId: identity.userId,
    email: identity.email,
    displayName: identity.displayName,
    tenantId: membership.tenantId,
    teamId: membership.teamId ?? DEFAULT_TEAM_ID,
    role: membership.role === "admin" ? "admin" : "user",
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
) {
  if (resource.tenantId !== actor.tenantId) return false;
  if (scope === "tenant") return true;
  if (scope === "team") return resource.teamId === actor.teamId;
  return resource.ownerId === actor.userId;
}

export async function audit(actor: AuthContext, input: AuditInput) {
  const db = getDb();
  await db.insert(auditEvents).values({
    tenantId: actor.tenantId,
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
