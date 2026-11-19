-- rollback-safe: 只新增表，旧代码不读写它
SET lock_timeout = '5s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "analytics_delivery" (
	"event_key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_attribution" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"medium" text,
	"campaign" text,
	"term" text,
	"content" text,
	"referrer_host" text,
	"landing_path" text NOT NULL,
	"device" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_attribution" ADD CONSTRAINT "user_attribution_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;