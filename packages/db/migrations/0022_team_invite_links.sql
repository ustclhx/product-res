CREATE TABLE "workspace_invite_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"role" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invite_link_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "workspace_invite_link_role_check" CHECK ("workspace_invite_link"."role" in ('member', 'admin')),
	CONSTRAINT "workspace_invite_link_max_uses_check" CHECK ("workspace_invite_link"."max_uses" is null or "workspace_invite_link"."max_uses" > 0),
	CONSTRAINT "workspace_invite_link_used_count_check" CHECK ("workspace_invite_link"."used_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "workspace_invite_link" ADD CONSTRAINT "workspace_invite_link_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invite_link" ADD CONSTRAINT "workspace_invite_link_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invite_link" ADD CONSTRAINT "workspace_invite_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_invite_link_workspace_id_id_idx" ON "workspace_invite_link" USING btree ("workspace_id","id" DESC NULLS LAST);--> statement-breakpoint
-- add-team-invite-links D1：内测无支付渠道，free 套餐 1 席时团队空间无法加人；只改从未调整过的默认值
UPDATE "plan" SET "features" = jsonb_set("features", '{maxSeats}', '10'::jsonb), "updated_at" = now() WHERE "key" = 'free' AND "features"->>'maxSeats' = '1';