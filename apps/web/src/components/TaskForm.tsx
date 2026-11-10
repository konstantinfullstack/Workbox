import { TASK_PRIORITIES, type CreateTaskInput, type Task, type TaskPriority } from '#shared';
import { useState, type FormEvent } from 'react';
import { PRIORITY_LABELS } from '../labels.js';
import { ErrorBanner } from './Status.js';

interface Props {
  initial?: Task;
  /** Other tasks in the project that can be selected as dependencies. */
  candidates: Task[];
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (values: Required<CreateTaskInput>) => void;
  onCancel?: () => void;
  onReload?: () => void;
}

export function TaskForm({
  initial,
  candidates,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
  onReload,
}: Props) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [criteria, setCriteria] = useState((initial?.acceptanceCriteria ?? []).join('\n'));
  const [priority, setPriority] = useState<TaskPriority>(initial?.priority ?? 'medium');
  const [dependsOn, setDependsOn] = useState<string[]>(initial?.dependsOn ?? []);

  const options = candidates.filter((task) => task.id !== initial?.id);

  const toggleDependency = (id: string) =>
    setDependsOn((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      title: title.trim(),
      description,
      acceptanceCriteria: criteria
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      priority,
      dependsOn,
    });
  };

  return (
    <form className="form" onSubmit={submit}>
      <ErrorBanner error={error} {...(onReload ? { onReload } : {})} />
      <label>
        Title
        <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Description
        <textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        Acceptance criteria <span className="muted">(one per line)</span>
        <textarea rows={4} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
      </label>
      <label>
        Priority
        <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
          {TASK_PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {PRIORITY_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      {options.length > 0 && (
        <fieldset>
          <legend>Depends on</legend>
          <div className="checkbox-list">
            {options.map((task) => (
              <label key={task.id} className="checkbox">
                <input
                  type="checkbox"
                  checked={dependsOn.includes(task.id)}
                  onChange={() => toggleDependency(task.id)}
                />
                #{task.number} {task.title}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="form-actions">
        <button type="submit" disabled={pending || !title.trim()}>
          {pending ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
