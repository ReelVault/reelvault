CREATE TABLE `plugin_ui_overrides` (
	`plugin_id` text NOT NULL,
	`contribution_key` text NOT NULL,
	CONSTRAINT `plugin_ui_overrides_pk` PRIMARY KEY(`plugin_id`, `contribution_key`)
);
