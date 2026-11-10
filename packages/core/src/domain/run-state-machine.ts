import { ERROR_CODES, type RunState } from '#shared';
import { DomainError } from './errors.js';

/** Spec §5 run lifecycle. Terminal: completed, failed, cancelled, timed_out. */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ['preparing', 'cancelled', 'failed'],
  preparing: ['running', 'failed', 'cancelled', 'timed_out'],
  running: ['verifying', 'failed', 'cancelled', 'timed_out'],
  verifying: ['completed', 'failed', 'cancelled', 'timed_out'],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function isTerminalRunState(state: RunState): boolean {
  return RUN_TRANSITIONS[state].length === 0;
}

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!canTransitionRun(from, to)) {
    throw new DomainError(ERROR_CODES.runNotActive, `cannot move a run from ${from} to ${to}`, {
      from,
      to,
    });
  }
}

/** Actor recorded when the orchestrator (not a person) changes task or run state. */
export const ORCHESTRATOR_ACTOR = 'system:orchestrator';
