import { ERROR_CODES, TASK_STATES, type TaskState } from '#shared';
import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  DomainError,
  REASON_REQUIRED_STATES,
  TERMINAL_TASK_STATES,
} from '../src/domain/index.js';

/** The approved transition table (docs/plans/M2-projects-tasks-admin.md, D1), restated as data. */
const EXPECTED: Record<TaskState, TaskState[]> = {
  backlog: ['planning', 'in_progress', 'blocked', 'cancelled'],
  planning: ['backlog', 'in_progress', 'blocked', 'cancelled'],
  in_progress: ['verification', 'blocked', 'cancelled'],
  verification: ['ready_for_qa', 'in_progress', 'blocked', 'cancelled'],
  ready_for_qa: ['done', 'changes_requested', 'cancelled'],
  changes_requested: ['in_progress', 'blocked', 'cancelled'],
  blocked: ['backlog', 'planning', 'in_progress', 'cancelled'],
  cancelled: ['backlog'],
  done: [],
};

const pairs = TASK_STATES.flatMap((from) => TASK_STATES.map((to) => [from, to] as const));

describe('task state machine', () => {
  it('covers all 81 state pairs', () => {
    expect(pairs).toHaveLength(81);
  });

  it.each(pairs)('%s → %s matches the approved table', (from, to) => {
    expect(canTransition(from, to)).toBe(EXPECTED[from].includes(to));
  });

  it('never allows a self-transition', () => {
    for (const state of TASK_STATES) expect(canTransition(state, state)).toBe(false);
  });

  it('treats done as the only terminal state', () => {
    expect([...TERMINAL_TASK_STATES]).toEqual(['done']);
    expect(allowedTransitions('done')).toEqual([]);
  });

  it('can reach done from backlog via the happy path', () => {
    const path: TaskState[] = ['backlog', 'in_progress', 'verification', 'ready_for_qa', 'done'];
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
  });

  it('allows every non-terminal state to be cancelled', () => {
    for (const state of TASK_STATES) {
      if (state !== 'done' && state !== 'cancelled')
        expect(canTransition(state, 'cancelled')).toBe(true);
    }
  });
});

describe('assertTransition', () => {
  it('passes valid transitions', () => {
    expect(() => assertTransition('backlog', 'planning')).not.toThrow();
  });

  it('rejects invalid transitions with INVALID_TRANSITION and lists allowed targets', () => {
    try {
      assertTransition('done', 'in_progress');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe(ERROR_CODES.invalidTransition);
      expect((error as DomainError).message).toBe(
        'cannot move a task from done to in_progress (done is terminal)',
      );
    }
    expect(() => assertTransition('backlog', 'done')).toThrow(/allowed: planning, in_progress/);
  });

  it.each([...REASON_REQUIRED_STATES])('requires a reason to enter %s', (to) => {
    const from = TASK_STATES.find((state) => canTransition(state, to))!;
    expect(() => assertTransition(from, to)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.reasonRequired }),
    );
    expect(() => assertTransition(from, to, '   ')).toThrow(
      expect.objectContaining({ code: ERROR_CODES.reasonRequired }),
    );
    expect(() => assertTransition(from, to, 'waiting for API access')).not.toThrow();
  });
});
