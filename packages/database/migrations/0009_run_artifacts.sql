CREATE TABLE "run_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "run_artifacts_run_name_unique" UNIQUE("run_id","name"),
	CONSTRAINT "run_artifacts_kind_valid" CHECK ("run_artifacts"."kind" IN ('transcript', 'check_output', 'patch')),
	CONSTRAINT "run_artifacts_path_relative" CHECK ("run_artifacts"."path" NOT LIKE '/%' AND "run_artifacts"."path" NOT LIKE '%..%')
);
--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_artifacts_expires_idx" ON "run_artifacts" USING btree ("expires_at");