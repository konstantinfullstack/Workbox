import type { CodeHostProvider } from './domain.js';

/** Static catalog used by the dashboard (and the future CLI) to render "add account" forms. */
export interface CodeHostDefinition {
  provider: CodeHostProvider;
  label: string;
  reviewRequestLabel: string;
  defaultBaseUrl: string;
  selfHosted: boolean;
  tokenLabel: string;
  tokenPlaceholder: string;
  /** Human instructions: which token to create, where, and with what permissions. */
  tokenHelp: { summary: string; steps: string[]; settingsUrl: (baseUrl: string) => string };
  /** Web links inside a repository (`webUrl` = the repository's page). */
  commitUrl: (webUrl: string, sha: string) => string;
  branchUrl: (webUrl: string, branch: string) => string;
}

export const CODE_HOSTS: Record<CodeHostProvider, CodeHostDefinition> = {
  github: {
    provider: 'github',
    label: 'GitHub',
    reviewRequestLabel: 'pull request',
    defaultBaseUrl: 'https://github.com',
    selfHosted: true,
    tokenLabel: 'Fine-grained personal access token',
    tokenPlaceholder: 'github_pat_…',
    tokenHelp: {
      summary:
        'Create a fine-grained token limited to the repositories Workbox should work on. A token belongs to one owner (you or one organisation).',
      steps: [
        'Resource owner: your user or the organisation that owns the repos',
        'Repository access: "Only select repositories"',
        'Permissions → Contents: Read and write',
        'Permissions → Pull requests: Read and write',
        'Permissions → Metadata: Read-only (selected automatically)',
        'Set an expiry date; Workbox warns you before it expires',
      ],
      settingsUrl: (baseUrl) => `${baseUrl.replace(/\/$/, '')}/settings/personal-access-tokens/new`,
    },
    commitUrl: (webUrl, sha) => `${trimSlash(webUrl)}/commit/${sha}`,
    branchUrl: (webUrl, branch) => `${trimSlash(webUrl)}/tree/${encodeBranch(branch)}`,
  },
  gitlab: {
    provider: 'gitlab',
    label: 'GitLab',
    reviewRequestLabel: 'merge request',
    defaultBaseUrl: 'https://gitlab.com',
    selfHosted: true,
    tokenLabel: 'Project, group or personal access token',
    tokenPlaceholder: 'glpat-…',
    tokenHelp: {
      summary:
        'Prefer a project access token (one project) or group access token (one group). A personal access token also works but reaches everything you can access.',
      steps: [
        'Project → Settings → Access tokens (or Group → Settings → Access tokens)',
        'Role: Developer (needed to push branches and open merge requests)',
        'Scopes: api, read_repository, write_repository',
        'Set an expiry date; Workbox warns you before it expires',
      ],
      settingsUrl: (baseUrl) =>
        `${baseUrl.replace(/\/$/, '')}/-/user_settings/personal_access_tokens`,
    },
    commitUrl: (webUrl, sha) => `${trimSlash(webUrl)}/-/commit/${sha}`,
    branchUrl: (webUrl, branch) => `${trimSlash(webUrl)}/-/tree/${encodeBranch(branch)}`,
  },
};

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Branch names keep their `/` in web URLs; everything else is encoded. */
function encodeBranch(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}
