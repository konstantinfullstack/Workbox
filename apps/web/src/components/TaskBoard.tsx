import type { Task } from '#shared';
import { Link } from 'react-router';
import { BOARD_COLUMNS, CANCELLED_COLUMN, type BoardColumn } from '../labels.js';
import { PriorityBadge, StateBadge } from './Badges.js';

export function TaskBoard({ tasks, showCancelled }: { tasks: Task[]; showCancelled: boolean }) {
  const columns = showCancelled ? [...BOARD_COLUMNS, CANCELLED_COLUMN] : BOARD_COLUMNS;
  return (
    <div className="board" role="list" aria-label="Task board">
      {columns.map((column) => (
        <Column
          key={column.id}
          column={column}
          tasks={tasks.filter((task) => column.states.includes(task.state))}
        />
      ))}
    </div>
  );
}

function Column({ column, tasks }: { column: BoardColumn; tasks: Task[] }) {
  return (
    <section className="board-column" role="listitem" aria-label={column.title}>
      <h3>
        {column.title} <span className="count">{tasks.length}</span>
      </h3>
      {tasks.length === 0 ? (
        <p className="muted empty">No tasks</p>
      ) : (
        tasks.map((task) => (
          <TaskCard key={task.id} task={task} showState={column.states.length > 1} />
        ))
      )}
    </section>
  );
}

function TaskCard({ task, showState }: { task: Task; showState: boolean }) {
  return (
    <Link to={`/tasks/${task.id}`} className="task-card" data-testid="task-card">
      <div className="task-card-top">
        <span className="task-number">#{task.number}</span>
        <PriorityBadge priority={task.priority} />
        {showState && <StateBadge state={task.state} />}
      </div>
      <div className="task-title">{task.title}</div>
      {/* Execution details arrive with the orchestrator (M4) and Git workflow (M5). */}
      <dl className="task-meta muted">
        <dt>Run</dt>
        <dd>—</dd>
        <dt>Branch</dt>
        <dd>—</dd>
        <dt>PR</dt>
        <dd>—</dd>
      </dl>
    </Link>
  );
}
