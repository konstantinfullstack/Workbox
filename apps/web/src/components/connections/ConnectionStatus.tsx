import { useState } from 'react';
import type { Connection, ConnectionStatus as Status, RepositoryAccessStatus } from '#shared';
import { CODE_HOSTS } from '#shared';

const STATUS_LABELS: Record<Status, string> = {
  unconfigured: 'Not configured',
  connected: 'Connected',
  degraded: 'Problem',
  expired: 'Token expired',
  disconnected: 'Disconnected',
};

export function ConnectionStatusBadge({ status }: { status: Status }) {
  return <span className={`badge conn-${status}`}>{STATUS_LABELS[status]}</span>;
}

const ACCESS_LABELS: Record<RepositoryAccessStatus, string> = {
  verified: 'Access verified',
  denied: 'No access',
  expired: 'Token expired',
  unverified: 'Not verified',
};

export function AccessStatusBadge({ status }: { status: RepositoryAccessStatus }) {
  return <span className={`badge access-${status}`}>{ACCESS_LABELS[status]}</span>;
}

export function ProviderLabel({ provider }: { provider: Connection['provider'] }) {
  return (
    <span className="provider">
      {provider === 'claude_code' ? 'Claude Code' : CODE_HOSTS[provider].label}
    </span>
  );
}

/** "expires in 12 days", "expired 3 days ago", "no expiry". Warns within 14 days. */
export function TokenExpiry({ expiresAt }: { expiresAt: string | null }) {
  const [now] = useState(() => Date.now());
  if (!expiresAt) return <span className="muted">no expiry date</span>;
  const days = Math.round((new Date(expiresAt).getTime() - now) / 86_400_000);
  if (days < 0)
    return (
      <span className="field-error">
        expired {-days} day{days === -1 ? '' : 's'} ago
      </span>
    );
  const text = days === 0 ? 'expires today' : `expires in ${days} day${days === 1 ? '' : 's'}`;
  return <span className={days <= 14 ? 'warning-text' : 'muted'}>{text}</span>;
}

export function accountLabel(
  connection: Pick<Connection, 'provider' | 'name' | 'account' | 'baseUrl'>,
): string {
  const host = new URL(connection.baseUrl).host;
  const defaultHost =
    connection.provider !== 'claude_code' &&
    host === new URL(CODE_HOSTS[connection.provider].defaultBaseUrl).host;
  return `${connection.name}${connection.account ? ` (${connection.account}${defaultHost ? '' : ` @ ${host}`})` : ''}`;
}
