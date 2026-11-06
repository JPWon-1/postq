CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cookies` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text DEFAULT 'default' NOT NULL,
	`environment_id` text,
	`domain` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`path` text DEFAULT '/' NOT NULL,
	`expires` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cookies_scope_idx` ON `cookies` (`workspace_id`,`environment_id`);--> statement-breakpoint
CREATE TABLE `environments` (
	`execution_policy` text DEFAULT 'open' NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text DEFAULT 'default' NOT NULL,
	`name` text NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `executions` (
	`execution_source` text DEFAULT 'ui' NOT NULL,
	`denial_reason` text,
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`executed_by` text NOT NULL,
	`executed_at` integer NOT NULL,
	`environment_id` text,
	`resolved` text NOT NULL,
	`response_status` integer,
	`response_headers` text,
	`response_body` text,
	`duration_ms` integer,
	`error` text,
	`check_passed` integer,
	`assertion_results` text DEFAULT '[]' NOT NULL,
	`missing_variables` text DEFAULT '[]' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `executions_request_id_idx` ON `executions` (`request_id`);--> statement-breakpoint
CREATE INDEX `executions_executed_at_idx` ON `executions` (`executed_at`);--> statement-breakpoint
CREATE TABLE `flow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`workspace_id` text DEFAULT 'default' NOT NULL,
	`environment_id` text,
	`executed_by` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`stopped_at` integer,
	`steps` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `flow_runs_flow_idx` ON `flow_runs` (`flow_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `flows` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text DEFAULT 'default' NOT NULL,
	`name` text NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`shared_vars` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text DEFAULT 'default' NOT NULL,
	`name` text NOT NULL,
	`spec_source_type` text DEFAULT 'none' NOT NULL,
	`spec_source_url` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`shared_headers` text DEFAULT '[]' NOT NULL,
	`shared_auth` text DEFAULT '{"type":"none"}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `folders_ws_order_idx` ON `folders` (`workspace_id`,`sort_order`,`id`);--> statement-breakpoint
CREATE TABLE `request_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` integer NOT NULL,
	`author` text
);
--> statement-breakpoint
CREATE INDEX `request_versions_request_time_idx` ON `request_versions` (`request_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `requests` (
	`ai_execution_allowed` integer DEFAULT false NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`folder_id` text NOT NULL,
	`name` text NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`params` text DEFAULT '[]' NOT NULL,
	`headers` text DEFAULT '[]' NOT NULL,
	`body_type` text DEFAULT 'none' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`spec_state` text,
	`spec_operation_key` text,
	`spec_fingerprint` text,
	`spec_contract` text,
	`owner` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	`assertions` text DEFAULT '[]' NOT NULL,
	`pre_steps` text DEFAULT '[]' NOT NULL,
	`post_steps` text DEFAULT '[]' NOT NULL,
	`auth` text DEFAULT '{"type":"none"}' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`vars` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `requests_folder_order_idx` ON `requests` (`folder_id`,`sort_order`,`id`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text DEFAULT 'default' NOT NULL,
	`flow_id` text NOT NULL,
	`environment_id` text,
	`interval_minutes` integer DEFAULT 60 NOT NULL,
	`slack_webhook_url` text,
	`notify_on` text DEFAULT 'failure' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`last_status` text
);
--> statement-breakpoint
CREATE TABLE `spec_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text DEFAULT 'default' NOT NULL,
	`folder_id` text NOT NULL,
	`request_id` text,
	`operation_key` text NOT NULL,
	`change_type` text NOT NULL,
	`request_name` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `spec_changes_workspace_id_idx` ON `spec_changes` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `variables` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`secret` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `workspaces` (`id`, `name`) VALUES ('default', '기본');
