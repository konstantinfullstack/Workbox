import type { CodeHostProvider } from '#shared';

/**
 * The account's private "no-reply" address: commits count as the user's activity on the code host
 * without exposing their real email (U7).
 *   GitHub: <id>+<login>@users.noreply.github.com   (Enterprise: users.noreply.<host>)
 *   GitLab: <id>-<username>@users.noreply.gitlab.com (self-managed: users.noreply.<host>)
 */
export function noReplyEmail(
  provider: CodeHostProvider,
  baseUrl: string,
  account: string,
  accountId: string | null,
): string {
  const host = new URL(baseUrl).hostname;
  const domain = `users.noreply.${host}`;
  if (provider === 'github')
    return accountId ? `${accountId}+${account}@${domain}` : `${account}@${domain}`;
  return accountId ? `${accountId}-${account}@${domain}` : `${account}@${domain}`;
}
