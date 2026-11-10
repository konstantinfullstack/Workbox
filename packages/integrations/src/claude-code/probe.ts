import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ClaudeCodeProbeResult {
  installed: boolean;
  version: string | null;
  loggedIn: boolean | null;
  authMethod: string | null;
  subscriptionType: string | null;
  loginExpiresAt: string | null;
  ok: boolean;
  message: string;
}

export interface ProbeOptions {
  /** Executable name or path (CLAUDE_CODE_COMMAND); defaults to `claude` on PATH. */
  command?: string;
  timeoutMs?: number;
}

/**
 * Checks that the Claude Code CLI is installed and signed in on this machine, using only free,
 * non-interactive commands (`--version`, `auth status --json`). No credential is read or stored:
 * a local login is a worker capability (spec §8). Personal fields (email, org id) are discarded.
 */
export async function probeClaudeCode(options: ProbeOptions = {}): Promise<ClaudeCodeProbeResult> {
  const command = options.command ?? 'claude';
  const timeout = options.timeoutMs ?? 15_000;
  const base: ClaudeCodeProbeResult = {
    installed: false,
    version: null,
    loggedIn: null,
    authMethod: null,
    subscriptionType: null,
    loginExpiresAt: null,
    ok: false,
    message: '',
  };

  let versionOutput: string;
  try {
    versionOutput = (await run(command, ['--version'], { timeout, env: safeEnv() })).stdout;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      ...base,
      message: missing
        ? 'Claude Code CLI not found. Install it and run `claude` once to sign in.'
        : 'Claude Code CLI did not run successfully (`claude --version` failed).',
    };
  }
  const version = /(\d+\.\d+\.\d+)/.exec(versionOutput)?.[1] ?? null;

  try {
    const { stdout } = await run(command, ['auth', 'status', '--json'], {
      timeout,
      env: safeEnv(),
    });
    const status = JSON.parse(stdout) as Record<string, unknown>;
    const loggedIn = status.loggedIn === true;
    return {
      installed: true,
      version,
      loggedIn,
      authMethod: typeof status.authMethod === 'string' ? status.authMethod : null,
      subscriptionType:
        typeof status.subscriptionType === 'string' ? status.subscriptionType : null,
      loginExpiresAt: typeof status.loginExpiresAt === 'string' ? status.loginExpiresAt : null,
      ok: loggedIn,
      message: loggedIn
        ? 'Claude Code is installed and signed in.'
        : 'Claude Code is installed but not signed in. Run `claude` and sign in.',
    };
  } catch {
    return {
      ...base,
      installed: true,
      version,
      message:
        'Claude Code is installed, but its sign-in status could not be read (`claude auth status`).',
    };
  }
}

/** Keep the probe's environment minimal: never pass Workbox secrets to a child process. */
function safeEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USER', 'LANG', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR'];
  return Object.fromEntries(
    keep.filter((key) => process.env[key]).map((key) => [key, process.env[key]]),
  );
}
