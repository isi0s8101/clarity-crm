import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("idx_users_email").on(table.email)],
);

export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("idx_teams_tenant_id").on(table.tenantId, table.id)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("user"),
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    invitedBy: text("invited_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_invitations_tenant_email_status").on(table.tenantId, table.email, table.status),
    index("idx_invitations_tenant_status").on(table.tenantId, table.status),
    index("idx_invitations_email_status").on(table.email, table.status),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
    role: text("role").notNull().default("user"),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_memberships_tenant_user").on(table.tenantId, table.userId),
    index("idx_memberships_user_status").on(table.userId, table.status),
    index("idx_memberships_tenant_role").on(table.tenantId, table.role),
  ],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    object: text("object").notNull(),
    action: text("action").notNull(),
    scope: text("scope").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("idx_role_permissions_lookup").on(table.tenantId, table.role, table.object, table.action),
  ],
);

export const opportunities = pgTable(
  "opportunities",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("default"),
    teamId: text("team_id").notNull().default("default-sales"),
    name: text("name").notNull(),
    company: text("company").notNull(),
    amount: integer("amount").notNull(),
    stage: text("stage").notNull().default("qualification"),
    ownerId: text("owner_id").notNull(),
    ownerEmail: text("owner_email").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("idx_opportunities_tenant_updated").on(table.tenantId, table.updatedAt),
    index("idx_opportunities_tenant_team").on(table.tenantId, table.teamId),
    index("idx_opportunities_tenant_owner").on(table.tenantId, table.ownerId),
  ],
);

export const crmRecords = pgTable(
  "crm_records",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "restrict" }),
    ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    data: text("data").notNull().default("{}"),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("idx_crm_records_tenant_type").on(table.tenantId, table.type),
    index("idx_crm_records_tenant_owner").on(table.tenantId, table.ownerId),
    index("idx_crm_records_tenant_team_type").on(table.tenantId, table.teamId, table.type),
    index("idx_crm_records_tenant_status").on(table.tenantId, table.status),
    uniqueIndex("idx_crm_records_tenant_id").on(table.tenantId, table.id),
  ],
);

export const crmRelations = pgTable(
  "crm_relations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    fromRecordId: text("from_record_id").notNull().references(() => crmRecords.id, { onDelete: "cascade" }),
    toRecordId: text("to_record_id").notNull().references(() => crmRecords.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull(),
    createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("idx_crm_relations_unique").on(table.tenantId, table.fromRecordId, table.toRecordId, table.relationType),
    index("idx_crm_relations_from").on(table.tenantId, table.fromRecordId),
    index("idx_crm_relations_to").on(table.tenantId, table.toRecordId),
  ],
);

export const crmTimelineEvents = pgTable(
  "crm_timeline_events",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "restrict" }),
    ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    recordId: text("record_id").notNull().references(() => crmRecords.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    summary: text("summary").notNull(),
    data: text("data").notNull().default("{}"),
    actorId: text("actor_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_crm_timeline_record").on(table.tenantId, table.recordId, table.createdAt),
    index("idx_crm_timeline_team").on(table.tenantId, table.teamId, table.createdAt),
  ],
);

export const crmConfigurations = pgTable(
  "crm_configurations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    active: integer("active").notNull().default(1),
    definition: text("definition").notNull().default("{}"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("idx_crm_config_tenant_kind").on(table.tenantId, table.kind)],
);

export const crmConfigurationVersions = pgTable(
  "crm_configuration_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    configurationId: text("configuration_id").notNull().references(() => crmConfigurations.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    active: integer("active").notNull(),
    definition: text("definition").notNull().default("{}"),
    createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("idx_crm_config_versions_unique").on(table.tenantId, table.configurationId, table.version),
    index("idx_crm_config_versions_lookup").on(table.tenantId, table.configurationId, table.createdAt),
  ],
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    automationId: text("automation_id").notNull(),
    status: text("status").notNull(),
    input: text("input").notNull().default("{}"),
    output: text("output").notNull().default("{}"),
    error: text("error").notNull().default(""),
    correlationId: text("correlation_id").notNull().default(""),
    depth: integer("depth").notNull().default(0),
    attempt: integer("attempt").notNull().default(1),
    createdAt: createdAt(),
  },
  (table) => [index("idx_automation_runs_tenant_created").on(table.tenantId, table.createdAt)],
);

export const crmDocuments = pgTable(
  "crm_documents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    recordId: text("record_id").notNull().references(() => crmRecords.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    originalName: text("original_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    uploadedBy: text("uploaded_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    category: text("category").notNull().default(""),
    tags: text("tags").notNull().default("[]"),
    description: text("description").notNull().default(""),
    currentVersion: integer("current_version").notNull().default(1),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("idx_crm_documents_storage_key").on(table.storageKey),
    index("idx_crm_documents_record").on(table.tenantId, table.recordId, table.status, table.createdAt),
  ],
);

