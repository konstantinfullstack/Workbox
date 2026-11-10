import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Secret } from '#vault';

export interface GitCredentials {
  username: string;
  token: Secret;
}

export interface RunGitOptions {
  cwd?: string;
  credentials?: GitCredentials;
  timeoutMs?: number;
  /** Allow plain-http remotes (only for loopback test servers). */
  allowHttp?: boolean;
  /** Written to git's stdin (e.g. a commit message for `commit -F -`). */
  input?: string;
}

export type GitErrorKind = 'auth' | 'not_found' | 'network' | 'timeout' | 'failed';

/** A git failure with a message that is safe to show: tokens are scrubbed from git's output. */
export class GitError extends Error {
  constructor(
    readonly kind: GitErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

const ASKPASS_SCRIPT = `#!/bin/sh
# Workbox git credential prompt: answers from this process's environment only.
case "$1" in
  Username*) printf '%s\\n' "$WORKBOX_GIT_USERNAME" ;;
  *) printf '%s\\n' "$WORKBOX_GIT_PASSWORD" ;;
esac
`;

/**
 * Runs git with an isolated, minimal environment:
 * - the user's global/system git config (insteadOf rewrites, credential helpers, hooks) is ignored
 * - credentials, if any, are supplied per command through a GIT_ASKPASS helper that reads them
 *   from this child's environment; they are never written to disk, config or remote URLs
 * - no interactive prompts; only https (plus http for loopback tests)
 */
export async function runGit(
  args: string[],
  options: RunGitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const home = await mkdtemp(join(tmpdir(), 'workbox-git-'));
  await chmod(home, 0o700);
  const askpass = join(home, 'askpass.sh');
  const token = options.credentials?.token.reveal() ?? '';
  try {
    await writeFile(askpass, ASKPASS_SCRIPT, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: askpass,
      ...(options.credentials
        ? { WORKBOX_GIT_USERNAME: options.credentials.username, WORKBOX_GIT_PASSWORD: token }
        : {}),
    };
    const config = [
      '-c',
      'credential.helper=',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'protocol.file.allow=never',
      ...(options.allowHttp ? ['-c', 'protocol.http.allow=always'] : []),
    ];
    return await new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        [...config, ...args],
        {
          cwd: options.cwd,
          env,
          timeout: options.timeoutMs ?? 5 * 60_000,
          maxBuffer: 16 * 1024 * 1024,
          killSignal: 'SIGKILL',
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ stdout, stderr });
          const output = scrub(`${stderr}\n${error.message}`, token);
          reject(
            classify(
              output,
              (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true,
            ),
          );
        },
      );
      child.stdin?.end(options.input ?? '');
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function classify(output: string, killed: boolean): GitError {
  if (killed) return new GitError('timeout', 'git did not finish in time');
  if (
    /Authentication failed|could not read Username|could not read Password|Invalid username or password|HTTP Basic: Access denied|returned error: 40[13]/i.test(
      output,
    )
  ) {
    return new GitError(
      'auth',
      'authentication failed: the token was rejected or lacks repository access',
    );
  }
  if (
    /Repository not found|returned error: 404|does not appear to be a git repository|not found/i.test(
      output,
    )
  ) {
    return new GitError(
      'not_found',
      'repository not found at the remote, or the token cannot see it',
    );
  }
  if (
    /Could not resolve host|Connection refused|Connection timed out|Failed to connect|unable to access/i.test(
      output,
    )
  ) {
    return new GitError('network', 'could not reach the git server');
  }
  const firstLine = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^(fatal|error):/.test(line));
  return new GitError('failed', firstLine ? firstLine.slice(0, 300) : 'git command failed');
}

function scrub(text: string, token: string): string {
  return token ? text.split(token).join('[REDACTED]') : text;
}
