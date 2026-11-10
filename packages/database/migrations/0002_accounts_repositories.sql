CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"account" text,
	"credential_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'unconfigured' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_check" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_credential_unique" UNIQUE("credential_id"),
	CONSTRAINT "connections_provider_valid" CHECK ("connections"."provider" IN ('github', 'gitlab', 'claude_code')),
	CONSTRAINT "connections_status_valid" CHECK ("connections"."status" IN ('unconfigured', 'connected', 'degraded', 'expired', 'disconnected')),
	CONSTRAINT "connections_name_length" CHECK (char_length("connections"."name") BETWEEN 1 AND 100),
	CONSTRAINT "connections_base_url_scheme" CHECK ("connections"."base_url" ~ '^https?://')
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"auth_type" text NOT NULL,
	"ciphertext" "bytea",
	"key_version" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "credentials_provider_valid" CHECK ("credentials"."provider" IN ('github', 'gitlab', 'claude_code')),
	CONSTRAINT "credentials_auth_type_valid" CHECK ("credentials"."auth_type" IN ('personal_access_token', 'project_access_token', 'group_access_token', 'api_key', 'local_cli')),
	CONSTRAINT "credentials_key_version_positive" CHECK ("credentials"."key_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "project_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"purpose" text DEFAULT 'primary' NOT NULL,
	"provider" text NOT NULL,
	"host" text NOT NULL,
	"external_id" text NOT NULL,
	"full_path" text NOT NULL,
	"web_url" text NOT NULL,
	"clone_url_https" text NOT NULL,
	"clone_url_ssh" text,
	"default_branch" text NOT NULL,
	"visibility" text NOT NULL,
	"access" jsonb NOT NULL,
	"access_status" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_repositories_project_purpose_unique" UNIQUE("project_id","purpose"),
	CONSTRAINT "project_repositories_repository_unique" UNIQUE("provider","host","external_id"),
	CONSTRAINT "project_repositories_purpose_valid" CHECK ("project_repositories"."purpose" IN ('primary')),
	CONSTRAINT "project_repositories_access_status_valid" CHECK ("project_repositories"."access_status" IN ('verified', 'denied', 'expired', 'unverified'))
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_provider_idx" ON "connections" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "project_repositories_connection_idx" ON "project_repositories" USING btree ("connection_id");