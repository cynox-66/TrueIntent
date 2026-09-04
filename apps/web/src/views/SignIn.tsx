/**
 * Operator sign-in.
 *
 * The credential is verified by *using* it: the form calls the queue endpoint,
 * and only a 200 admits the operator. A form that accepted any input and then
 * showed a broken console would be worse than one that refuses.
 *
 * The key input is `type="password"` with autocomplete off, is never echoed
 * back after submission, and is held only in React state. It is not stored, not
 * put in the URL, and not logged. The banner says plainly that this is a
 * development credential flow, because it is.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { api, type OperatorCredential } from '../api/client.js';
import { ErrorBlock } from '../components/primitives.js';

export function SignIn({
  onSignedIn,
}: {
  onSignedIn: (credential: OperatorCredential) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (checking) return;
    setError(null);
    setChecking(true);

    const credential: OperatorCredential = { name: name.trim(), key };
    void api.queue(credential).then(
      () => {
        setChecking(false);
        // The key leaves this component and is never rendered again.
        setKey('');
        onSignedIn(credential);
      },
      (cause: unknown) => {
        setChecking(false);
        setError(cause);
      },
    );
  };

  const canSubmit = name.trim().length > 0 && key.length > 0 && !checking;

  return (
    <div className="signin">
      <div className="page-head">
        <div className="page-title">
          <h1>Operator sign-in</h1>
          <p className="page-sub">
            TrueIntent gates payment execution. Reviewing and reconciling releases requires
            operator authority.
          </p>
        </div>
      </div>

      <p className="signin-note">
        <strong>Development credential flow.</strong> The key is held in memory for this page only —
        never stored, never placed in the URL, never shown again after you sign in. Reloading signs
        you out. A real deployment would authenticate the operator server-side so the key never
        reaches the browser.
      </p>

      {error !== null && <ErrorBlock error={error} />}

      <form onSubmit={submit} noValidate>
        <div className="field">
          <label className="field-label" htmlFor="operator-name">
            Operator identity
          </label>
          <input
            id="operator-name"
            className="input"
            value={name}
            onChange={e => setName(e.target.value)}
            autoComplete="off"
            placeholder="operator_dev"
            required
          />
          <p className="field-hint">
            Sent as <code>x-capturelock-operator</code>. The server records this against every
            resolution — attribution comes from this header, never from a request body.
          </p>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="operator-key">
            Operator key
          </label>
          <input
            id="operator-key"
            className="input"
            type="password"
            value={key}
            onChange={e => setKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <p className="field-hint">
            Sent as <code>x-capturelock-operator-key</code> and checked against the running API
            before you are admitted.
          </p>
        </div>

        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
          {checking ? 'Verifying…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
