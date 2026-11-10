import { spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { agentEnvironment } from '#agents';
import type { CheckCommand, CheckResult } from '#shared';

const OUTPUT_LIMIT = 16_000;

/**
 * Runs the project's confirmed setup + check commands in the working copy (spec §6
 * "run configured checks"). Same isolation as the agent (ADR-004): no Workbox secrets in the
 * environment, own process group, time limit. `CI=true` makes test runners run once, not watch.
 * Stops at the first failure; later commands are not run.
 */
export async function runChecks(options: {
  cwd: string;
  setup: string | null;
  commands: CheckCommand[];
  timeoutMs?: number;
  onStart?: (check: CheckCommand) => void;
  /** Where to save a step's complete output (the result keeps only the last 16 KB). */
  outputFile?: (check: CheckCommand, index: number) => Promise<string>;
}): Promise<CheckResult[]> {
  const steps = [
    ...(options.setup ? [{ name: 'setup', command: options.setup }] : []),
    ...options.commands,
  ];
  const results: CheckResult[] = [];
  for (const [index, step] of steps.entries()) {
    options.onStart?.(step);
    const file = await options.outputFile?.(step, index).catch(() => undefined);
    const result = await runOne(step, options.cwd, options.timeoutMs ?? 15 * 60_000, file);
    results.push(result);
    if (result.status !== 'passed') break;
  }
  return results;
}

function runOne(
  step: CheckCommand,
  cwd: string,
  timeoutMs: number,
  file: string | undefined,
): Promise<CheckResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let full: WriteStream | null = file ? createWriteStream(file, { mode: 0o600 }) : null;
    full?.on('error', () => {
      full = null;
    });
    full?.write(`$ ${step.command}\n`);
    let timedOut = false;
    const child = spawn('/bin/sh', ['-c', step.command], {
      cwd,
      env: { ...agentEnvironment(), CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const append = (chunk: Buffer) => {
      full?.write(chunk);
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    let settled = false;
    const done = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result: CheckResult = {
        name: step.name,
        command: step.command,
        status: timedOut ? 'timed_out' : exitCode === 0 ? 'passed' : 'failed',
        exitCode,
        durationMs: Date.now() - started,
        output: output.trim(),
      };
      if (!full) return resolve(result);
      full.end(
        `\n[${result.status}${exitCode === null ? '' : `, exit code ${exitCode}`}, ${Math.round(result.durationMs / 1000)} s]\n`,
        () => resolve(result),
      );
    };
    child.on('error', (error) => {
      output += `\n${error.message}`;
      done(null);
    });
    child.on('close', (code) => done(code));
  });
}

/** Short failure report handed to the agent for its one retry. */
export function describeFailures(results: CheckResult[]): string {
  return results
    .filter((r) => r.status !== 'passed')
    .map(
      (r) =>
        `Check "${r.name}" (\`${r.command}\`) ${r.status === 'timed_out' ? 'timed out' : `failed with exit code ${r.exitCode}`}:\n${r.output.slice(-6_000)}`,
    )
    .join('\n\n');
}
