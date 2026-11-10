import { randomUUID } from 'node:crypto';
import { DomainError } from '#core';
import {
  connections,
  credentials,
  projectRepositories,
  projects,
  type ConnectionCheck,
  type ConnectionRow,
  type CredentialRow,
  type Database,
} from '#database';
import {
  instanceHost,
  isCodeHostError,
  normalizeInstanceUrl,
  type CodeHostAdapter,
  type CodeHostRegistry,
} from '#integrations';
import {
  CODE_HOST_PROVIDERS,
  ERROR_CODES,
  type CodeHostProvider,
  type Connection,
  type ConnectionProvider,
  type CreateConnectionInput,
  type CredentialCheck,
  type RemoteRepository,
} from '#shared';
import { fingerprint, open, seal, Secret, type Keyring } from '#vault';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import { statusForFailure, toDomainError } from './code-host-errors.js';
import type { ActionContext, Executor } from './context.js';

export interface ConnectionServiceDeps {
  db: Database;
  keyring: Keyring;
  codeHosts: CodeHostRegistry;
  now?: () => Date;
}

/** Binds a ciphertext to its row and provider (AES-GCM associated data; see ADR-003). */
export const credentialContext = (credentialId: string, provider: string) =>
  `${credentialId}:${provider}`;

/**
 * Accounts (connections) on code hosts. Tokens are verified with the provider before anything is
 * stored, sealed with the vault, never returned, and every decryption is audited.
 */
export class ConnectionService {
  private readonly now: () => Date;

