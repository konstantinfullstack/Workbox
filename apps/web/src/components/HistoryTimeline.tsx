import type { TaskTransition } from '#shared';
import { STATE_LABELS } from '../labels.js';

export function HistoryTimeline({ items }: { items: TaskTransition[] }) {
  if (items.length === 0) return <p className="muted">No history yet.</p>;
  return (
    <ol className="timeline">
      {[...items].reverse().map((item) => (
        <li key={item.id}>
          <div>
            {item.fromState ? (
              <>
                <strong>{STATE_LABELS[item.fromState]}</strong> →{' '}
                <strong>{STATE_LABELS[item.toState]}</strong>
              </>
            ) : (
              <>
                Created in <strong>{STATE_LABELS[item.toState]}</strong>
              </>
            )}
          </div>
          {item.reason && <div className="timeline-reason">“{item.reason}”</div>}
          <div className="muted small">
            {new Date(item.createdAt).toLocaleString()} · {item.actor}
          </div>
        </li>
      ))}
    </ol>
  );
}
