import { mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DomainError } from '#core';
import { runArtifacts, taskRuns, type Database, type RunArtifactRow } from '#database';
import { ERROR_CODES, type RunArtifact, type RunArtifactKind } from '#shared';
import { and, asc, eq, lt, sql } from 'drizzle-orm';

const DAY_MS = 24 * 60 * 60_000;

/** Safe file-name part: check names are user-defined. */
export function artifactSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'step'
  );
}

/**
 * A run's saved files (M5): agent transcript, complete check output and the branch patch. Files
 * live in `<root>/<runId>/`; rows in `run_artifacts` index them. Everything expires after the
 * retention period (default 7 days) and is then deleted from disk and database.
 *
 * The worker writes; the API lists and serves. Both run on the same machine (personal tool).
 */
export class ArtifactStore {
  constructor(
    private readonly db: Database,
    readonly root: string,
    private readonly retentionDays: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!isAbsolute(root)) throw new Error('the artifacts root must be an absolute path');
  }

  /** Absolute path for a run's file (parent folders created, owner-only). */
  async prepare(runId: string, name: string): Promise<string> {
    const path = this.resolve(join(runId, name));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return path;
  }

  /** Records (or refreshes the size of) a file written at `prepare(runId, name)`. Missing → null. */
  async record(runId: string, kind: RunArtifactKind, name: string): Promise<RunArtifact | null> {
    const path = join(runId, name);
    const size = await stat(this.resolve(path)).then(
      (s) => s.size,
      () => null,
    );
    if (size === null) return null;
    const expiresAt = new Date(this.now().getTime() + this.retentionDays * DAY_MS);
    const [row] = await this.db
      .insert(runArtifacts)
      .values({ runId, kind, name, path, sizeBytes: size, expiresAt })
      .onConflictDoUpdate({
        target: [runArtifacts.runId, runArtifacts.name],
        set: { sizeBytes: size, expiresAt },
      })
      .returning();
    return toRunArtifact(row!);
  }

  async list(runId: string): Promise<RunArtifact[]> {
    const [run] = await this.db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(eq(taskRuns.id, runId))
      .limit(1);
    if (!run) throw new DomainError(ERROR_CODES.notFound, `run "${runId}" not found`);
    const rows = await this.db
      .select()
      .from(runArtifacts)
      .where(eq(runArtifacts.runId, runId))
      .orderBy(asc(runArtifacts.kind), asc(runArtifacts.name));
    return rows.map(toRunArtifact);
  }

  /** A file to download. NOT_FOUND when unknown, expired or already deleted from disk. */
  async open(runId: string, artifactId: string): Promise<{ artifact: RunArtifact; path: string }> {
    const [row] = await this.db
      .select()
      .from(runArtifacts)
      .where(and(eq(runArtifacts.id, artifactId), eq(runArtifacts.runId, runId)))
      .limit(1);
    if (!row || row.expiresAt <= this.now()) {
      throw new DomainError(ERROR_CODES.notFound, 'this file does not exist or has expired');
    }
    const path = this.resolve(row.path);
    const exists = await stat(path).then(
      (s) => s.isFile(),
      () => false,
    );
    if (!exists) throw new DomainError(ERROR_CODES.notFound, 'this file is no longer on disk');
    return { artifact: toRunArtifact(row), path };
  }

  /** Deletes expired files and their rows; removes run folders left empty. */
  async purgeExpired(): Promise<number> {
    const expired = await this.db
      .select()
      .from(runArtifacts)
      .where(lt(runArtifacts.expiresAt, this.now()));
    const runs = new Set<string>();
    for (const row of expired) {
      await rm(this.resolve(row.path), { force: true });
      runs.add(row.runId);
    }
    if (expired.length > 0) {
      await this.db.delete(runArtifacts).where(lt(runArtifacts.expiresAt, this.now()));
    }
    for (const runId of runs) await this.removeEmptyDirs(this.resolve(runId));
    return expired.length;
  }

  /** Total size on disk, for the operations page later. */
  async totalBytes(): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${runArtifacts.sizeBytes}), 0)` })
      .from(runArtifacts);
    return Number(row?.total ?? 0);
  }

  /** Resolves a relative artifact path, refusing anything outside the root. */
  private resolve(relativePath: string): string {
    const path = resolve(this.root, relativePath);
    const rel = relative(this.root, path);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`artifact path escapes the artifacts root: ${relativePath}`);
    }
    return path;
  }

  private async removeEmptyDirs(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      if (entry.isDirectory()) await this.removeEmptyDirs(join(dir, entry.name));
    }
    await rmdir(dir).catch(() => undefined); // fails while not empty: fine
  }
}

export function toRunArtifact(row: RunArtifactRow): RunArtifact {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    name: row.name,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
