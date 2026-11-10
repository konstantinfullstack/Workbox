import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  AgentAdapter,
  AgentCapability,
  AgentEvent,
  AgentResult,
  AgentTask,
} from '../contract.js';
import { parseAgentReport } from '../instructions.js';

export interface ClaudeCodeAdapterOptions {
  /** Executable (CLAUDE_CODE_COMMAND); default `claude` on PATH. */
  command?: string;
  model?: string;
}

/** File tools only; `Bash` is added (restricted to allowed commands) when checks are configured. */
const FILE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
/** Never allowed, even if a pattern would otherwise match. */
const DENIED = [
  'Bash(git push:*)',
  'Bash(git remote:*)',
  'Bash(git config:*)',
  'Bash(git credential:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
  'WebFetch',
  'WebSearch',
];

/**
 * Runs Claude Code headless (`claude -p`, stream-json) in the run's worktree.
 *
 * Isolation level (a), ADR-004: `--restricted` (only the named tools; user/project settings
 * ignored; file tools confined to the working directory), permission mode `dontAsk` (anything not
 * pre-allowed is denied), a minimal environment with no Workbox secrets or tokens, and its own
 * process group so cancel/timeout kill everything it started.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude_code';

  constructor(private readonly options: ClaudeCodeAdapterOptions = {}) {}

  capabilities(): readonly AgentCapability[] {
    return ['code_edit', 'shell', 'stream_events'];
  }

  buildArgs(task: AgentTask): string[] {
    const tools = task.allowedCommands.length > 0 ? [...FILE_TOOLS, 'Bash'] : FILE_TOOLS;
    const allowed = [...FILE_TOOLS, ...task.allowedCommands.map((command) => `Bash(${command})`)];
    return [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--restricted',
      '--tools',
      tools.join(','),
      '--allowedTools',
      allowed.join(','),
      '--disallowedTools',
      DENIED.join(','),
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
      ...(this.options.model ? ['--model', this.options.model] : []),
    ];
  }

  execute(
    task: AgentTask,
    emit: (event: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    return new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(this.options.command ?? 'claude', this.buildArgs(task), {
        cwd: task.workspacePath,
        env: agentEnvironment(),
        detached: true, // own process group: kill(-pid) stops tools it spawned too
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let finished = false;
      let outcome: 'cancelled' | 'timed_out' | null = null;
      let result: {
        isError: boolean;
        text: string;
        costUsd?: number;
        turns?: number;
        denials: number;
      } | null = null;
      const stderr: string[] = [];

      const killGroup = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }, 5_000).unref();
      };
      const timer = setTimeout(() => {
        outcome = 'timed_out';
        killGroup();
      }, task.timeoutMs);
      const onAbort = () => {
        outcome ??= 'cancelled';
        killGroup();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (error) => {
        finish({
          status: 'failed',
          summary: '',
          qaSteps: [],
          failureReason:
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'Claude Code CLI not found on the worker (set CLAUDE_CODE_COMMAND or install it).'
              : `Claude Code could not start: ${error.message}`,
        });
      });

      createInterface({ input: child.stdout }).on('line', (line) => {
        const parsed = parseLine(line);
        if (parsed.event) emit(parsed.event);
        if (parsed.result) result = parsed.result;
      });
      createInterface({ input: child.stderr }).on('line', (line) => {
        if (stderr.length < 50) stderr.push(line.slice(0, 500));
      });

      // The CLI may exit before reading its input (bad flags, auth failure): ignore EPIPE on stdin;
      // the exit is reported through 'close' like any other failure.
      child.stdin.on('error', () => undefined);
      child.stdin.end(task.instructions);

      child.on('close', (code) => {
        const durationMs = Date.now() - started;
        if (outcome) {
          return finish({
            status: outcome,
            summary: '',
            qaSteps: [],
            failureReason:
              outcome === 'timed_out'
                ? `Agent exceeded the ${Math.round(task.timeoutMs / 60_000)} min time limit.`
                : 'Run cancelled.',
            usage: { durationMs },
          });
        }
        if (!result) {
          return finish({
            status: 'failed',
            summary: '',
            qaSteps: [],
            failureReason:
              `Claude Code exited (code ${code ?? 'signal'}) without a result. ${stderr.slice(-3).join(' ')}`.trim(),
            usage: { durationMs },
          });
        }
        const report = parseAgentReport(result.text);
        const usage = {
          durationMs,
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          ...(result.turns !== undefined ? { turns: result.turns } : {}),
        };
        if (result.isError) {
          return finish({
            status: 'failed',
            ...report,
            failureReason: `Claude Code reported an error: ${result.text.slice(0, 500)}`,
            usage,
          });
        }
        finish({ status: 'completed', ...report, usage });
      });

      function finish(value: AgentResult) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      }
    });
  }
}

interface ParsedLine {
  event?: AgentEvent;
  result?: { isError: boolean; text: string; costUsd?: number; turns?: number; denials: number };
}

/** Maps one stream-json line (Claude Code's headless output) onto the neutral event model. */
export function parseLine(line: string): ParsedLine {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line.trim()
      ? { event: { type: 'log', message: line.slice(0, 500), data: { level: 'info' } } }
      : {};
  }
  switch (message.type) {
    case 'system':
      if (message.subtype === 'init') {
        const tools = Array.isArray(message.tools) ? (message.tools as string[]) : [];
        const model = typeof message.model === 'string' ? message.model : undefined;
        return {
          event: {
            type: 'started',
            message: `Agent started${model ? ` (${model})` : ''}`,
            data: { ...(model ? { model } : {}), tools },
          },
        };
      }
      return {};
    case 'assistant': {
      const content = ((message.message as { content?: unknown[] } | undefined)?.content ??
        []) as Array<Record<string, unknown>>;
      for (const block of content) {
        if (block.type === 'tool_use') {
          const tool = String(block.name);
          const target = toolTarget(block.input);
          return {
            event: {
              type: 'tool_call',
              message: target ? `${tool} ${target}` : tool,
              data: { tool, ...(target ? { target } : {}) },
            },
          };
        }
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          return {
            event: { type: 'progress', message: block.text.trim().slice(0, 2_000), data: {} },
          };
        }
      }
      return {};
    }
    case 'result': {
      const denials = Array.isArray(message.permission_denials)
        ? message.permission_denials.length
        : 0;
      return {
        result: {
          isError: message.is_error === true || message.subtype !== 'success',
          text: typeof message.result === 'string' ? message.result : '',
          ...(typeof message.total_cost_usd === 'number'
            ? { costUsd: message.total_cost_usd }
            : {}),
          ...(typeof message.num_turns === 'number' ? { turns: message.num_turns } : {}),
          denials,
        },
        ...(denials > 0
          ? {
              event: {
                type: 'log',
                message: `${denials} tool use(s) were denied by the run's permission rules`,
                data: { level: 'warn' },
              },
            }
          : {}),
      };
    }
    default:
      return {};
  }
}

function toolTarget(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value =
    (input as Record<string, unknown>).file_path ??
    (input as Record<string, unknown>).path ??
    (input as Record<string, unknown>).pattern ??
    (input as Record<string, unknown>).command;
  return typeof value === 'string' ? value.slice(0, 200) : undefined;
}

/** Minimal environment: enough for Claude Code to find its own login, nothing from Workbox. */
export function agentEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TERM',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'CLAUDE_CONFIG_DIR',
  ];
  return Object.fromEntries(
    keep.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
}
