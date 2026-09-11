import { and, desc, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import { crmNotifications } from "@/db/schema";
import type { AuthContext } from "@/lib/authz";

export async function createNotification(input: {
  tenantId: string;
  recipientId: string;
  type: string;
  message: string;
  resourceType?: string;
  resourceId?: string;
}) {
  const type = input.type.trim().toLowerCase();
  const message = input.message.trim().slice(0, 500);
  if (!/^[a-z][a-z0-9_.:-]{0,79}$/.test(type) || !message) throw new Error("Notification invalide.");
  const inserted = await getDb().insert(crmNotifications).values({
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    recipientId: input.recipientId,
    type,
    message,
    resourceType: (input.resourceType ?? "").slice(0, 80),
    resourceId: (input.resourceId ?? "").slice(0, 160),
  }).returning();
  return inserted[0];
}

export async function listNotifications(actor: AuthContext) {
  return getDb().select().from(crmNotifications).where(
    and(eq(crmNotifications.tenantId, actor.tenantId), eq(crmNotifications.recipientId, actor.userId)),
  ).orderBy(desc(crmNotifications.createdAt)).limit(100);
}

export async function unreadNotificationCount(actor: AuthContext) {
  const rows = await getDb().select({ id: crmNotifications.id }).from(crmNotifications).where(
    and(eq(crmNotifications.tenantId, actor.tenantId), eq(crmNotifications.recipientId, actor.userId), isNull(crmNotifications.readAt)),
  ).limit(1000);
  return rows.length;
}
