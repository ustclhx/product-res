CREATE TABLE "marketplace_category" (
	"id" uuid PRIMARY KEY NOT NULL,
	"marketplace" text NOT NULL,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"leaf" boolean DEFAULT false NOT NULL,
	"path" text NOT NULL,
	"tree_version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_category_uq" ON "marketplace_category" USING btree ("marketplace","category_id");--> statement-breakpoint
CREATE INDEX "marketplace_category_name_idx" ON "marketplace_category" USING btree ("marketplace","name");