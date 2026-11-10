/**
 * One-line summaries of check output (M5), e.g. "414 passed, 1 failed" or "3 errors, 1 warning".
 * Recognises the usual test runners and linters by their final report line; returns null when
 * nothing is recognised (the check still shows passed/failed and its output).
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

type Counts = Map<string, number>;

/** Display order of counters; anything else follows in the order found. */
const ORDER = ['passed', 'failed', 'errors', 'skipped', 'todo', 'warnings'];

export function summarizeCheckOutput(output: string): string | null {
  const text = output.replace(ANSI, '').replace(/\r/g, '');
  for (const parse of PARSERS) {
    const counts = parse(text);
    if (counts && counts.size > 0) return format(counts);
  }
  return null;
}

const PARSERS: ((text: string) => Counts | null)[] = [
  // Vitest: "      Tests  1 failed | 414 passed (415)"
  (text) => {
    const line = lastMatch(text, /^\s*Tests\s{2,}(.+?)\s+\(\d+\)\s*$/gm);
    return line ? countsFrom(line[1]!.split('|')) : null;
  },
  // Jest: "Tests:       1 failed, 42 passed, 43 total"
  (text) => {
    const line = lastMatch(text, /^Tests:\s+(.+)$/gm);
    return line ? countsFrom(line[1]!.split(',').filter((p) => !/total/.test(p))) : null;
  },
  // pytest: "===== 3 passed, 1 failed, 2 warnings in 0.12s ====="
  (text) => {
    const line = lastMatch(text, /^=+ (.+?) in [\d.]+s(?: \([^)]*\))? =+$/gm);
    return line ? countsFrom(line[1]!.split(',')) : null;
  },
  // Rust: "test result: ok. 3 passed; 0 failed; 1 ignored; ..." (one per test binary: summed)
  (text) => {
    const lines = [...text.matchAll(/^test result: \w+\. (.+)$/gm)];
    if (lines.length === 0) return null;
    const total: Counts = new Map();
    for (const line of lines) {
      for (const [key, value] of countsFrom(line[1]!.split(';'))) {
        total.set(key, (total.get(key) ?? 0) + value);
      }
    }
    return total;
  },
  // Mocha: "  42 passing (2s)" / "  1 failing" / "  3 pending"
  (text) => {
    const counts: Counts = new Map();
    for (const [word, key] of [
      ['passing', 'passed'],
      ['failing', 'failed'],
      ['pending', 'skipped'],
    ] as const) {
      const line = lastMatch(text, new RegExp(`^\\s*(\\d+) ${word}\\b`, 'gm'));
      if (line) counts.set(key, Number(line[1]));
    }
    return counts.has('passed') || counts.has('failed') ? counts : null;
  },
  // node --test (TAP): "# pass 3" / "# fail 0" / "# skipped 1"
  (text) => {
    const pass = lastMatch(text, /^# pass (\d+)$/gm);
    const fail = lastMatch(text, /^# fail (\d+)$/gm);
    if (!pass && !fail) return null;
    const counts: Counts = new Map();
    if (pass) counts.set('passed', Number(pass[1]));
    if (fail) counts.set('failed', Number(fail[1]));
    const skipped = lastMatch(text, /^# skipped (\d+)$/gm);
    if (skipped && Number(skipped[1]) > 0) counts.set('skipped', Number(skipped[1]));
    return counts;
  },
  // go test: one "ok  pkg" / "FAIL pkg" line per package
  (text) => {
    const ok = [...text.matchAll(/^ok\s+\S+/gm)].length;
    const failed = [...text.matchAll(/^FAIL\s+\S+/gm)].length;
    if (ok + failed === 0) return null;
    const counts: Counts = new Map([['packages passed', ok]]);
    if (failed > 0) counts.set('packages failed', failed);
    return counts;
  },
  // ESLint: "✖ 4 problems (3 errors, 1 warning)"
  (text) => {
    const line = lastMatch(text, /✖ \d+ problems? \((\d+) errors?, (\d+) warnings?\)/g);
    if (!line) return null;
    return new Map([
      ['errors', Number(line[1])],
      ['warnings', Number(line[2])],
    ]);
  },
  // tsc: "Found 3 errors in 2 files." / "Found 1 error." (also ruff: "Found 2 errors.")
  (text) => {
    const line = lastMatch(text, /^Found (\d+) errors?\b/gm);
    return line ? new Map([['errors', Number(line[1])]]) : null;
  },
];

function lastMatch(text: string, pattern: RegExp): RegExpMatchArray | null {
  let last: RegExpMatchArray | null = null;
  for (const match of text.matchAll(pattern)) last = match;
  return last;
}

/** "3 passed", " 1 failed", "2 warnings" → counters (singular words normalised to plural). */
function countsFrom(parts: string[]): Counts {
  const counts: Counts = new Map();
  for (const part of parts) {
    const match = /^\s*(\d+)\s+([a-z]+(?: [a-z]+)?)\s*$/i.exec(part.trim());
    if (!match) continue;
    const key = normalise(match[2]!.toLowerCase());
    counts.set(key, (counts.get(key) ?? 0) + Number(match[1]));
  }
  return counts;
}

function normalise(word: string): string {
  if (word === 'error') return 'errors';
  if (word === 'warning') return 'warnings';
  if (word === 'ignored') return 'skipped';
  return word;
}

function format(counts: Counts): string {
  const keys = [...counts.keys()].sort((a, b) => rank(a) - rank(b));
  // Zero counters are noise ("0 failed"), unless everything is zero ("0 errors").
  const shown = keys.filter((key) => counts.get(key)! > 0);
  return (shown.length > 0 ? shown : keys.slice(0, 1))
    .map((key) => `${counts.get(key)} ${singular(key, counts.get(key)!)}`)
    .join(', ');
}

function rank(key: string): number {
  const index = ORDER.indexOf(key);
  return index === -1 ? ORDER.length : index;
}

function singular(key: string, n: number): string {
  if (n !== 1) return key;
  if (key === 'errors') return 'error';
  if (key === 'warnings') return 'warning';
  return key;
}
