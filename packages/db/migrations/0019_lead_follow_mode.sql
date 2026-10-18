ALTER TABLE "lead" ADD COLUMN "follow_mode" text DEFAULT 'same-source' NOT NULL;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "improvement" jsonb;