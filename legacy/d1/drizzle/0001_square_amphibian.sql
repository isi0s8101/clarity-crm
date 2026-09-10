CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`role` text NOT NULL,
	`object` text NOT NULL,
	`action` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`team_id` text,
	`role` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `audit_events` ADD `tenant_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `resource_type` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `resource_id` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `result` text DEFAULT 'success' NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `before` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `after` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `tenant_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `opportunities` ADD `team_id` text DEFAULT 'default-sales' NOT NULL;
