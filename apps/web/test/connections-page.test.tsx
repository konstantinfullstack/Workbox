import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ConnectionsPage } from '../src/pages/ConnectionsPage.js';
import { ProjectPage } from '../src/pages/ProjectPage.js';
import {
  CONNECTION_ID,
  makeConnection,
  makeProject,
  makeProjectRepository,
  mockApi,
  renderRoute,
  requestUrl,
} from './helpers.js';

const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
const runtime = {
  provider: 'claude_code',
  installed: false,
  version: null,
  loggedIn: null,
  authMethod: null,
  subscriptionType: null,
  loginExpiresAt: null,
  ok: false,
  message: 'Not checked yet.',
  checkedAt: null,
  workerId: null,
};

describe('connections page', () => {
  it('groups accounts by provider and shows token metadata, never the token', async () => {
    mockApi({
      'GET /api/v1/connections': () => ({
        json: {
          items: [
            makeConnection({
              tokenExpiresAt: soon,
              projects: [
                { id: '11111111-1111-4111-8111-111111111111', slug: 'demo', name: 'Demo' },
              ],
            }),
            makeConnection({
              id: '66666666-6666-4666-8666-666666666666',
              provider: 'gitlab',
              name: 'Company GitLab',
              baseUrl: 'https://gitlab.company.com',
              fingerprint: 'glpat-…x9Yz',
              status: 'expired',
              lastCheck: { ok: false, message: 'GitLab rejected the token' },
            }),
          ],
        },
      }),
      'GET /api/v1/agent-runtimes/claude-code': () => ({ json: runtime }),
    });
    renderRoute(<ConnectionsPage />, '/connections', '/connections');
    const githubGroup = within(await screen.findByRole('region', { name: 'GitHub accounts' }));
    expect(githubGroup.getByText('github_pat_…a1B2')).toBeInTheDocument();
    expect(githubGroup.getByText('expires in 5 days')).toBeInTheDocument();
    expect(githubGroup.getByRole('link', { name: 'Demo' })).toHaveAttribute(
      'href',
      '/projects/demo',
    );
    const gitlabGroup = within(screen.getByRole('region', { name: 'GitLab accounts' }));
    expect(gitlabGroup.getByText('Token expired')).toBeInTheDocument();
    expect(gitlabGroup.getByText('https://gitlab.company.com')).toBeInTheDocument();
  });

  it('replaces a token with a password field and disconnects after an inline confirmation', async () => {
    const fetchMock = mockApi({
      'GET /api/v1/connections': () => ({ json: { items: [makeConnection()] } }),
      'GET /api/v1/agent-runtimes/claude-code': () => ({ json: runtime }),
      [`POST /api/v1/connections/${CONNECTION_ID}/rotate`]: () => ({
        json: makeConnection({ fingerprint: 'github_pat_…n3w1' }),
      }),
      [`POST /api/v1/connections/${CONNECTION_ID}/disconnect`]: () => ({
        json: makeConnection({ hasSecret: false, status: 'disconnected' }),
      }),
    });
    renderRoute(<ConnectionsPage />, '/connections', '/connections');
    await userEvent.click(await screen.findByRole('button', { name: 'Replace token' }));
    const field = screen.getByLabelText('New token');
    expect(field).toHaveAttribute('type', 'password');
    await userEvent.type(field, 'github_pat_11NEWNEWNEWtoken_n3w1');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and replace' }));
    await waitFor(() => expect(screen.queryByLabelText('New token')).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(screen.getByText(/Delete this token from Workbox/)).toBeInTheDocument();
    await userEvent.click(
      within(screen.getByText(/Delete this token/)).getByRole('button', { name: 'Disconnect' }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => init?.method === 'POST' && requestUrl(url).endsWith('/disconnect'),
        ),
      ).toBe(true),
    );
  });

  it('checks the Claude Code runtime on demand', async () => {
    let current: Record<string, unknown> = runtime;
    mockApi({
      'GET /api/v1/connections': () => ({ json: { items: [] } }),
      'GET /api/v1/agent-runtimes/claude-code': () => ({ json: current }),
      'POST /api/v1/agent-runtimes/claude-code/check': () => {
        current = {
          ...runtime,
          installed: true,
          version: '2.1.318',
          loggedIn: true,
          authMethod: 'claude.ai',
          ok: true,
          message: 'Claude Code is installed and signed in.',
          checkedAt: new Date().toISOString(),
          workerId: 'host:1',
        };
        return { json: current };
      },
    });
    renderRoute(<ConnectionsPage />, '/connections', '/connections');
    expect(await screen.findByText('Not checked')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.getByText(/v2\.1\.318/)).toBeInTheDocument();
  });
});

