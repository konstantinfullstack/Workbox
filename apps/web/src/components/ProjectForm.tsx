import { slugify, type CreateProjectInput, type ProjectSummary } from '#shared';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ErrorBanner } from './Status.js';

export interface ProjectFormValues {
  name: string;
  slug: string;
  description: string;
  defaultBranch: string;
}

interface Props {
  initial?: ProjectSummary;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (values: CreateProjectInput) => void;
  onCancel?: () => void;
  /** Extra form content (e.g. the repository step on create). */
  children?: ReactNode;
  submitDisabled?: boolean;
}

/** Create/edit form. Slug is only editable on create (it is immutable afterwards). */
export function ProjectForm({
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
  children,
  submitDisabled,
}: Props) {
  const [values, setValues] = useState<ProjectFormValues>({
    name: initial?.name ?? '',
    slug: initial?.slug ?? '',
    description: initial?.description ?? '',
    defaultBranch: initial?.defaultBranch ?? 'main',
  });
  const editing = Boolean(initial);
  const slugPreview = values.slug || slugify(values.name);

  const set = (field: keyof ProjectFormValues) => (value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      name: values.name.trim(),
      ...(!editing && values.slug ? { slug: values.slug } : {}),
      description: values.description,
      defaultBranch: values.defaultBranch.trim() || 'main',
    });
  };

  return (
    <form className="form" onSubmit={submit}>
      <ErrorBanner error={error} />
      <label>
        Name
        <input
          required
          maxLength={100}
          value={values.name}
          onChange={(e) => set('name')(e.target.value)}
        />
      </label>
      {!editing && (
        <label>
          Slug <span className="muted">(optional, used in URLs; cannot be changed later)</span>
          <input
            value={values.slug}
            placeholder={slugPreview || 'my-project'}
            onChange={(e) => set('slug')(e.target.value)}
          />
        </label>
      )}
      <label>
        Default branch
        <input
          value={values.defaultBranch}
          onChange={(e) => set('defaultBranch')(e.target.value)}
        />
      </label>
      <label>
        Description
        <textarea
          rows={3}
          value={values.description}
          onChange={(e) => set('description')(e.target.value)}
        />
      </label>
      {children}
      <div className="form-actions">
        <button type="submit" disabled={pending || Boolean(submitDisabled) || !values.name.trim()}>
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
