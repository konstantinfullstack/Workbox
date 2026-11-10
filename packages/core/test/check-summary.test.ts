import { describe, expect, it } from 'vitest';
import { summarizeCheckOutput } from '../src/domain/index.js';

describe('summarizeCheckOutput', () => {
  it.each([
    [
      'vitest',
      ' Test Files  1 failed | 38 passed (39)\n      Tests  1 failed | 414 passed (415)\n   Start at  22:17:56',
      '414 passed, 1 failed',
    ],
    ['vitest, all passing', '      Tests  6 passed (6)', '6 passed'],
    ['vitest with skips', '      Tests  10 passed | 2 skipped (12)', '10 passed, 2 skipped'],
    [
      'jest',
      'Test Suites: 1 failed, 4 passed, 5 total\nTests:       1 failed, 42 passed, 43 total',
      '42 passed, 1 failed',
    ],
    [
      'pytest',
      '==== 3 passed, 1 failed, 2 warnings in 0.12s ====',
      '3 passed, 1 failed, 2 warnings',
    ],
    ['pytest, one', '============ 1 passed in 0.01s ============', '1 passed'],
    [
      'cargo, summed',
      'test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured\ntest result: ok. 2 passed; 0 failed; 0 ignored',
      '5 passed, 1 skipped',
    ],
    ['mocha', '  42 passing (2s)\n  1 failing\n', '42 passed, 1 failed'],
    ['node --test', '# tests 4\n# pass 3\n# fail 1\n# skipped 0', '3 passed, 1 failed'],
    [
      'go test',
      'ok  \texample.com/a\t0.01s\nFAIL\texample.com/b\t0.02s\nok  \texample.com/c\t0.01s',
      '2 packages passed, 1 packages failed',
    ],
    [
      'eslint',
      '/src/a.ts\n  1:1  error  x\n\n✖ 4 problems (3 errors, 1 warning)',
      '3 errors, 1 warning',
    ],
    ['tsc', 'src/a.ts(1,1): error TS2322: nope\n\nFound 1 error in src/a.ts:1', '1 error'],
    ['tsc, many', 'Found 3 errors in 2 files.', '3 errors'],
    ['colours', '\u001b[32m      Tests  \u001b[1m6 passed\u001b[22m (6)\u001b[39m', '6 passed'],
  ])('%s', (_name, output, expected) => {
    expect(summarizeCheckOutput(output)).toBe(expected);
  });

  it('returns null when nothing is recognised', () => {
    expect(summarizeCheckOutput('')).toBeNull();
    expect(summarizeCheckOutput('Done in 2.3s')).toBeNull();
  });
});
