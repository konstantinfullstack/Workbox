import {
  CONNECTION_PROVIDERS,
  CONNECTION_STATUSES,
  CREDENTIAL_AUTH_TYPES,
  REPOSITORY_ACCESS_STATUSES,
  REPOSITORY_PURPOSES,
  type CodeHostProvider,
  type ConnectionProvider,
  type ConnectionStatus,
  type CredentialAuthType,
  type RepositoryAccessStatus,
  type RepositoryPurpose,
} from '#shared';
import { customType, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { inList } from './enums.js';
import { projects } from './projects.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Encrypted secrets (AES-256-GCM, see docs/adr/003). `ciphertext` is NULL after disconnect.
 * `metadata` must never hold secret material.
 */
export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').$type<ConnectionProvider>().notNull(),
    authType: text('auth_type').$type<CredentialAuthType>().notNull(),
    ciphertext: bytea('ciphertext'),
    keyVersion: integer('key_version').notNull(),
    /** Display-only hint, e.g. `github_pat_…a1B2`. */
    fingerprint: text('fingerprint').notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (table) => [
    check('credentials_provider_valid', inList(sql`${table.provider}`, CONNECTION_PROVIDERS)),
    check('credentials_auth_type_valid', inList(sql`${table.authType}`, CREDENTIAL_AUTH_TYPES)),
    check('credentials_key_version_positive', sql`${table.keyVersion} > 0`),
  ],
);

export type CredentialRow = typeof credentials.$inferSelect;

export interface ConnectionCheck {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/** An account: one identity on one provider + host. Reusable across projects. */
export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').$type<ConnectionProvider>().notNull(),
    name: text('name').notNull(),
    /** Instance URL, e.g. https://github.com, https://gitlab.company.com. */
    baseUrl: text('base_url').notNull(),
    /** Account login/name discovered during verification. */
    account: text('account'),
    credentialId: uuid('credential_id').references(() => credentials.id, { onDelete: 'restrict' }),
    config: jsonb('config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text('status').$type<ConnectionStatus>().notNull().default('unconfigured'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastCheck: jsonb('last_check').$type<ConnectionCheck>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('connections_provider_valid', inList(sql`${table.provider}`, CONNECTION_PROVIDERS)),
    check('connections_status_valid', inList(sql`${table.status}`, CONNECTION_STATUSES)),
    check('connections_name_length', sql`char_length(${table.name}) BETWEEN 1 AND 100`),
    check('connections_base_url_scheme', sql`${table.baseUrl} ~ '^https?://'`),
    unique('connections_credential_unique').on(table.credentialId),
    index('connections_provider_idx').on(table.provider),
  ],
);

export type ConnectionRow = typeof connections.$inferSelect;

export interface RepositoryAccess {
  pull: boolean;
  push: boolean;
  /** Creating PRs/MRs cannot be verified without creating one; confirmed in M5. */
  reviewRequests: 'unverified' | 'verified' | 'denied';
}

/**
 * A project's repository, stored by the provider's stable id (survives renames and transfers).
 * One per project per purpose (D1); one project per repository (D2).
 */
export const projectRepositories = pgTable(
  'project_repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'restrict' }),
    purpose: text('purpose').$type<RepositoryPurpose>().notNull().default('primary'),
    provider: text('provider').$type<CodeHostProvider>().notNull(),
    /** Instance host, e.g. github.com, gitlab.company.com. */
    host: text('host').notNull(),
    externalId: text('external_id').notNull(),
    fullPath: text('full_path').notNull(),
    webUrl: text('web_url').notNull(),
    cloneUrlHttps: text('clone_url_https').notNull(),
    cloneUrlSsh: text('clone_url_ssh'),
    defaultBranch: text('default_branch').notNull(),
    visibility: text('visibility').notNull(),
    access: jsonb('access').$type<RepositoryAccess>().notNull(),
    accessStatus: text('access_status').$type<RepositoryAccessStatus>().notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** Last access problem, safe to display (e.g. "token expired", "lost access"). */
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('project_repositories_project_purpose_unique').on(table.projectId, table.purpose),
    unique('project_repositories_repository_unique').on(
      table.provider,
      table.host,
      table.externalId,
    ),
    check('project_repositories_purpose_valid', inList(sql`${table.purpose}`, REPOSITORY_PURPOSES)),
    check(
      'project_repositories_access_status_valid',
      inList(sql`${table.accessStatus}`, REPOSITORY_ACCESS_STATUSES),
    ),
    index('project_repositories_connection_idx').on(table.connectionId),
  ],
);

export type ProjectRepositoryRow = typeof projectRepositories.$inferSelect;
