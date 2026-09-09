import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id),
    email: text("email").notNull(),
    role: text("role").notNull().default("user"),
    teamId: text("team_id").references(() => teams.id),
    status: text("status").notNull().default("pending"),
    invitedBy: text("invited_by").notNull().references(() => users.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_invitations_tenant_email_pending").on(
      table.tenantId,
      table.email,
      table.status,
    ),
    index("idx_invitations_tenant_status").on(table.tenantId, table.status),
  ],
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id),
    userId: text("user_id").notNull().references(() => users.id),
    teamId: text("team_id").references(() => teams.id),
    role: text("role").notNull().default("user"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_memberships_tenant_user").on(table.tenantId, table.userId),
    index("idx_memberships_tenant_role").on(table.tenantId, table.role),
  ],
);

export const rolePermissions = sqliteTable(
  "role_permissions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id),
    role: text("role").notNull(),
    object: text("object").notNull(),
    action: text("action").notNull(),
    scope: text("scope").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_role_permissions_lookup").on(
      table.tenantId,
      table.role,
      table.object,
      table.action,
    ),
  ],
);

export const opportunities = sqliteTable(
  "opportunities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull().default("default"),
    teamId: text("team_id").notNull().default("default-sales"),
    name: text("name").notNull(),
    company: text("company").notNull(),
    amount: integer("amount").notNull(),
    stage: text("stage").notNull().default("qualification"),
    ownerId: text("owner_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_opportunities_tenant_updated").on(table.tenantId, table.updatedAt),
    index("idx_opportunities_tenant_team").on(table.tenantId, table.teamId),
    index("idx_opportunities_tenant_owner").on(table.tenantId, table.ownerId),
  ],
);

export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: text("tenant_id").notNull().default("default"),
  actorId: text("actor_id").notNull(),
  actorEmail: text("actor_email").notNull(),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull().default("unknown"),
  resourceId: text("resource_id").notNull().default("unknown"),
  result: text("result").notNull().default("success"),
  before: text("before").notNull().default(""),
  after: text("after").notNull().default(""),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  details: text("details").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
