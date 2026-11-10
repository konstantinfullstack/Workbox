CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_repository_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"path" text,
	"head_sha" text,
	"size_kb" integer,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"worker_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_project_repository_unique" UNIQUE("project_repository_id"),
	CONSTRAINT "workspaces_status_valid" CHECK ("workspaces"."status" IN ('queued', 'syncing', 'ready', 'failed')),
	CONSTRAINT "workspaces_head_sha_format" CHECK ("workspaces"."head_sha" IS NULL OR "workspaces"."head_sha" ~ '^[0-9a-f]{40,64}$')
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_project_repository_id_project_repositories_id_fk" FOREIGN KEY ("project_repository_id") REFERENCES "public"."project_repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspaces_status_idx" ON "workspaces" USING btree ("status");