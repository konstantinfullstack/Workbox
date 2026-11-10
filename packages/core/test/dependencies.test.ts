import { describe, expect, it } from 'vitest';
import { findDependencyCycle } from '../src/domain/index.js';

describe('findDependencyCycle', () => {
  // a → b → c   (a depends on b, b depends on c)
  const graph = new Map([
    ['a', ['b']],
    ['b', ['c']],
    ['c', []],
  ]);

  it('returns null for an acyclic addition', () => {
    expect(findDependencyCycle('d', ['a', 'c'], graph)).toBeNull();
  });

  it('detects a direct cycle', () => {
    expect(findDependencyCycle('b', ['a'], graph)).toEqual(['b', 'a', 'b']);
  });

  it('detects a transitive cycle and returns the path', () => {
    expect(findDependencyCycle('c', ['a'], graph)).toEqual(['c', 'a', 'b', 'c']);
  });

  it('detects a self-dependency', () => {
    expect(findDependencyCycle('a', ['a'], graph)).toEqual(['a', 'a']);
  });

  it('handles diamonds and existing unrelated cycles without looping forever', () => {
    const diamond = new Map([
      ['x', ['y', 'z']],
      ['y', ['w']],
      ['z', ['w']],
      ['p', ['q']],
      ['q', ['p']],
    ]);
    expect(findDependencyCycle('n', ['x', 'p'], diamond)).toBeNull();
    expect(findDependencyCycle('w', ['x'], diamond)).toEqual(['w', 'x', 'z', 'w']);
  });
});
