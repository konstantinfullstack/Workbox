import type { ChecksDetection, CheckCommand } from '#shared';

/** Files read from the repository to propose check commands. */
export const CHECK_DETECTION_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'Makefile',
] as const;

const NODE_SCRIPTS = ['lint', 'typecheck', 'type-check', 'test', 'build'] as const;

/**
 * Proposes setup + check commands from repository files (U9: the user confirms or edits them).
 * Pure function: `files` maps a path to its content, or null/undefined when absent.
 */
export function detectChecks(files: Partial<Record<string, string | null>>): ChecksDetection {
  const has = (path: string) => typeof files[path] === 'string';
  const commands: CheckCommand[] = [];
  const detectedFrom: string[] = [];
  const notes: string[] = [];
  let setup: string | null = null;

  if (has('package.json')) {
    detectedFrom.push('package.json');
    let pkg: { scripts?: Record<string, string>; packageManager?: string } = {};
    try {
      pkg = JSON.parse(files['package.json']!) as typeof pkg;
    } catch {
      notes.push('package.json could not be parsed; add commands manually.');
    }
    const manager = pkg.packageManager?.startsWith('pnpm')
      ? 'pnpm'
      : pkg.packageManager?.startsWith('yarn')
        ? 'yarn'
        : has('pnpm-lock.yaml')
          ? 'pnpm'
          : has('yarn.lock')
            ? 'yarn'
            : has('bun.lock') || has('bun.lockb')
              ? 'bun'
              : 'npm';
    const lock = {
      pnpm: 'pnpm-lock.yaml',
      yarn: 'yarn.lock',
      bun: 'bun.lock',
      npm: 'package-lock.json',
    }[manager];
    if (has(lock)) detectedFrom.push(lock);
    setup = {
      pnpm: has('pnpm-lock.yaml') ? 'pnpm install --frozen-lockfile' : 'pnpm install',
      yarn: has('yarn.lock') ? 'yarn install --frozen-lockfile' : 'yarn install',
      bun: 'bun install',
      npm: has('package-lock.json') ? 'npm ci' : 'npm install',
    }[manager];
    const scripts = pkg.scripts ?? {};
    for (const script of NODE_SCRIPTS) {
      if (!scripts[script]) continue;
      if (script === 'type-check' && scripts.typecheck) continue;
      const command =
        manager === 'npm'
          ? script === 'test'
            ? 'npm test'
            : `npm run ${script}`
          : `${manager} ${script === 'test' ? 'test' : `run ${script}`}`;
      commands.push({ name: script === 'type-check' ? 'typecheck' : script, command });
      if (script === 'test' && /\b(watch|--watch)\b/.test(scripts.test ?? '')) {
        notes.push(
          'The test script looks like watch mode; checks run with CI=true, but you may want a one-shot command.',
        );
      }
    }
    if (commands.length === 0) notes.push('package.json has no lint/typecheck/test/build scripts.');
  } else if (has('pyproject.toml') || has('requirements.txt')) {
    const pyproject = files['pyproject.toml'] ?? '';
    if (has('pyproject.toml')) detectedFrom.push('pyproject.toml');
    if (has('requirements.txt')) detectedFrom.push('requirements.txt');
    setup = has('requirements.txt') ? 'pip install -r requirements.txt' : 'pip install -e .';
    if (/\bruff\b/.test(pyproject)) commands.push({ name: 'lint', command: 'ruff check .' });
    if (/\bmypy\b/.test(pyproject)) commands.push({ name: 'typecheck', command: 'mypy .' });
    if (/\bpytest\b/.test(pyproject) || /\bpytest\b/.test(files['requirements.txt'] ?? '')) {
      commands.push({ name: 'test', command: 'pytest' });
    }
  } else if (has('go.mod')) {
    detectedFrom.push('go.mod');
    commands.push(
      { name: 'build', command: 'go build ./...' },
      { name: 'test', command: 'go test ./...' },
    );
  } else if (has('Cargo.toml')) {
    detectedFrom.push('Cargo.toml');
    commands.push(
      { name: 'build', command: 'cargo build' },
      { name: 'test', command: 'cargo test' },
    );
  }

  if (has('Makefile')) {
    const targets = new Set(
      [...files['Makefile']!.matchAll(/^([a-zA-Z0-9_-]+):/gm)].map((m) => m[1]),
    );
    for (const target of ['lint', 'test'] as const) {
      if (targets.has(target) && !commands.some((c) => c.name === target)) {
        commands.push({ name: target, command: `make ${target}` });
        if (!detectedFrom.includes('Makefile')) detectedFrom.push('Makefile');
      }
    }
  }

  if (detectedFrom.length === 0)
    notes.push('No known project files found; add commands manually or confirm "no checks".');
  return { setup, commands, detectedFrom, notes };
}
