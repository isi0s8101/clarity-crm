CREATE UNIQUE INDEX `idx_memberships_tenant_user` ON `memberships` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_memberships_tenant_role` ON `memberships` (`tenant_id`,`role`);--> statement-breakpoint
CREATE INDEX `idx_opportunities_tenant_updated` ON `opportunities` (`tenant_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_opportunities_tenant_team` ON `opportunities` (`tenant_id`,`team_id`);--> statement-breakpoint
CREATE INDEX `idx_opportunities_tenant_owner` ON `opportunities` (`tenant_id`,`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_role_permissions_lookup` ON `role_permissions` (`tenant_id`,`role`,`object`,`action`);