import type { TaskPriority, TaskState } from '#shared';
import { PRIORITY_LABELS, STATE_LABELS } from '../labels.js';

export function StateBadge({ state }: { state: TaskState }) {
  return <span className={`badge state-${state}`}>{STATE_LABELS[state]}</span>;
}

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return <span className={`badge priority-${priority}`}>{PRIORITY_LABELS[priority]}</span>;
}
