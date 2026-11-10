CREATE TABLE "git_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"branch" text NOT NULL,
	"pushed_sha" text,
	"pushed_at" timestamp with time zone,
	"review_number" integer,
	"review_url" text,
	"review_state" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_references_task_unique" UNIQUE("task_id"),
	CONSTRAINT "git_references_provider_valid" CHECK ("git_references"."provider" IN ('github', 'gitlab')),
	CONSTRAINT "git_references_review_state_valid" CHECK ("git_references"."review_state" IS NULL OR "git_references"."review_state" IN ('draft', 'open', 'merged', 'closed')),
	CONSTRAINT "git_references_branch_namespace" CHECK ("git_references"."branch" LIKE 'workbox/%')
);
--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "verification" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_runs" ADD COLUMN "check_results" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "git_references" ADD CONSTRAINT "git_references_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_references" ADD CONSTRAINT "git_references_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_verification_valid" CHECK ("task_runs"."verification" IN ('pending', 'running', 'passed', 'failed', 'skipped'));