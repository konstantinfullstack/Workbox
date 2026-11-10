import type { Workspace } from '#shared';
import { useState } from 'react';

const LABELS: Record<Workspace['status'], string> = {
  queued: 'Queued',
  syncing: 'Cloning / syncing…',
  ready: 'Ready',
  failed: 'Failed',
};

const BADGE: Record<Workspace['status'], string> = {
  queued: 'conn-degraded',
  syncing: 'conn-degraded',
  ready: 'conn-connected',
  failed: 'conn-expired',
};

/** The worker's local clone: status, commit, size, location and last error. */
export function WorkspaceStatus({
  workspace,
  defaultBranch,
  onSync,
  syncing,
}: {
  workspace: Workspace | null;
  defaultBranch: string;
  onSync: () => void;
  syncing: boolean;
}) {
  const [now] = useState(() => Date.now());
  const busy = syncing || workspace?.status === 'queued' || workspace?.status === 'syncing';
  return (
    <div className="workspace">
      {workspace ? (
        <span className={`badge ${BADGE[workspace.status]}`}>{LABELS[workspace.status]}</span>
      ) : (
        <span className="badge">Not cloned</span>
      )}{' '}
      {workspace?.status === 'ready' && (
        <span className="small">
          <span className="mono">
            {defaultBranch} @ {workspace.headSha ? workspace.headSha.slice(0, 7) : 'empty'}
          </span>
          {workspace.sizeKb !== null && <> · {formatSize(workspace.sizeKb)}</>}
          {workspace.lastSyncedAt && <> · synced {ago(workspace.lastSyncedAt, now)}</>}
        </span>
      )}
      <button type="button" className="secondary small-button" disabled={busy} onClick={onSync}>
        {busy ? 'Syncing…' : 'Sync now'}
      </button>
      {workspace?.path && <div className="mono small muted">{workspace.path}</div>}
      {workspace?.status === 'failed' && workspace.lastError && (
        <div className="warning-text small">{workspace.lastError}</div>
      )}
    </div>
  );
}

export function formatSize(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / 1024 / 1024).toFixed(2)} GB`;
}

function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
