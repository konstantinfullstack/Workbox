import type { CheckCommand, ChecksDetection, ProjectSummary } from '#shared';
import { useState } from 'react';
import { useChecksActions, useProjectChecks } from '../api/hooks.js';
import { ErrorBanner, Loading } from './Status.js';

/**
 * The project's verification commands (U9): Workbox proposes them from the repository, you confirm
 * or edit them once. Runs need a confirmed configuration, which may be "no automatic checks".
 */
export function ChecksCard({ project }: { project: ProjectSummary }) {
  const checks = useProjectChecks(project.slug);
  const actions = useChecksActions(project.slug);
  const [draft, setDraft] = useState<{
    setup: string;
    commands: CheckCommand[];
    detection: ChecksDetection | null;
  } | null>(null);

  if (!project.repository) return null;
  if (checks.isPending) return <Loading what="checks" />;
  const current = checks.data;

  const startEdit = (detection: ChecksDetection | null) =>
    setDraft({
      setup: detection?.setup ?? current?.setup ?? '',
      commands: detection?.commands ?? current?.commands ?? [],
      detection,
    });

  const save = () => {
    if (!draft) return;
    const commands = draft.commands.filter((c) => c.name.trim() && c.command.trim());
    actions.confirm.mutate(
      {
        setup: draft.setup.trim() || null,
        commands,
        detectedFrom: draft.detection?.detectedFrom ?? current?.detectedFrom ?? [],
      },
      { onSuccess: () => setDraft(null) },
    );
  };

  return (
    <section className="panel" aria-label="Checks">
      <div className="section-header">
        <h2>Checks</h2>
        {!draft && (
          <>
            <button
              type="button"
              className="secondary"
              disabled={actions.detect.isPending}
              onClick={() => actions.detect.mutate(undefined, { onSuccess: (d) => startEdit(d) })}
            >
              {actions.detect.isPending
                ? 'Reading repository…'
                : current?.confirmed
                  ? 'Detect again'
                  : 'Detect from repository'}
            </button>
            {current?.confirmed && (
              <button type="button" className="secondary" onClick={() => startEdit(null)}>
                Edit
              </button>
            )}
          </>
        )}
      </div>
      <ErrorBanner error={actions.detect.error ?? actions.confirm.error ?? checks.error} />

      {draft ? (
        <div className="checks-editor">
          {draft.detection && (
            <p className="muted small">
              {draft.detection.detectedFrom.length
                ? `Proposed from ${draft.detection.detectedFrom.join(', ')}.`
                : 'Nothing detected.'}{' '}
              Review the commands: they run on this machine after every agent run.
            </p>
          )}
          {draft.detection?.notes.map((note) => (
            <p key={note} className="warning-text small">
              {note}
            </p>
          ))}
          <label>
            Setup <span className="muted">(install dependencies; optional)</span>
            <input
              value={draft.setup}
              placeholder="e.g. pnpm install --frozen-lockfile"
              onChange={(e) => setDraft({ ...draft, setup: e.target.value })}
            />
          </label>
          {draft.commands.map((command, index) => (
            <div key={index} className="check-row">
              <input
                aria-label={`Check ${index + 1} name`}
                value={command.name}
                placeholder="name"
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    commands: draft.commands.map((c, i) =>
                      i === index ? { ...c, name: e.target.value } : c,
                    ),
                  })
                }
              />
              <input
                aria-label={`Check ${index + 1} command`}
                className="mono"
                value={command.command}
                placeholder="command"
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    commands: draft.commands.map((c, i) =>
                      i === index ? { ...c, command: e.target.value } : c,
                    ),
                  })
                }
              />
              <button
                type="button"
                className="secondary"
                aria-label={`Remove check ${index + 1}`}
                onClick={() =>
                  setDraft({ ...draft, commands: draft.commands.filter((_, i) => i !== index) })
                }
              >
                ✕
              </button>
            </div>
          ))}
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={draft.commands.length >= 10}
              onClick={() =>
                setDraft({ ...draft, commands: [...draft.commands, { name: '', command: '' }] })
              }
            >
              + Add check
            </button>
          </div>
          <div className="form-actions">
            <button type="button" disabled={actions.confirm.isPending} onClick={save}>
              {draft.commands.length || draft.setup.trim()
                ? 'Confirm checks'
                : 'Confirm: no automatic checks'}
            </button>
            <button type="button" className="secondary" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : current?.confirmed ? (
        current.commands.length === 0 && !current.setup ? (
          <p className="muted">No automatic checks: every run is reviewed manually.</p>
        ) : (
          <ul className="checks-list">
            {current.setup && (
              <li>
                <span className="muted">setup</span> <span className="mono">{current.setup}</span>
              </li>
            )}
            {current.commands.map((c) => (
              <li key={c.name}>
                <span className="muted">{c.name}</span> <span className="mono">{c.command}</span>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="warning-text">
          Not confirmed yet. Detect the commands from the repository and confirm them before the
          first run.
        </p>
      )}
    </section>
  );
}
