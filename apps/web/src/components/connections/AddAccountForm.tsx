import { CODE_HOST_PROVIDERS, CODE_HOSTS, type CodeHostProvider, type Connection } from '#shared';
import { useState, type KeyboardEvent } from 'react';
import { useCreateConnection } from '../../api/hooks.js';
import { ErrorBanner } from '../Status.js';

interface Props {
  onCreated: (connection: Connection) => void;
  onCancel?: () => void;
  defaultProvider?: CodeHostProvider;
}

/**
 * Adds an account by pasting a token. Rendered as a group, not a <form>: it is embedded inside the
 * project form, and nested forms would submit the outer form too.
 * The token goes straight to the API (which verifies it with
 * the provider before storing it encrypted) and is never shown again, not even here.
 */
export function AddAccountForm({ onCreated, onCancel, defaultProvider = 'github' }: Props) {
  const create = useCreateConnection();
  const [provider, setProvider] = useState<CodeHostProvider>(defaultProvider);
  const [selfHosted, setSelfHosted] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const host = CODE_HOSTS[provider];
  const instance = selfHosted && baseUrl.trim() ? baseUrl.trim() : host.defaultBaseUrl;

  const canSubmit =
    !create.isPending && secret.trim() !== '' && (!selfHosted || baseUrl.trim() !== '');
  const submit = () => {
    if (!canSubmit) return;
    create.mutate(
      {
        provider,
        name: name.trim() || (selfHosted ? `${host.label} (${safeHost(instance)})` : host.label),
        ...(selfHosted && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        secret: secret.trim(),
      },
      {
        onSuccess: (connection) => {
          setSecret('');
          onCreated(connection);
        },
        // Never keep a rejected token in the field either.
        onError: () => setSecret(''),
      },
    );
  };

  return (
    // Enter in any field saves the account (and never submits an enclosing form).
    <div
      className="form add-account"
      role="group"
      aria-label="Add account"
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
          event.preventDefault();
          submit();
        }
      }}
    >
      <ErrorBanner error={create.error} />
      <div className="segmented" role="radiogroup" aria-label="Provider">
        {CODE_HOST_PROVIDERS.map((value) => (
          <label key={value} className={`segment ${provider === value ? 'selected' : ''}`}>
            <input
              type="radio"
              name="provider"
              value={value}
              checked={provider === value}
              onChange={() => setProvider(value)}
            />
            {CODE_HOSTS[value].label}
          </label>
        ))}
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={selfHosted}
          onChange={(e) => setSelfHosted(e.target.checked)}
        />
        Self-hosted {host.label} (custom URL)
      </label>
      {selfHosted && (
        <label>
          Instance URL
          <input
            required
            type="url"
            placeholder={
              provider === 'gitlab' ? 'https://gitlab.company.com' : 'https://github.company.com'
            }
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
      )}
      <label>
        Name <span className="muted">(how this account appears in Workbox)</span>
        <input
          maxLength={100}
          placeholder={`${host.label} – personal`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        {host.tokenLabel}
        <input
          required
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={host.tokenPlaceholder}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </label>
      <details className="token-help" open>
        <summary>How to create this token</summary>
        <p>{host.tokenHelp.summary}</p>
        <ol>
          {host.tokenHelp.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <a href={host.tokenHelp.settingsUrl(instance)} target="_blank" rel="noreferrer">
          Open {host.label} token settings ↗
        </a>
      </details>
      <p className="muted small">
        Workbox checks the token with {host.label}, then stores it encrypted. It is never shown
        again and is never given to agents.
      </p>
      <div className="form-actions">
        <button type="button" disabled={!canSubmit} onClick={submit}>
          {create.isPending ? 'Verifying…' : 'Verify and save'}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function safeHost(url: string): string {
  return URL.canParse(url) ? new URL(url).host : url;
}