export const crmDocumentVersions = pgTable(
  "crm_document_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    documentId: text("document_id").notNull().references(() => crmDocuments.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    storageKey: text("storage_key").notNull(),
    originalName: text("original_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    addedBy: text("added_by").notNull().references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("idx_document_versions_unique").on(table.documentId, table.version),
    uniqueIndex("idx_document_versions_storage").on(table.storageKey),
    index("idx_document_versions_lookup").on(table.tenantId, table.documentId, table.version),
  ],
);

export const crmNotifications = pgTable(
  "crm_notifications",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    recipientId: text("recipient_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    message: text("message").notNull(),
    resourceType: text("resource_type").notNull().default(""),
    resourceId: text("resource_id").notNull().default(""),
    readAt: timestamp("read_at", { withTimezone: true, mode: "string" }),
    createdAt: createdAt(),
  },
  (table) => [index("idx_crm_notifications_recipient").on(table.tenantId, table.recipientId, table.readAt, table.createdAt)],
);

export const crmImportJobs = pgTable(
  "crm_import_jobs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    objectType: text("object_type").notNull(),
    status: text("status").notNull(),
    sourceName: text("source_name").notNull(),
    totalRows: integer("total_rows").notNull(),
    importedRows: integer("imported_rows").notNull(),
    rejectedRows: integer("rejected_rows").notNull(),
    report: text("report").notNull().default("{}"),
    createdAt: createdAt(),
  },
  (table) => [index("idx_crm_import_jobs_tenant_created").on(table.tenantId, table.createdAt)],
);

export const savedViews = pgTable(
  "saved_views",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
    scope: text("scope").notNull().default("personal"),
    objectType: text("object_type").notNull(),
    name: text("name").notNull(),
    definition: text("definition").notNull().default("{}"),
    isDefault: integer("is_default").notNull().default(0),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("idx_saved_views_access").on(table.tenantId, table.objectType, table.scope, table.status, table.updatedAt),
    index("idx_saved_views_owner").on(table.tenantId, table.ownerId, table.status, table.updatedAt),
  ],
);

export const userPreferences = pgTable(
  "user_preferences",
  {
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    settings: text("settings").notNull().default("{}"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("idx_user_preferences_tenant_user").on(table.tenantId, table.userId)],
);

export const favorites = pgTable(
  "favorites",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("idx_favorites_unique").on(table.tenantId, table.userId, table.resourceType, table.resourceId),
    index("idx_favorites_user").on(table.tenantId, table.userId, table.createdAt),
  ],
);

export const dashboards = pgTable(
  "dashboards",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
    scope: text("scope").notNull().default("personal"),
    name: text("name").notNull(),
    isDefault: integer("is_default").notNull().default(0),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("idx_dashboards_access").on(table.tenantId, table.scope, table.status, table.updatedAt),
    index("idx_dashboards_owner").on(table.tenantId, table.ownerId, table.status, table.updatedAt),
  ],
);

export const dashboardWidgets = pgTable(
  "dashboard_widgets",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    dashboardId: text("dashboard_id").notNull().references(() => dashboards.id, { onDelete: "cascade" }),
    widgetType: text("widget_type").notNull(),
    position: integer("position").notNull().default(0),
    configuration: text("configuration").notNull().default("{}"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("idx_dashboard_widgets_position").on(table.dashboardId, table.position),
    index("idx_dashboard_widgets_dashboard").on(table.tenantId, table.dashboardId, table.position),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    webhookId: text("webhook_id").notNull(),
    direction: text("direction").notNull(),
    event: text("event").notNull(),
    status: text("status").notNull(),
    requestBody: text("request_body").notNull().default("{}"),
    responseCode: integer("response_code"),
    responseBody: text("response_body").notNull().default(""),
    error: text("error").notNull().default(""),
    createdAt: createdAt(),
  },
  (table) => [index("idx_webhook_deliveries_lookup").on(table.tenantId, table.webhookId, table.createdAt)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: serial("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
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
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_audit_events_tenant_team").on(table.tenantId, table.teamId),
    index("idx_audit_events_tenant_actor").on(table.tenantId, table.actorId),
    index("idx_audit_events_tenant_created").on(table.tenantId, table.createdAt),
  ],
);

export const authCredentials = pgTable("auth_credentials", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
});

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    userAgentHash: text("user_agent_hash").notNull().default(""),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("idx_auth_sessions_user").on(table.userId),
    index("idx_auth_sessions_expires").on(table.expiresAt),
  ],
);

export const authLoginAttempts = pgTable("auth_login_attempts", {
  keyHash: text("key_hash").primaryKey(),
  failures: integer("failures").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  blockedUntil: timestamp("blocked_until", { withTimezone: true, mode: "string" }),
  updatedAt: updatedAt(),
});