describe('project repository card', () => {
  const baseRoutes = {
    'GET /api/v1/projects/demo/tasks': () => ({
      json: { items: [], total: 0, limit: 500, offset: 0 },
    }),
    'GET /api/v1/connections': () => ({ json: { items: [makeConnection()] } }),
  };

  it('shows the linked repository with its access checklist', async () => {
    mockApi({
      ...baseRoutes,
      'GET /api/v1/projects/demo': () => ({ json: makeProject() }),
      'GET /api/v1/projects/demo/repository': () => ({
        json: { repository: makeProjectRepository() },
      }),
    });
    renderRoute(<ProjectPage />, '/projects/:slug', '/projects/demo');
    const card = within(await screen.findByRole('region', { name: 'Repository' }));
    expect(await card.findByRole('link', { name: /kost\/workbox/ })).toHaveAttribute(
      'href',
      'https://github.com/kost/workbox',
    );
    expect(card.getByText('Access verified')).toBeInTheDocument();
    expect(card.getByText(/pull requests \(confirmed on first use\)/)).toBeInTheDocument();
    expect(card.getByRole('button', { name: 'Verify again' })).toBeInTheDocument();
    // Local clone
    expect(card.getByText('Ready')).toBeInTheDocument();
    expect(card.getByText(/main @ a1b2c3d/)).toBeInTheDocument();
    expect(card.getByText(/2\.0 MB/)).toBeInTheDocument();
    expect(card.getByText('~/code/workbox/workspaces/demo')).toBeInTheDocument();
  });

  it('shows a failed clone with its reason and lets you sync again', async () => {
    const fetchMock = mockApi({
      ...baseRoutes,
      'GET /api/v1/projects/demo': () => ({ json: makeProject() }),
      'GET /api/v1/projects/demo/repository': () => ({
        json: {
          repository: makeProjectRepository({
            workspace: {
              status: 'failed',
              path: null,
              headSha: null,
              sizeKb: null,
              lastSyncedAt: null,
              lastError:
                'authentication failed: the token was rejected. Replace the token on the Connections page.',
              workerId: 'host:1',
              updatedAt: new Date().toISOString(),
            },
          }),
        },
      }),
      'POST /api/v1/projects/demo/repository/sync': () => ({
        status: 202,
        json: makeProjectRepository(),
      }),
    });
    renderRoute(<ProjectPage />, '/projects/:slug', '/projects/demo');
    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/authentication failed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => init?.method === 'POST' && requestUrl(url).endsWith('/repository/sync'),
        ),
      ).toBe(true),
    );
  });

  it('points to the Connections page when the token expired', async () => {
    mockApi({
      ...baseRoutes,
      'GET /api/v1/projects/demo': () => ({ json: makeProject() }),
      'GET /api/v1/projects/demo/repository': () => ({
        json: {
          repository: makeProjectRepository({
            accessStatus: 'expired',
            connectionStatus: 'expired',
            lastError: 'GitHub rejected the token',
          }),
        },
      }),
    });
    renderRoute(<ProjectPage />, '/projects/:slug', '/projects/demo');
    expect(await screen.findByText('GitHub rejected the token')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Replace token →' })).toHaveAttribute(
      'href',
      '/connections',
    );
  });

  it('suggests connecting a legacy typed repository URL', async () => {
    mockApi({
      ...baseRoutes,
      'GET /api/v1/projects/demo': () => ({
        json: makeProject({ repoUrl: 'git@github.com:kost/workbox.git' }),
      }),
      'GET /api/v1/projects/demo/repository': () => ({ json: { repository: null } }),
      [`GET /api/v1/connections/${CONNECTION_ID}/repositories`]: () => ({ json: { items: [] } }),
    });
    renderRoute(<ProjectPage />, '/projects/:slug', '/projects/demo');
    expect(await screen.findByText(/typed in earlier but is not verified/)).toBeInTheDocument();
    expect(await screen.findByPlaceholderText('Search repositories…')).toHaveValue('workbox');
  });
});
