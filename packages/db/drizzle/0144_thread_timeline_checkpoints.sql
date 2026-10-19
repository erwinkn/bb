CREATE TABLE IF NOT EXISTS `thread_timeline_checkpoints` (
	`thread_id` text NOT NULL,
	`kind` text NOT NULL,
	`part` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`thread_id`, `kind`, `part`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DELETE FROM `thread_conversation_outlines`;
