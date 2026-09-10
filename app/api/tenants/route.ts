import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { invitations, memberships, organizations } from "@/db/schema";
import {
  authErrorResponse,
  readAuthenticatedIdentity,
} from "@/lib/authz";

export async function GET(request: NextRequest) {
  try {
    const identity = readAuthenticatedIdentity(request);
    const db = getDb();

    const [memberRows, invitationRows] = await Promise.all([
      db
        .select({
          tenantId: memberships.tenantId,
          name: organizations.name,
          role: memberships.role,
          teamId: memberships.teamId,
          status: memberships.status,
        })
        .from(memberships)
        .innerJoin(organizations, eq(organizations.id, memberships.tenantId))
        .where(eq(memberships.userId, identity.userId)),
      db
        .select({
          tenantId: invitations.tenantId,
          name: organizations.name,
          role: invitations.role,
          teamId: invitations.teamId,
          status: invitations.status,
        })
        .from(invitations)
        .innerJoin(organizations, eq(organizations.id, invitations.tenantId))
        .where(
          and(
            eq(invitations.email, identity.email),
            eq(invitations.status, "pending"),
          ),
        ),
    ]);

    const items = new Map<
      string,
      {
        tenantId: string;
        name: string;
        role: "admin" | "user";
        teamId: string | null;
        access: "membership" | "invitation";
        status: string;
      }
    >();

    for (const row of memberRows) {
      items.set(row.tenantId, {
        tenantId: row.tenantId,
        name: row.name,
        role: row.role === "admin" ? "admin" : "user",
        teamId: row.teamId,
        access: "membership",
        status: row.status,
      });
    }

    for (const row of invitationRows) {
      if (items.has(row.tenantId)) continue;
      items.set(row.tenantId, {
        tenantId: row.tenantId,
        name: row.name,
        role: row.role === "admin" ? "admin" : "user",
        teamId: row.teamId,
        access: "invitation",
        status: row.status,
      });
    }

    return NextResponse.json({ items: [...items.values()] });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("tenants:list", error);
    return NextResponse.json({ error: "Organisations indisponibles." }, { status: 503 });
  }
}
