import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { rolePermissions } from "@/db/schema";
import { authErrorResponse, resolveAuthContext } from "@/lib/authz";
import { recommendProcedures } from "@/lib/help/resolver.js";
import type { HelpPermission } from "@/lib/help/types";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveAuthContext(request);
    const rows = await getDb()
      .select({
        object: rolePermissions.object,
        action: rolePermissions.action,
        scope: rolePermissions.scope,
      })
      .from(rolePermissions)
      .where(and(eq(rolePermissions.tenantId, actor.tenantId), eq(rolePermissions.role, actor.role)));

    const context = {
      view: request.nextUrl.searchParams.get("view") ?? "dashboard",
      recordType: request.nextUrl.searchParams.get("recordType") ?? undefined,
      action: request.nextUrl.searchParams.get("action") ?? undefined,
      role: actor.role,
      tenantId: actor.tenantId,
      permissions: rows as HelpPermission[],
    };

    return NextResponse.json({
      context,
      recommendations: recommendProcedures(context, 4),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    console.error("help:context", error);
    return NextResponse.json({ error: "Contexte d'aide indisponible." }, { status: 503 });
  }
}