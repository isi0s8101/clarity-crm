import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { rolePermissions } from "@/db/schema";
import { resolveAuthContext } from "@/lib/authz";
import type { HelpContext, HelpPermission } from "@/lib/help/types";

export const dynamic = "force-dynamic";

export async function getHelpContext(view = "dashboard"): Promise<HelpContext> {
  const headerList = await headers();
  const actor = await resolveAuthContext({ headers: new Headers(headerList) });
  const permissions = await getDb()
    .select({
      object: rolePermissions.object,
      action: rolePermissions.action,
      scope: rolePermissions.scope,
    })
    .from(rolePermissions)
    .where(and(eq(rolePermissions.tenantId, actor.tenantId), eq(rolePermissions.role, actor.role)));

  return {
    view,
    role: actor.role,
    tenantId: actor.tenantId,
      permissions: permissions as HelpPermission[],
  };
}