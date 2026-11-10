import type { CodeHostProvider } from '#shared';
import type { CodeHostAdapter } from './code-host.js';
import { GitHubAdapter } from './github/adapter.js';
import { GitLabAdapter } from './gitlab/adapter.js';
import type { HttpOptions } from './http.js';

export type CodeHostRegistry = Record<CodeHostProvider, CodeHostAdapter>;

/** One adapter per supported code host. Adding a provider = adding an adapter here. */
export function createCodeHostRegistry(http: HttpOptions = {}): CodeHostRegistry {
  return { github: new GitHubAdapter(http), gitlab: new GitLabAdapter(http) };
}
