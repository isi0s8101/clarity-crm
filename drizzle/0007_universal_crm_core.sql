CREATE INDEX `idx_crm_records_tenant_team_type` ON `crm_records` (`tenant_id`,`team_id`,`type`);
--> statement-breakpoint
CREATE INDEX `idx_crm_records_tenant_status` ON `crm_records` (`tenant_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_crm_records_tenant_id` ON `crm_records` (`tenant_id`,`id`);
--> statement-breakpoint
CREATE TABLE `crm_relations` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `from_record_id` text NOT NULL,
  `to_record_id` text NOT NULL,
  `relation_type` text NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`from_record_id`) REFERENCES `crm_records`(`id`) ON UPDATE no action ON DELETE restrict,
  FOREIGN KEY (`to_record_id`) REFERENCES `crm_records`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_crm_relations_unique` ON `crm_relations` (`tenant_id`,`from_record_id`,`to_record_id`,`relation_type`);
--> statement-breakpoint
CREATE INDEX `idx_crm_relations_from` ON `crm_relations` (`tenant_id`,`from_record_id`);
--> statement-breakpoint
CREATE INDEX `idx_crm_relations_to` ON `crm_relations` (`tenant_id`,`to_record_id`);
--> statement-breakpoint
CREATE TRIGGER `trg_crm_relations_tenant_insert`
BEFORE INSERT ON `crm_relations`
BEGIN
  SELECT CASE
    WHEN (SELECT `tenant_id` FROM `crm_records` WHERE `id` = NEW.`from_record_id`) IS NULL
      OR (SELECT `tenant_id` FROM `crm_records` WHERE `id` = NEW.`to_record_id`) IS NULL
      OR (SELECT `tenant_id` FROM `crm_records` WHERE `id` = NEW.`from_record_id`) <> NEW.`tenant_id`
      OR (SELECT `tenant_id` FROM `crm_records` WHERE `id` = NEW.`to_record_id`) <> NEW.`tenant_id`
    THEN RAISE(ABORT, 'crm_relation_cross_tenant')
  END;
END;
--> statement-breakpoint
CREATE TRIGGER `trg_crm_relations_tenant_update`
BEFORE UPDATE ON `crm_relations`
BEGIN
  SELECT CASE
    WHEN (SELECT `tenant_id` FROM `crm_records` WHERE `id` = NEW.`from_record_id`) IS NULL
      OR (SELECT `tenant_id` FROM `crm_records` WHERE `id` = NEW.`to_record_id`) IS NULL
      OR (SELECT `tenant_id` FROM `crm_records` WHERE `id` = NEW.`from_record_id`) <> NEW.`tenant_id`
      OR (SELECT `tenant_id` FROM `crm_records` WHERE `id` = NEW.`to_record_id`) <> NEW.`tenant_id`
    THEN RAISE(ABORT, 'crm_relation_cross_tenant')
  END;
END;
--> statement-breakpoint
CREATE TABLE `crm_timeline_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `tenant_id` text NOT NULL,
  `team_id` text NOT NULL,
  `owner_id` text NOT NULL,
  `record_id` text NOT NULL,
  `event_type` text NOT NULL,
  `summary` text NOT NULL,
  `data` text DEFAULT '{}' NOT NULL,
  `actor_id` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`record_id`) REFERENCES `crm_records`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_crm_timeline_record` ON `crm_timeline_events` (`tenant_id`,`record_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_crm_timeline_team` ON `crm_timeline_events` (`tenant_id`,`team_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `trg_crm_timeline_tenant_insert`
BEFORE INSERT ON `crm_timeline_events`
BEGIN
  SELECT CASE
    WHEN (SELECT `tenant_id` FROM `crm_records` WHERE `id` = NEW.`record_id`) IS NULL
      OR (SELECT `tenant_id` FROM `crm_records` WHERE `id` = NEW.`record_id`) <> NEW.`tenant_id`
    THEN RAISE(ABORT, 'crm_timeline_cross_tenant')
  END;
END;
--> statement-breakpoint
CREATE TABLE `crm_configuration_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `configuration_id` text NOT NULL,
  `version` integer NOT NULL,
  `name` text NOT NULL,
  `active` integer NOT NULL,
  `definition` text DEFAULT '{}' NOT NULL,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`configuration_id`) REFERENCES `crm_configurations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_crm_config_versions_unique` ON `crm_configuration_versions` (`tenant_id`,`configuration_id`,`version`);
--> statement-breakpoint
CREATE INDEX `idx_crm_config_versions_lookup` ON `crm_configuration_versions` (`tenant_id`,`configuration_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `webhook_id` text NOT NULL,
  `direction` text NOT NULL,
  `event` text NOT NULL,
  `status` text NOT NULL,
  `request_body` text DEFAULT '{}' NOT NULL,
  `response_code` integer,
  `response_body` text DEFAULT '' NOT NULL,
  `error` text DEFAULT '' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_lookup` ON `webhook_deliveries` (`tenant_id`,`webhook_id`,`created_at`);
