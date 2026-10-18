CREATE TABLE "metrics_daily" (
	"day" date PRIMARY KEY NOT NULL,
	"registrations" integer NOT NULL,
	"total_users" integer NOT NULL,
	"total_workspaces" integer NOT NULL,
	"paid_workspaces" integer NOT NULL,
	"mrr_by_currency" jsonb NOT NULL,
	"credits_consumed" integer NOT NULL,
	"overage_absorbed" integer NOT NULL,
	"overage_by_model" jsonb NOT NULL,
	"text_completed" integer NOT NULL,
	"text_failed" integer NOT NULL,
	"text_aborted" integer NOT NULL,
	"media_succeeded" integer,
	"media_failed" integer,
	"data_through" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
