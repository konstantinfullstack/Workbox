import { ERROR_CODES, TASK_STATES, TASK_STATES_REQUIRING_REASON, type TaskState } from '#shared';
import { DomainError } from './errors.js';

/**
 * Task lifecycle (spec §5). Run, PR, verification and notification states are separate machines
 * and must never be folded into this one.
 *
 * See docs/adr/005-task-state-machine-and-audit.md.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
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

/** Entering these states must be explained, so the history stays meaningful. */
export const REASON_REQUIRED_STATES: ReadonlySet<TaskState> = new Set<TaskState>(
  TASK_STATES_REQUIRING_REASON,
);

export const INITIAL_TASK_STATE: TaskState = 'backlog';

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(
  TASK_STATES.filter((state) => TASK_TRANSITIONS[state].length === 0),
);

export function allowedTransitions(from: TaskState): readonly TaskState[] {
  return TASK_TRANSITIONS[from];
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** Throws a DomainError if moving `from` → `to` is not permitted. */
export function assertTransition(from: TaskState, to: TaskState, reason?: string | null): void {
  if (!canTransition(from, to)) {
    const allowed = TASK_TRANSITIONS[from];
    throw new DomainError(
      ERROR_CODES.invalidTransition,
      `cannot move a task from ${from} to ${to}` +
        (allowed.length > 0 ? ` (allowed: ${allowed.join(', ')})` : ` (${from} is terminal)`),
      { from, to, allowed },
    );
  }
  if (REASON_REQUIRED_STATES.has(to) && !reason?.trim()) {
    throw new DomainError(
      ERROR_CODES.reasonRequired,
      `a reason is required to move a task to ${to}`,
      {
        to,
      },
    );
  }
}
