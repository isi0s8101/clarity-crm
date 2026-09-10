import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { invitationActivationTokens } from "@/db/auth-invitations";
import { invitations, memberships, rolePermissions, teams, users } from "@/db/schema";
import { audit, authErrorResponse, requireAdmin, resolveAuthContext } from "@/lib/authz";
import { CORE_RECORD_TYPES } from "@/lib/crm-policy.js";
import { assertSameOriginMutation } from "@/lib/native-auth";
import { hashOpaqueToken, randomSessionToken } from "@/lib/auth-crypto.js";

const roles = new Set(["admin", "user"]);
const scopes = new Set(["personal", "team", "tenant"]);
const actions = new Set(["read", "create", "update", "delete", "export", "administer"]);
const objects = new Set([
  ...CORE_RECORD_TYPES,
  "crm_record", "crm_relation", "timeline", "crm_configuration",
  "automation", "module", "template", "webhook", "admin", "audit",
]);
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    await requireAdmin(actor);
    const db = getDb();
    const [teamRows, memberRows, permissionRows, invitationRows] = await Promise.all([
      db.select().from(teams).where(eq(teams.tenantId, actor.tenantId)),
      db
        .select({
          id: memberships.id,
          userId: memberships.userId,
          tenantId: memberships.tenantId,
          teamId: memberships.teamId,
          role: memberships.role,
          status: memberships.status,
          email: users.email,
          displayName: users.displayName,
          updatedAt: memberships.updatedAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.tenantId, actor.tenantId)),
      db.select().from(rolePermissions).where(eq(rolePermissions.tenantId, actor.tenantId)),
      db.select().from(invitations).where(eq(invitations.tenantId, actor.tenantId)),
    ]);
    return NextResponse.json({ teams: teamRows, members: memberRows, permissions: permissionRows, invitations: invitationRows });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("admin-access:list", error);
    return NextResponse.json({ error: "Administration indisponible." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requireAdmin(actor);
    const body = (await request.json()) as Record<string, unknown>;
    const intent = typeof body.intent === "string" ? body.intent : "";
    const db = getDb();

    if (intent === "create-team") {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
      if (!name) return NextResponse.json({ error: "Nom d’équipe invalide." }, { status: 400 });
      const id = stableId("team", actor.tenantId, name);
      const inserted = await db
        .insert(teams)
        .values({ id, tenantId: actor.tenantId, name })
        .onConflictDoNothing()
        .returning();
      await audit(actor, { action: "team.created", resourceType: "team", resourceId: id, result: "success", after: { id, name } });
      return NextResponse.json({ item: inserted[0] ?? { id, tenantId: actor.tenantId, name } }, { status: 201 });
    }

    if (intent === "invite-user") {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const role = typeof body.role === "string" && roles.has(body.role) ? body.role : "user";
      const teamId = typeof body.teamId === "string" ? body.teamId : null;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
        return NextResponse.json({ error: "Email invalide." }, { status: 400 });
      }
      if (teamId && !(await teamExists(actor.tenantId, teamId))) {
        return NextResponse.json({ error: "Équipe introuvable." }, { status: 400 });
      }

      const id = stableId("inv", actor.tenantId, email);
      const token = randomSessionToken();
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
      const inserted = await db
        .insert(invitations)
        .values({ id, tenantId: actor.tenantId, email, role, teamId, status: "pending", invitedBy: actor.userId })
        .onConflictDoUpdate({
          target: invitations.id,
          set: { role, teamId, status: "pending", updatedAt: new Date().toISOString() },
        })
        .returning();
      await db
        .insert(invitationActivationTokens)
        .values({ invitationId: id, tokenHash: hashOpaqueToken(token), expiresAt, consumedAt: null })
        .onConflictDoUpdate({
          target: invitationActivationTokens.invitationId,
          set: { tokenHash: hashOpaqueToken(token), expiresAt, consumedAt: null, createdAt: new Date().toISOString() },
        });

      await audit(actor, {
        action: "user.invited",
        resourceType: "invitation",
        resourceId: id,
        result: "success",
        after: { ...inserted[0], activationExpiresAt: expiresAt },
      });
      return NextResponse.json({
        item: inserted[0],
        activation: {
          token,
          expiresAt,
          path: `/activate?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`,
        },
      }, { status: 201 });
    }

    return NextResponse.json({ error: "Action admin inconnue." }, { status: 400 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("admin-access:create", error);
    return NextResponse.json({ error: "Action admin impossible." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    assertSameOriginMutation(request);
    const actor = await resolveAuthContext(request);
    await requireAdmin(actor);
    const body = (await request.json()) as Record<string, unknown>;
    const intent = typeof body.intent === "string" ? body.intent : "";
    const db = getDb();

    if (intent === "update-member") {
      const userId = typeof body.userId === "string" ? body.userId : "";
      const role = typeof body.role === "string" && roles.has(body.role) ? body.role : "";
      const teamId = typeof body.teamId === "string" ? body.teamId : null;
      if (!userId || !role) return NextResponse.json({ error: "Membre invalide." }, { status: 400 });
      if (teamId && !(await teamExists(actor.tenantId, teamId))) {
        return NextResponse.json({ error: "Équipe introuvable." }, { status: 400 });
      }
      const existing = await db
        .select()
        .from(memberships)
        .where(and(eq(memberships.tenantId, actor.tenantId), eq(memberships.userId, userId)))
        .limit(1);
      if (!existing[0]) return NextResponse.json({ error: "Membre introuvable." }, { status: 404 });
      const status = typeof body.status === "string" ? body.status : existing[0].status;
      if (status !== "active" && status !== "disabled") {
        return NextResponse.json({ error: "Statut invalide." }, { status: 400 });
      }
      if (userId === actor.userId && (role !== "admin" || status !== "active")) {
        return NextResponse.json({ error: "Un admin ne peut pas désactiver ou rétrograder son propre compte." }, { status: 400 });
      }
      const updated = await db
        .update(memberships)
        .set({ role, teamId, status, updatedAt: new Date().toISOString() })
        .where(and(eq(memberships.tenantId, actor.tenantId), eq(memberships.userId, userId)))
        .returning();
      await audit(actor, { action: "member.updated", resourceType: "membership", resourceId: existing[0].id, result: "success", before: existing[0], after: updated[0] });
      return NextResponse.json({ item: updated[0] });
    }

    if (intent === "update-permission") {
      const role = typeof body.role === "string" && roles.has(body.role) ? body.role : "";
      const object = typeof body.object === "string" && objects.has(body.object) ? body.object : "";
      const action = typeof body.action === "string" && actions.has(body.action) ? body.action : "";
      const scope = typeof body.scope === "string" && scopes.has(body.scope) ? body.scope : "";
      if (!role || !object || !action || !scope) return NextResponse.json({ error: "Permission invalide." }, { status: 400 });
      if (role === "user" && object === "admin") {
        return NextResponse.json({ error: "Le profil utilisateur ne peut pas administrer." }, { status: 400 });
      }
      const id = `${actor.tenantId}:${role}:${object}:${action}`;
      const before = await db.select().from(rolePermissions).where(eq(rolePermissions.id, id)).limit(1);
      const updated = await db
        .insert(rolePermissions)
        .values({ id, tenantId: actor.tenantId, role, object, action, scope })
        .onConflictDoUpdate({ target: rolePermissions.id, set: { scope } })
        .returning();
      await audit(actor, { action: "permission.updated", resourceType: "role_permission", resourceId: id, result: "success", before: before[0], after: updated[0] });
      return NextResponse.json({ item: updated[0] });
    }

    return NextResponse.json({ error: "Action admin inconnue." }, { status: 400 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("admin-access:update", error);
    return NextResponse.json({ error: "Mise à jour admin impossible." }, { status: 503 });
  }
}

async function teamExists(tenantId: string, teamId: string) {
  const rows = await getDb().select().from(teams).where(and(eq(teams.tenantId, tenantId), eq(teams.id, teamId))).limit(1);
  return Boolean(rows[0]);
}

function stableId(prefix: string, tenantId: string, value: string) {
  return `${prefix}:${tenantId}:${value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}