  constructor(private readonly deps: ConnectionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async list(provider?: ConnectionProvider): Promise<Connection[]> {
    const rows = await this.deps.db
      .select({ connection: connections, credential: credentials })
      .from(connections)
      .leftJoin(credentials, eq(credentials.id, connections.credentialId))
      // Accounts are code-host connections; agent runtimes are reported by AgentRuntimeService.
      .where(
        provider
          ? eq(connections.provider, provider)
          : inArray(connections.provider, [...CODE_HOST_PROVIDERS]),
      )
      .orderBy(asc(connections.provider), asc(connections.name));
    const usage = await this.projectsUsing(rows.map((row) => row.connection.id));
    return rows.map((row) =>
      toConnection(row.connection, row.credential, usage.get(row.connection.id) ?? []),
    );
  }

  async get(id: string): Promise<Connection> {
    const { connection, credential } = await this.load(this.deps.db, id);
    const usage = await this.projectsUsing([id]);
    return toConnection(connection, credential, usage.get(id) ?? []);
  }

  /** Verifies the token first; only a working token is stored. */
  async create(input: CreateConnectionInput, context: ActionContext): Promise<Connection> {
    const baseUrl = this.normalize(input.provider, input.baseUrl);
    const token = new Secret(input.secret);
    const check = await this.verify(input.provider, baseUrl, token);

    const id = await this.deps.db.transaction(async (tx) => {
      const credentialId = randomUUID();
      const sealed = seal(
        this.deps.keyring,
        token.reveal(),
        credentialContext(credentialId, input.provider),
      );
      await tx.insert(credentials).values({
        id: credentialId,
        provider: input.provider,
        authType: check.tokenKind,
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        fingerprint: fingerprint(token.reveal()),
        metadata: credentialMetadata(check),
      });
      const [row] = await tx
        .insert(connections)
        .values({
          provider: input.provider,
          name: input.name,
          baseUrl,
          account: check.accountName,
          credentialId,
          ...this.statusFromCheck(check),
        })
        .returning({ id: connections.id });
      await recordAudit(tx, context, {
        action: 'connection.created',
        resourceType: 'connection',
        resourceId: row!.id,
        metadata: {
          provider: input.provider,
          host: instanceHost(baseUrl),
          account: check.accountName,
        },
      });
      return row!.id;
    });
    return this.get(id);
  }

  /** Re-checks the stored token against the provider and records the outcome. */
  async test(id: string, context: ActionContext): Promise<Connection> {
    const { connection } = await this.load(this.deps.db, id);
    const provider = asCodeHost(connection.provider);
    try {
      const check = await this.withToken(id, 'connection.test', context, (token) =>
        this.adapter(provider).verifyCredential({ baseUrl: connection.baseUrl }, token),
      );
      await this.deps.db
        .update(connections)
        .set({ ...this.statusFromCheck(check), account: check.accountName, updatedAt: sql`now()` })
        .where(eq(connections.id, id));
      await this.deps.db
        .update(credentials)
        .set({ metadata: credentialMetadata(check) })
        .where(eq(credentials.id, connection.credentialId!));
    } catch (error) {
      // For a health check, a provider or vault failure is a result to record, not an exception.
      if (isCodeHostError(error)) {
        await this.recordFailure(id, error);
      } else if (error instanceof DomainError && error.code === ERROR_CODES.credentialUnreadable) {
        await this.deps.db
          .update(connections)
          .set({
            status: 'degraded',
            lastCheck: { ok: false, message: error.message },
            lastCheckedAt: sql`now()`,
          })
          .where(eq(connections.id, id));
      } else if (!(error instanceof DomainError && error.code === ERROR_CODES.connectionUnusable)) {
        throw error;
      }
    }
    await recordAudit(this.deps.db, context, {
      action: 'connection.tested',
      resourceType: 'connection',
      resourceId: id,
    });
    return this.get(id);
  }

  /** Replaces the token (verified first). Linked repositories are re-verified by the caller. */
  async rotate(id: string, secret: string, context: ActionContext): Promise<Connection> {
    const { connection, credential } = await this.load(this.deps.db, id);
    const provider = asCodeHost(connection.provider);
    const token = new Secret(secret);
    const check = await this.verify(provider, connection.baseUrl, token);

    await this.deps.db.transaction(async (tx) => {
      const credentialId = credential?.id ?? randomUUID();
      const sealed = seal(
        this.deps.keyring,
        token.reveal(),
        credentialContext(credentialId, provider),
      );
      const values = {
        authType: check.tokenKind,
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        fingerprint: fingerprint(token.reveal()),
        metadata: credentialMetadata(check),
      };
      if (credential) {
        await tx
          .update(credentials)
          .set({ ...values, rotatedAt: sql`now()` })
          .where(eq(credentials.id, credentialId));
      } else {
        await tx.insert(credentials).values({ id: credentialId, provider, ...values });
      }
      await tx
        .update(connections)
        .set({
          credentialId,
          account: check.accountName,
          ...this.statusFromCheck(check),
          updatedAt: sql`now()`,
        })
        .where(eq(connections.id, id));
      await recordAudit(tx, context, {
        action: 'connection.rotated',
        resourceType: 'connection',
        resourceId: id,
        metadata: {
          account: check.accountName,
          accountChanged: connection.account !== null && connection.account !== check.accountName,
        },
      });
    });
    return this.get(id);
  }

  /** Destroys the stored token. Linked repositories lose verified access until a new token is set. */
  async disconnect(id: string, context: ActionContext): Promise<Connection> {
    await this.deps.db.transaction(async (tx) => {
      const { connection } = await this.load(tx, id);
      if (connection.credentialId) {
        await tx
          .update(credentials)
          .set({ ciphertext: null })
          .where(eq(credentials.id, connection.credentialId));
      }
      await tx
        .update(connections)
        .set({
          status: 'disconnected',
          lastCheck: { ok: false, message: 'Disconnected: the token was deleted from Workbox.' },
          lastCheckedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(connections.id, id));
      await tx
        .update(projectRepositories)
        .set({
          accessStatus: 'unverified',
          lastError: 'Account disconnected',
          updatedAt: sql`now()`,
        })
        .where(eq(projectRepositories.connectionId, id));
      await recordAudit(tx, context, {
        action: 'connection.disconnected',
        resourceType: 'connection',
        resourceId: id,
      });
    });
    return this.get(id);
  }

  async listRepositories(
    id: string,
    options: { search?: string | undefined; limit?: number | undefined },
    context: ActionContext,
  ): Promise<RemoteRepository[]> {
    const { connection } = await this.load(this.deps.db, id);
    const provider = asCodeHost(connection.provider);
    try {
      return await this.withToken(id, 'repositories.list', context, (token) =>
        this.adapter(provider).listRepositories({ baseUrl: connection.baseUrl }, token, options),
      );
    } catch (error) {
      await this.recordFailure(id, error);
      throw toDomainError(error);
    }
  }

  /**
   * Decrypts the account's token for one operation, auditing the access. The Secret never escapes
   * the callback. Used by RepositoryService too.
   */
  async withToken<T>(
    connectionId: string,
    purpose: string,
    context: ActionContext,
    fn: (token: Secret, connection: ConnectionRow) => Promise<T>,
  ): Promise<T> {
    const { connection, credential } = await this.load(this.deps.db, connectionId);
    if (connection.status === 'disconnected' || !credential?.ciphertext) {
      throw new DomainError(
        ERROR_CODES.connectionUnusable,
        `account "${connection.name}" has no token; replace the token to use it again`,
      );
    }
    let token: Secret;
    try {
      token = open(
        this.deps.keyring,
        { ciphertext: credential.ciphertext, keyVersion: credential.keyVersion },
        credentialContext(credential.id, credential.provider),
      );
    } catch (error) {
      throw toDomainError(error);
    }
    await recordAudit(this.deps.db, context, {
      action: 'credential.accessed',
      resourceType: 'credential',
      resourceId: credential.id,
      metadata: { purpose, connectionId },
    });
    return fn(token, connection);
  }

  /** Records a provider failure on the connection (expired on 401, degraded otherwise). */
  async recordFailure(connectionId: string, error: unknown): Promise<void> {
    if (!isCodeHostError(error)) return;
    await this.deps.db
      .update(connections)
      .set({
        status: statusForFailure(error),
        lastCheck: { ok: false, message: error.message, details: { kind: error.kind } },
        lastCheckedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(connections.id, connectionId));
  }

  private async verify(
    provider: CodeHostProvider,
    baseUrl: string,
    token: Secret,
  ): Promise<CredentialCheck> {
    try {
      return await this.adapter(provider).verifyCredential({ baseUrl }, token);
    } catch (error) {
      throw toDomainError(error);
    }
  }

  private statusFromCheck(check: CredentialCheck) {
    const expired = check.expiresAt !== null && new Date(check.expiresAt) <= this.now();
    const lastCheck: ConnectionCheck = expired
      ? { ok: false, message: 'The token has expired.', details: { expiresAt: check.expiresAt } }
      : {
          ok: true,
          message: `Connected as ${check.accountName}.`,
          details: { warnings: check.warnings, expiresAt: check.expiresAt },
        };
    return {
      status: expired ? ('expired' as const) : ('connected' as const),
      lastCheck,
      lastCheckedAt: this.now(),
    };
  }

  private normalize(provider: CodeHostProvider, baseUrl: string | undefined): string {
    try {
      return normalizeInstanceUrl(provider, baseUrl);
    } catch (error) {
      throw toDomainError(error);
    }
  }

  private adapter(provider: CodeHostProvider): CodeHostAdapter {
    return this.deps.codeHosts[provider];
  }

  private async load(executor: Executor, id: string) {
    const [row] = await executor
      .select({ connection: connections, credential: credentials })
      .from(connections)
      .leftJoin(credentials, eq(credentials.id, connections.credentialId))
      .where(eq(connections.id, id))
      .limit(1);
    if (!row) throw new DomainError(ERROR_CODES.notFound, `account "${id}" not found`);
    return row;
  }

  private async projectsUsing(connectionIds: string[]) {
    const result = new Map<string, Array<{ id: string; slug: string; name: string }>>();
    if (connectionIds.length === 0) return result;
    const rows = await this.deps.db
      .select({
        connectionId: projectRepositories.connectionId,
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
      })
      .from(projectRepositories)
      .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
      .where(inArray(projectRepositories.connectionId, connectionIds))
      .orderBy(asc(projects.name));
    for (const row of rows) {
      result.set(row.connectionId, [
        ...(result.get(row.connectionId) ?? []),
        { id: row.id, slug: row.slug, name: row.name },
      ]);
    }
    return result;
  }
}

export function asCodeHost(provider: ConnectionProvider): CodeHostProvider {
  if (!(CODE_HOST_PROVIDERS as readonly string[]).includes(provider)) {
    throw new DomainError(ERROR_CODES.connectionUnusable, `${provider} is not a code host`);
  }
  return provider as CodeHostProvider;
}

function credentialMetadata(check: CredentialCheck): Record<string, unknown> {
  return {
    accountId: check.accountId,
    scopes: check.scopes,
    expiresAt: check.expiresAt,
    tokenKind: check.tokenKind,
    warnings: check.warnings,
  };
}

function toConnection(
  row: ConnectionRow,
  credential: CredentialRow | null,
  usedBy: Array<{ id: string; slug: string; name: string }>,
): Connection {
  const metadata = (credential?.metadata ?? {}) as {
    scopes?: string[];
    expiresAt?: string | null;
    accountId?: string | null;
  };
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    baseUrl: row.baseUrl,
    account: row.account,
    accountId: metadata.accountId ?? null,
    authType: credential?.authType ?? null,
    fingerprint: credential?.fingerprint ?? null,
    hasSecret: Boolean(credential?.ciphertext),
    tokenExpiresAt: metadata.expiresAt ?? null,
    scopes: metadata.scopes ?? [],
    status: row.status,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastCheck: row.lastCheck ?? null,
    projects: usedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
