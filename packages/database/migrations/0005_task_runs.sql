CREATE TABLE "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_seq_unique" UNIQUE("run_id","seq"),
	CONSTRAINT "run_events_type_valid" CHECK ("run_events"."type" IN ('stage', 'started', 'progress', 'tool_call', 'log', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"agent" text NOT NULL,
	"note" text,
	"branch" text,
	"base_sha" text,
	"worktree_path" text,
	"worker_id" text,
	"summary" text,
	"qa_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"changed_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"diff" text,
	"diff_truncated" integer DEFAULT 0 NOT NULL,
	"exit_reason" text,
	"cost_usd" double precision,
	"duration_ms" integer,
	"cancel_requested_at" timestamp with time zone,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_runs_task_attempt_unique" UNIQUE("task_id","attempt"),
	CONSTRAINT "task_runs_state_valid" CHECK ("task_runs"."state" IN ('queued', 'preparing', 'running', 'verifying', 'completed', 'failed', 'cancelled', 'timed_out')),
	CONSTRAINT "task_runs_agent_valid" CHECK ("task_runs"."agent" IN ('claude_code'))
);
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_runs_one_active_per_project" ON "task_runs" USING btree ("project_id") WHERE "task_runs"."state" IN ('queued', 'preparing', 'running', 'verifying');--> statement-breakpoint
CREATE INDEX "task_runs_task_idx" ON "task_runs" USING btree ("task_id","attempt");