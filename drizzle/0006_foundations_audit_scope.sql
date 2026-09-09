ALTER TABLE `audit_events` ADD `team_id` text;
--> statement-breakpoint
CREATE INDEX `idx_audit_events_tenant_team` ON `audit_events` (`tenant_id`,`team_id`);
--> statement-breakpoint
CREATE INDEX `idx_audit_events_tenant_actor` ON `audit_events` (`tenant_id`,`actor_id`);
