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
    status: text("status").notNull().default("active"),
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

export const crmRecords = sqliteTable(
  "crm_records",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    teamId: text("team_id").notNull(),
    ownerId: text("owner_id").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    data: text("data").notNull().default("{}"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_crm_records_tenant_type").on(table.tenantId, table.type),
    index("idx_crm_records_tenant_owner").on(table.tenantId, table.ownerId),
    index("idx_crm_records_tenant_team_type").on(table.tenantId, table.teamId, table.type),
    index("idx_crm_records_tenant_status").on(table.tenantId, table.status),
    uniqueIndex("idx_crm_records_tenant_id").on(table.tenantId, table.id),
  ],
);

export const crmRelations = sqliteTable(
  "crm_relations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    fromRecordId: text("from_record_id").notNull().references(() => crmRecords.id),
    toRecordId: text("to_record_id").notNull().references(() => crmRecords.id),
    relationType: text("relation_type").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_crm_relations_unique").on(
      table.tenantId,
      table.fromRecordId,
      table.toRecordId,
      table.relationType,
    ),
    index("idx_crm_relations_from").on(table.tenantId, table.fromRecordId),
    index("idx_crm_relations_to").on(table.tenantId, table.toRecordId),
  ],
);

export const crmTimelineEvents = sqliteTable(
  "crm_timeline_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull(),
    teamId: text("team_id").notNull(),
    ownerId: text("owner_id").notNull(),
    recordId: text("record_id").notNull().references(() => crmRecords.id),
    eventType: text("event_type").notNull(),
    summary: text("summary").notNull(),
    data: text("data").notNull().default("{}"),
    actorId: text("actor_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_crm_timeline_record").on(table.tenantId, table.recordId, table.createdAt),
    index("idx_crm_timeline_team").on(table.tenantId, table.teamId, table.createdAt),
  ],
);

export const crmConfigurations = sqliteTable(
  "crm_configurations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    active: integer("active").notNull().default(1),
    definition: text("definition").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_crm_config_tenant_kind").on(table.tenantId, table.kind)],
);

export const crmConfigurationVersions = sqliteTable(
  "crm_configuration_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    configurationId: text("configuration_id").notNull().references(() => crmConfigurations.id),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    active: integer("active").notNull(),
    definition: text("definition").notNull().default("{}"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_crm_config_versions_unique").on(
      table.tenantId,
      table.configurationId,
      table.version,
    ),
    index("idx_crm_config_versions_lookup").on(
      table.tenantId,
      table.configurationId,
      table.createdAt,
    ),
  ],
);

export const automationRuns = sqliteTable("automation_runs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  automationId: text("automation_id").notNull(),
  status: text("status").notNull(),
  input: text("input").notNull().default("{}"),
  output: text("output").notNull().default("{}"),
  error: text("error").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    webhookId: text("webhook_id").notNull(),
    direction: text("direction").notNull(),
    event: text("event").notNull(),
    status: text("status").notNull(),
    requestBody: text("request_body").notNull().default("{}"),
    responseCode: integer("response_code"),
    responseBody: text("response_body").notNull().default(""),
    error: text("error").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_webhook_deliveries_lookup").on(
      table.tenantId,
      table.webhookId,
      table.createdAt,
    ),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenantId: text("tenant_id").notNull().default("default"),
    teamId: text("team_id"),
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
  },
  (table) => [
    index("idx_audit_events_tenant_team").on(table.tenantId, table.teamId),
    index("idx_audit_events_tenant_actor").on(table.tenantId, table.actorId),
  ],
);
