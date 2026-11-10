import type { TaskPriority, TaskState } from '#shared';

export const STATE_LABELS: Record<TaskState, string> = {
  backlog: 'Backlog',
  planning: 'Planning',
  in_progress: 'In progress',
  verification: 'Verification',
  ready_for_qa: 'Ready for QA',
  done: 'Done',
  blocked: 'Blocked',
  changes_requested: 'Changes requested',
  cancelled: 'Cancelled',
};

/** Verb shown on the button that moves a task into each state. */
export const TRANSITION_ACTIONS: Record<TaskState, string> = {
  backlog: 'Move to backlog',
  planning: 'Start planning',
  in_progress: 'Start work',
  verification: 'Send to verification',
  ready_for_qa: 'Ready for QA',
  done: 'Approve (done)',
  blocked: 'Block',
  changes_requested: 'Request changes',
  cancelled: 'Cancel task',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export interface BoardColumn {
  id: string;
  title: string;
  states: TaskState[];
}

/** Side states (blocked, changes requested) get their own column so they stand out. */
export const BOARD_COLUMNS: BoardColumn[] = [
  { id: 'backlog', title: 'Backlog', states: ['backlog'] },
  { id: 'planning', title: 'Planning', states: ['planning'] },
  { id: 'in_progress', title: 'In progress', states: ['in_progress'] },
  { id: 'attention', title: 'Needs attention', states: ['blocked', 'changes_requested'] },
  { id: 'verification', title: 'Verification', states: ['verification'] },
  { id: 'ready_for_qa', title: 'Ready for QA', states: ['ready_for_qa'] },
  { id: 'done', title: 'Done', states: ['done'] },
];

export const CANCELLED_COLUMN: BoardColumn = {
  id: 'cancelled',
  title: 'Cancelled',
  states: ['cancelled'],
};
