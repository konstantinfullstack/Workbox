import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildTaskInstructions,
  ClaudeCodeAdapter,
  parseAgentReport,
  type AgentEvent,
  type AgentTask,
} from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'workbox-agent-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in `claude` that speaks stream-json like the real CLI. */
function fakeClaude(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const prompt = fs.readFileSync(0, 'utf8');
${body}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function task(workspacePath: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    runId: 'run-1',
    workspacePath,
    instructions: 'Do the thing.',
    timeoutMs: 10_000,
    allowedCommands: [],
    ...overrides,
  };
}

const run = async (command: string, t: AgentTask, signal = new AbortController().signal) => {
  const events: AgentEvent[] = [];
  const result = await new ClaudeCodeAdapter({ command }).execute(t, (e) => events.push(e), signal);
  return { result, events };
};

describe('ClaudeCodeAdapter', () => {
  it('runs in the worktree, maps stream-json to neutral events and parses the report', async () => {
    const work = mkdtempSync(join(dir, 'work-'));
    const command = fakeClaude(
      'claude-ok',
      `fs.writeFileSync('prompt.txt', prompt);
fs.writeFileSync('CONTRIBUTING.md', '# Contributing\\n');
out({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', tools: ['Read','Write'] });
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Creating CONTRIBUTING.md' }] } });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'CONTRIBUTING.md' } }] } });
out({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.042,
      result: 'Done.\\n\\n## Summary\\nAdded a CONTRIBUTING guide.\\n\\n## Manual QA steps\\n- Open CONTRIBUTING.md\\n- Check the headings\\n',
      permission_denials: [{ tool_name: 'Bash' }] });`,
    );
    const { result, events } = await run(
      command,
      task(work, { instructions: 'TASK INSTRUCTIONS' }),
    );
    expect(result).toMatchObject({
      status: 'completed',
      summary: 'Added a CONTRIBUTING guide.',
      qaSteps: ['Open CONTRIBUTING.md', 'Check the headings'],
      usage: { costUsd: 0.042, turns: 3 },
    });
    expect(events.map((e) => e.type)).toEqual(['started', 'progress', 'tool_call', 'log']);
    expect(events[2]).toMatchObject({
      message: 'Write CONTRIBUTING.md',
      data: { tool: 'Write', target: 'CONTRIBUTING.md' },
    });
    expect(events[3]).toMatchObject({
      data: { level: 'warn' },
      message: expect.stringMatching(/denied/),
    });
    expect(existsSync(join(work, 'CONTRIBUTING.md'))).toBe(true); // ran in the worktree
    expect(readFileSync(join(work, 'prompt.txt'), 'utf8')).toBe('TASK INSTRUCTIONS'); // prompt via stdin
  });

  it('passes the isolation flags and denies pushing; prompt is not on the command line', () => {
    const args = new ClaudeCodeAdapter().buildArgs(task('/w'));
    expect(args).toEqual(
      expect.arrayContaining(['-p', '--restricted', '--no-session-persistence']),
    );
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Edit,Write,Glob,Grep'); // no shell without checks
    expect(args[args.indexOf('--disallowedTools') + 1]).toContain('Bash(git push:*)');
    expect(args.join(' ')).not.toContain('Do the thing.');

    const withChecks = new ClaudeCodeAdapter().buildArgs(
      task('/w', { allowedCommands: ['npm test'] }),
    );
    expect(withChecks[withChecks.indexOf('--tools') + 1]).toContain('Bash');
    expect(withChecks[withChecks.indexOf('--allowedTools') + 1]).toContain('Bash(npm test)');
  });

  it('gives the agent no Workbox secrets in its environment', async () => {
    const work = mkdtempSync(join(dir, 'work-'));
    process.env.WORKBOX_MASTER_KEY = 'master-key-must-not-leak';
    process.env.DB_PASSWORD = 'db-password-must-not-leak';
    process.env.GITHUB_TOKEN = 'ghp_must_not_leak';
    const command = fakeClaude(
      'claude-env',
      `fs.writeFileSync('env.json', JSON.stringify(process.env));
out({ type: 'result', subtype: 'success', is_error: false, result: '## Summary\\nok' });`,
    );
    try {
      await run(command, task(work));
    } finally {
      delete process.env.WORKBOX_MASTER_KEY;
      delete process.env.DB_PASSWORD;
      delete process.env.GITHUB_TOKEN;
    }
    const env = readFileSync(join(work, 'env.json'), 'utf8');
    for (const secret of [
      'master-key-must-not-leak',
      'db-password-must-not-leak',
      'ghp_must_not_leak',
    ]) {
      expect(env).not.toContain(secret);
    }
    expect(JSON.parse(env)).toHaveProperty('HOME'); // still finds its own login
  });

  it('reports agent errors and exits without a result as failures', async () => {
    const work = mkdtempSync(join(dir, 'work-'));
    const errored = fakeClaude(
      'claude-err',
      `out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' });`,
    );
    expect((await run(errored, task(work))).result).toMatchObject({
      status: 'failed',
      failureReason: expect.stringMatching(/boom/),
    });

    const crashed = fakeClaude(
      'claude-crash',
      `process.stderr.write('fatal: something broke\\n'); process.exit(3);`,
    );
    expect((await run(crashed, task(work))).result).toMatchObject({
      status: 'failed',
      failureReason: expect.stringMatching(/code 3.*something broke/),
    });
  });

  it('enforces the time limit and kills everything the agent started', async () => {
    const work = mkdtempSync(join(dir, 'work-'));
    const command = fakeClaude(
      'claude-slow',
      `const { spawn } = require('node:child_process');
const child = spawn('sleep', ['300'], { stdio: 'ignore' });
fs.writeFileSync('child.pid', String(child.pid));
out({ type: 'system', subtype: 'init', model: 'm', tools: [] });
setInterval(() => {}, 1000);`,
    );
    const { result } = await run(command, task(work, { timeoutMs: 1_000 }));
    expect(result).toMatchObject({
      status: 'timed_out',
      failureReason: expect.stringMatching(/time limit/),
    });
    const pid = Number(readFileSync(join(work, 'child.pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow(); // the grandchild is gone too
  });

  it('cancels on abort', async () => {
    const work = mkdtempSync(join(dir, 'work-'));
    const command = fakeClaude(
      'claude-wait',
      `out({ type: 'system', subtype: 'init', model: 'm', tools: [] }); setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const { result } = await run(command, task(work), controller.signal);
    expect(result).toMatchObject({ status: 'cancelled', failureReason: 'Run cancelled.' });
  });

  it('reports a missing CLI clearly', async () => {
    const { result } = await run(
      join(dir, 'no-such-claude'),
      task(mkdtempSync(join(dir, 'work-'))),
    );
    expect(result).toMatchObject({
      status: 'failed',
      failureReason: expect.stringMatching(/not found/),
    });
  });
});

describe('instructions and report', () => {
  it('builds runtime-neutral instructions with the rules', () => {
    const text = buildTaskInstructions({
      projectName: 'Demo',
      repositoryPath: 'kost/demo',
      branch: 'workbox/3-add-docs',
      task: {
        number: 3,
        title: 'Add docs',
        description: 'Write docs.',
        acceptanceCriteria: ['README updated'],
      },
      note: 'Please also fix typos',
      checkCommands: [],
    });
    expect(text).toContain('Task #3: Add docs');
    expect(text).toContain('- README updated');
    expect(text).toContain('Please also fix typos');
    expect(text).toMatch(/Do NOT commit, push/);
    expect(text).toContain('## Manual QA steps');
  });

  it('parses summary and QA steps, tolerating formats', () => {
    expect(
      parseAgentReport('blah\n## Summary\nDid X.\n## Manual QA steps\n1. Run it\n2) Look\n* Done'),
    ).toEqual({
      summary: 'Did X.',
      qaSteps: ['Run it', 'Look', 'Done'],
    });
    expect(parseAgentReport('Just text, no sections')).toEqual({
      summary: 'Just text, no sections',
      qaSteps: [],
    });
  });
});

describe('ClaudeCodeAdapter robustness', () => {
  it('reports a CLI that exits before reading the instructions, without crashing (EPIPE)', async () => {
    const command = fakeClaude('claude-exits-fast', `process.exit(2);`);
    // Replace the header's stdin read: this script exits immediately.
    writeFileSync(command, '#!/usr/bin/env node\nprocess.exit(2);\n');
    chmodSync(command, 0o755);
    const huge = 'instructions '.repeat(1_000_000);
    for (let i = 0; i < 3; i++) {
      const { result } = await run(
        command,
        task(mkdtempSync(join(dir, 'work-')), { instructions: huge }),
      );
      expect(result).toMatchObject({
        status: 'failed',
        failureReason: expect.stringMatching(/exited \(code 2\)/),
      });
    }
  });
});
