/** Pure validation rules shared by the API (server-side enforcement) and the dashboard (UX hints). */

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 64;

/** Derives a URL-safe slug from a project name, e.g. "My App (v2)" → "my-app-v2". */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
}

export type RepoUrlCheck = { ok: true } | { ok: false; reason: string };

const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[^\s]+$/;

/**
 * Accepts HTTPS, ssh:// and scp-style (`git@host:owner/repo.git`) Git remotes.
 * Rejects embedded credentials: tokens must live in the credential vault (M3), never in a URL
 * that ends up in the database, logs or `git remote -v`.
 */
export function checkRepoUrl(value: string): RepoUrlCheck {
  const trimmed = value.trim();
  if (trimmed !== value || /\s/.test(value)) {
    return { ok: false, reason: 'must not contain whitespace' };
  }
  if (SCP_LIKE.test(value)) {
    return { ok: true };
  }
  if (!URL.canParse(value)) {
    return { ok: false, reason: 'must be an https://, ssh:// or git@host:path Git URL' };
  }
  const url = new URL(value);
  if (url.protocol === 'https:') {
    if (url.username || url.password) {
      return { ok: false, reason: 'must not contain credentials; use a connection instead' };
    }
  } else if (url.protocol === 'ssh:') {
    if (url.password) {
      return { ok: false, reason: 'must not contain credentials; use a connection instead' };
    }
  } else {
    return { ok: false, reason: 'must use https:// or ssh://' };
  }
  if (!url.hostname || url.pathname.length <= 1) {
    return { ok: false, reason: 'must include a host and repository path' };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: 'must not contain a query string or fragment' };
  }
  return { ok: true };
}

/** Git ref-name rules relevant to branch names (subset of `git check-ref-format`). */
export function isValidBranchName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    !/[\s~^:?*[\\]/.test(value) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock') &&
    !value.startsWith('-') &&
    !value.includes('//')
  );
}
