import { TASK_STATES_REQUIRING_REASON, type Task, type TaskState } from '#shared';
import { useState, type FormEvent } from 'react';
import { useTransitionTask } from '../api/hooks.js';
import { STATE_LABELS, TRANSITION_ACTIONS } from '../labels.js';
import { ErrorBanner } from './Status.js';

const needsReason = (state: TaskState) =>
  (TASK_STATES_REQUIRING_REASON as readonly TaskState[]).includes(state);

/**
 * One button per transition the backend allows. Nothing is hard-coded here: the state machine
 * lives on the server, which returns `allowedTransitions`.
 */
export function TransitionControls({ task, onReload }: { task: Task; onReload: () => void }) {
  const mutation = useTransitionTask(task.id);
  const [pending, setPending] = useState<TaskState | null>(null);
  const [reason, setReason] = useState('');

  if (task.allowedTransitions.length === 0) {
    return (
      <p className="muted">{STATE_LABELS[task.state]} is a final state. No further actions.</p>
    );
  }

  const send = (to: TaskState, why?: string) =>
    mutation.mutate(
      { to, expectedVersion: task.version, ...(why ? { reason: why } : {}) },
      {
        onSuccess: () => {
          setPending(null);
          setReason('');
        },
      },
    );

  const choose = (to: TaskState) => {
    mutation.reset();
    if (needsReason(to)) {
      setPending(to);
      setReason('');
    } else {
      send(to);
    }
  };

  const submitReason = (event: FormEvent) => {
    event.preventDefault();
    if (pending && reason.trim()) send(pending, reason.trim());
  };

  return (
    <div className="transitions">
      <ErrorBanner error={mutation.error} onReload={onReload} />
      <div className="transition-buttons">
        {task.allowedTransitions.map((to) => (
          <button
            key={to}
            type="button"
            className={to === 'cancelled' || to === 'blocked' ? 'secondary' : ''}
            disabled={mutation.isPending}
            aria-pressed={pending === to}
            onClick={() => choose(to)}
          >
            {TRANSITION_ACTIONS[to]}
          </button>
        ))}
      </div>
      {pending && (
        <form className="reason-form" onSubmit={submitReason}>
          <label>
            Reason for “{STATE_LABELS[pending]}” <span className="muted">(required)</span>
            <textarea
              rows={2}
              autoFocus
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <button type="submit" disabled={!reason.trim() || mutation.isPending}>
              Confirm
            </button>
            <button type="button" className="secondary" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
