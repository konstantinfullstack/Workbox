CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"repo_url" text,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_task_number" integer DEFAULT 1 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug"),
	CONSTRAINT "projects_slug_format" CHECK ("projects"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "projects_name_length" CHECK (char_length("projects"."name") BETWEEN 1 AND 100),
	CONSTRAINT "projects_status_valid" CHECK ("projects"."status" IN ('active', 'archived')),
	CONSTRAINT "projects_next_task_number_positive" CHECK ("projects"."next_task_number" > 0),
	CONSTRAINT "projects_repo_url_no_credentials" CHECK ("projects"."repo_url" IS NULL OR "projects"."repo_url" !~ '^https?://[^/]*@')
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_pk" PRIMARY KEY("task_id","depends_on_task_id"),
	CONSTRAINT "task_dependencies_not_self" CHECK ("task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id")
);
--> statement-breakpoint
CREATE TABLE "task_state_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_state_transitions_from_valid" CHECK ("task_state_transitions"."from_state" IS NULL OR "task_state_transitions"."from_state" IN ('backlog', 'planning', 'in_progress', 'verification', 'ready_for_qa', 'done', 'blocked', 'changes_requested', 'cancelled')),
	CONSTRAINT "task_state_transitions_to_valid" CHECK ("task_state_transitions"."to_state" IN ('backlog', 'planning', 'in_progress', 'verification', 'ready_for_qa', 'done', 'blocked', 'changes_requested', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"state" text DEFAULT 'backlog' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_project_number_unique" UNIQUE("project_id","number"),
	CONSTRAINT "tasks_title_length" CHECK (char_length("tasks"."title") BETWEEN 1 AND 200),
	CONSTRAINT "tasks_state_valid" CHECK ("tasks"."state" IN ('backlog', 'planning', 'in_progress', 'verification', 'ready_for_qa', 'done', 'blocked', 'changes_requested', 'cancelled')),
	CONSTRAINT "tasks_priority_valid" CHECK ("tasks"."priority" IN ('low', 'medium', 'high', 'urgent')),
	CONSTRAINT "tasks_version_positive" CHECK ("tasks"."version" > 0),
	CONSTRAINT "tasks_number_positive" CHECK ("tasks"."number" > 0),
	CONSTRAINT "tasks_acceptance_criteria_array" CHECK (jsonb_typeof("tasks"."acceptance_criteria") = 'array')
);
--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_state_transitions" ADD CONSTRAINT "task_state_transitions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "task_dependencies_depends_on_idx" ON "task_dependencies" USING btree ("depends_on_task_id");--> statement-breakpoint
CREATE INDEX "task_state_transitions_task_created_idx" ON "task_state_transitions" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_project_state_idx" ON "tasks" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "tasks_project_priority_created_idx" ON "tasks" USING btree ("project_id","priority","created_at");