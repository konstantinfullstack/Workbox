/**
 * A real git smart-HTTP server for tests (`git http-backend` behind HTTP Basic auth), so clone and
 * fetch go through the same credential flow as GitHub/GitLab over https.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GitHttpServer {
  /** e.g. http://127.0.0.1:PORT/kost/app.git */
  url(repoPath: string): string;
  /** Accepted username → password pairs. */
  accounts: Map<string, string>;
  /** Every Authorization header received (to assert what was sent). */
  authHeaders: string[];
  /** Create a bare repo with one commit on `branch`. Returns the commit sha. */
  createRepo(repoPath: string, branch?: string): string;
  /** Add a commit to `branch` of an existing repo. Returns the new sha. */
  commit(repoPath: string, message: string, branch?: string): string;
  close(): Promise<void>;
}

const BACKEND = join(execFileSync('git', ['--exec-path']).toString().trim(), 'git-http-backend');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (args: string[], cwd?: string) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    env: gitEnv,
  })
    .toString()
    .trim();

export async function startGitHttpServer(): Promise<GitHttpServer> {
  const root = mkdtempSync(join(tmpdir(), 'workbox-githttp-'));
  const accounts = new Map<string, string>();
  const authHeaders: string[] = [];

  const authorised = (req: IncomingMessage) => {
    const header = req.headers.authorization ?? '';
    if (header) authHeaders.push(header);
    const match = /^Basic (.+)$/.exec(header);
    if (!match) return false;
    const [user, ...rest] = Buffer.from(match[1]!, 'base64').toString().split(':');
    return accounts.get(user ?? '') === rest.join(':');
  };

  const server = createServer((req, res) => {
    if (!authorised(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' });
      res.end('Unauthorized');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cgi = spawn(BACKEND, [], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_USER: 'test',
        REMOTE_ADDR: '127.0.0.1',
        ...(req.headers['git-protocol']
          ? { GIT_PROTOCOL: String(req.headers['git-protocol']) }
          : {}),
      },
    });
    req.pipe(cgi.stdin);
    let buffer = Buffer.alloc(0);
    let headersSent = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (headersSent) return void res.write(chunk);
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = buffer.subarray(0, end).toString();
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.split('\r\n')) {
        const [key, ...value] = line.split(':');
        if (!key) continue;
        if (key.toLowerCase() === 'status') status = Number(value.join(':').trim().split(' ')[0]);
        else headers[key] = value.join(':').trim();
      }
      res.writeHead(status, headers);
      headersSent = true;
      res.write(buffer.subarray(end + 4));
    });
    cgi.stdout.on('end', () => res.end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const commit = (repoPath: string, message: string, branch = 'main') => {
    const work = mkdtempSync(join(tmpdir(), 'workbox-gitwork-'));
    try {
      git(['clone', '--quiet', join(root, repoPath), work]);
      // Continue an existing remote branch; otherwise start it from the default branch.
      const remoteExists = (() => {
        try {
          git(['rev-parse', '--verify', '--quiet', `origin/${branch}`], work);
          return true;
        } catch {
          return false;
        }
      })();
      git(
        ['checkout', '--quiet', '-B', branch, ...(remoteExists ? [`origin/${branch}`] : [])],
        work,
      );
      writeFileSync(join(work, `${Date.now()}-${Math.random()}.txt`), message);
      git(['add', '.'], work);
      git(['commit', '--quiet', '-m', message], work);
      git(['push', '--quiet', 'origin', branch], work);
      return git(['rev-parse', 'HEAD'], work);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };

  return {
    url: (repoPath) => `http://127.0.0.1:${port}/${repoPath}`,
    accounts,
    authHeaders,
    createRepo(repoPath, branch = 'main') {
      git(['init', '--quiet', '--bare', `--initial-branch=${branch}`, join(root, repoPath)]);
      return commit(repoPath, 'initial commit', branch);
    },
    commit,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          rmSync(root, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
