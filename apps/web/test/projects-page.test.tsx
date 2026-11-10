import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProjectsPage } from '../src/pages/ProjectsPage.js';
import {
  CONNECTION_ID,
  makeConnection,
  makeProject,
  makeRemoteRepo,
  mockApi,
  renderRoute,
  requestUrl,
} from './helpers.js';

const TOKEN = 'github_pat_11ZZZZ9999dashboardTestToken_Qq11';

describe('projects page', () => {
  it('lists projects with their repository and task counts', async () => {
    mockApi({
      'GET /api/v1/projects': () => ({
        json: {
          items: [
            makeProject({
              name: 'Workbox',
              slug: 'workbox',
              totalTasks: 7,
              repository: {
                provider: 'gitlab',
                fullPath: 'team/workbox',
                webUrl: 'https://gitlab.com/team/workbox',
                accessStatus: 'expired',
              },
            }),
          ],
        },
      }),
    });
    renderRoute(<ProjectsPage />, '/projects', '/projects');
    expect(await screen.findByRole('link', { name: 'Workbox' })).toHaveAttribute(
      'href',
      '/projects/workbox',
    );
    expect(screen.getByText('team/workbox')).toBeInTheDocument();
    expect(screen.getByText('Token expired')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    mockApi({ 'GET /api/v1/projects': () => ({ json: { items: [] } }) });
    renderRoute(<ProjectsPage />, '/projects', '/projects');
    expect(await screen.findByText(/No projects yet/)).toBeInTheDocument();
  });

  it('creates a project without a repository and shows API errors such as a taken slug', async () => {
    mockApi({
      'GET /api/v1/projects': () => ({ json: { items: [] } }),
      'GET /api/v1/connections': () => ({ json: { items: [] } }),
      'POST /api/v1/projects': () => ({
        status: 409,
        json: {
          error: { code: 'SLUG_TAKEN', message: 'a project with slug "dup" already exists' },
        },
      }),
    });
    renderRoute(<ProjectsPage />, '/projects', '/projects');
    await userEvent.click(await screen.findByRole('button', { name: 'New project' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Dup');
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled(); // repository step selected by default
    await userEvent.click(screen.getByLabelText('No repository yet (planning only)'));
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(screen.getByText('SLUG_TAKEN')).toBeInTheDocument();
  });

  it('adds an account inline, picks a repository, then creates and links the project', async () => {
    let connections: unknown[] = [];
    const fetchMock = mockApi({
      'GET /api/v1/projects': () => ({ json: { items: [] } }),
      'GET /api/v1/connections': () => ({ json: { items: connections } }),
      'POST /api/v1/connections': () => {
        connections = [makeConnection()];
        return { status: 201, json: connections[0] };
      },
      [`GET /api/v1/connections/${CONNECTION_ID}/repositories`]: () => ({
        json: {
          items: [
            makeRemoteRepo(),
            makeRemoteRepo({
              externalId: '102',
              fullPath: 'kost/read-only',
              access: { pull: true, push: false },
            }),
          ],
        },
      }),
      'POST /api/v1/projects': () => ({
        status: 201,
        json: makeProject({ name: 'New', slug: 'new' }),
      }),
      'PUT /api/v1/projects/new/repository': () => ({ json: {} }),
    });
    renderRoute(<ProjectsPage />, '/projects', '/projects');
    await userEvent.click(await screen.findByRole('button', { name: 'New project' }));
    await userEvent.type(screen.getByLabelText('Name'), 'New');

    // No accounts yet: the add-account form is shown inline.
    const form = await screen.findByRole('group', { name: 'Add account' });
    const tokenField = within(form).getByLabelText('Fine-grained personal access token');
    expect(tokenField).toHaveAttribute('type', 'password');
    expect(within(form).getByText(/Contents: Read and write/)).toBeInTheDocument();
    await userEvent.type(tokenField, TOKEN);
    await userEvent.click(within(form).getByRole('button', { name: 'Verify and save' }));

    // The new account is selected and its repositories are listed.
    await userEvent.click(await screen.findByRole('option', { name: /kost\/workbox/ }));
    expect(screen.getByText(/Selected/)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project and link repository' }),
    );

    await waitFor(() => expect(screen.getByText('other page')).toBeInTheDocument()); // navigated to the project
    // Saving the account must not have submitted the project form: exactly one project POST.
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => init?.method === 'POST' && requestUrl(url).endsWith('/api/v1/projects'),
      ),
    ).toHaveLength(1);
    const sent = fetchMock.mock.calls.map(
      ([url, init]) => `${init?.method ?? 'GET'} ${requestUrl(url).split('?')[0]}`,
    );
    expect(sent).toEqual(
      expect.arrayContaining([
        'POST /api/v1/connections',
        'POST /api/v1/projects',
        'PUT /api/v1/projects/new/repository',
      ]),
    );
    const linkBody = fetchMock.mock.calls.find(
      ([url, init]) => init?.method === 'PUT' && requestUrl(url).includes('/repository'),
    )?.[1]?.body;
    expect(JSON.parse(typeof linkBody === 'string' ? linkBody : '{}')).toEqual({
      connectionId: CONNECTION_ID,
      externalId: '101',
    });
    // The token was sent only to the create-account endpoint and is not on screen.
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it('clears a rejected token from the field', async () => {
    mockApi({
      'GET /api/v1/projects': () => ({ json: { items: [] } }),
      'GET /api/v1/connections': () => ({ json: { items: [] } }),
      'POST /api/v1/connections': () => ({
        status: 422,
        json: {
          error: {
            code: 'CREDENTIAL_REJECTED',
            message: 'GitHub rejected the token (invalid, revoked or expired)',
          },
        },
      }),
    });
    renderRoute(<ProjectsPage />, '/projects', '/projects');
    await userEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const field = await screen.findByLabelText('Fine-grained personal access token');
    await userEvent.type(field, TOKEN);
    await userEvent.click(screen.getByRole('button', { name: 'Verify and save' }));
    expect(await screen.findByText(/rejected the token/)).toBeInTheDocument();
    expect(field).toHaveValue('');
  });
});
