import type { TaskPriority, TaskState } from '#shared';
import { describe, expect, it } from 'vitest';
import { pickNextTask, type ContinuationTask } from '../src/domain/index.js';

const task = (
  number: number,
  state: TaskState,
  priority: TaskPriority = 'medium',
  dependsOn: string[] = [],
): ContinuationTask => ({ id: `t${number}`, number, state, priority, dependsOn });

describe('pickNextTask', () => {
  it('returns none when nothing is in backlog or changes requested', () => {
    expect(pickNextTask([task(1, 'done'), task(2, 'ready_for_qa'), task(3, 'planning')])).toEqual({
      kind: 'none',
    });
    expect(pickNextTask([])).toEqual({ kind: 'none' });
  });

  it('prefers requested changes over new backlog work, even of higher priority', () => {
    const pick = pickNextTask([task(1, 'backlog', 'urgent'), task(2, 'changes_requested', 'low')]);
    expect(pick).toMatchObject({ kind: 'task', task: { number: 2 } });
  });

  it('orders by priority, then by number', () => {
    const tasks = [
      task(1, 'backlog', 'low'),
      task(4, 'backlog', 'high'),
      task(3, 'backlog', 'high'),
      task(2, 'backlog', 'medium'),
    ];
    expect(pickNextTask(tasks)).toMatchObject({ kind: 'task', task: { number: 3 } });
  });

  it('skips tasks whose dependencies are not done', () => {
    const tasks = [
      task(1, 'ready_for_qa'),
      task(2, 'backlog', 'urgent', ['t1']),
      task(3, 'backlog', 'low', ['t4']),
      task(4, 'done'),
    ];
    expect(pickNextTask(tasks)).toMatchObject({ kind: 'task', task: { number: 3 } });
  });

  it('reports what the first candidate waits on when every candidate is waiting', () => {
    const tasks = [
      task(1, 'in_progress'),
      task(2, 'backlog', 'high', ['t1']),
      task(3, 'backlog', 'low', ['t2']),
    ];
    const pick = pickNextTask(tasks);
    expect(pick.kind).toBe('waiting_on_dependencies');
    if (pick.kind !== 'waiting_on_dependencies') return;
    expect(pick.task.number).toBe(2);
    expect(pick.waitingOn.map((t) => t.number)).toEqual([1]);
  });

  it('ignores dependencies on tasks it does not know about (e.g. cancelled and filtered out)', () => {
    expect(pickNextTask([task(1, 'backlog', 'medium', ['gone'])])).toMatchObject({
      kind: 'task',
      task: { number: 1 },
    });
  });
});
