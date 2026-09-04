/**
 * Shared presentational pieces.
 *
 * The rule running through all of them: status is never carried by colour
 * alone. Every pill has a text label, every banner has a title, and the two
 * queue categories differ in wording and glyph as well as hue — so the console
 * stays readable to someone who cannot distinguish amber from red, and on a
 * projector that washes both out.
 */

import { useState, type ReactNode } from 'react';
import type { ExplainedReason } from '../lib/reason-codes.js';
import { explainReasons } from '../lib/reason-codes.js';
import { ApiError, NetworkError } from '../api/client.js';

export type Tone = 'neutral' | 'attention' | 'danger' | 'safe';

export function Pill({
  tone = 'neutral',
  glyph,
  children,
}: {
  tone?: Tone;
  glyph?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <span className={`pill${tone === 'neutral' ? '' : ` pill-${tone}`}`}>
      {glyph !== undefined && (
        <span className="glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
      {children}
    </span>
  );
}

export function Panel({
  title,
  actions,
  flush = false,
  children,
}: {
  title: string;
  actions?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{title}</h2>
        <div className="topbar-spacer" />
        {actions}
      </header>
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function Mono({ children }: { children: ReactNode }): ReactNode {
  return <span className="mono">{children}</span>;
}

/**
 * A verdict banner.
 *
 * Used for the handful of conclusions that must be legible in a second:
 * chain validity, replay reproduction, and whether reconciliation moved money.
 */
export function VerdictBanner({
  tone,
  glyph,
  title,
  children,
}: {
  tone: Exclude<Tone, 'neutral'>;
  glyph: string;
  title: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className={`verdict-banner is-${tone}`} role="status">
      <span className="glyph" aria-hidden="true">
        {glyph}
      </span>
      <div>
        <div className="verdict-title">{title}</div>
        {children !== undefined && <p className="verdict-note">{children}</p>}
      </div>
    </div>
  );
}

/**
 * Reason codes with the kernel's own descriptions.
 *
 * The raw code is always shown. The description underneath comes from the
 * kernel's table; an unrecognised code says so rather than being given invented
 * prose.
 */
export function ReasonList({ codes }: { codes: readonly string[] }): ReactNode {
  if (codes.length === 0) return <p className="muted">No reason codes recorded.</p>;
  return (
    <ul className="reason-list">
      {explainReasons(codes).map((reason: ExplainedReason, index) => (
        <li className="reason" key={`${reason.code}-${String(index)}`}>
          <span className="reason-code">{reason.code}</span>
          {reason.unknown ? (
            <span className="reason-unknown">
              Not in the kernel&rsquo;s reason vocabulary — shown exactly as received.
            </span>
          ) : (
            <span className="reason-desc">{reason.description}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }): ReactNode {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  return (
    <div className="state-block">
      <h2>{title}</h2>
      <p>{children}</p>
      {actions !== undefined && <div className="actions-row">{actions}</div>}
    </div>
  );
}

/**
 * Turns a thrown value into something an operator can act on.
 *
 * The distinctions that matter operationally: the API is unreachable, the
 * credential was refused, the thing does not exist, or the server said no for
 * a specific reason. An unrecognised throw is reported as unexpected rather
 * than smoothed into a generic message — a console that renders every failure
 * identically teaches operators to ignore failures.
 */
export function describeError(error: unknown): { title: string; detail: string } {
  if (error instanceof NetworkError) {
    return {
      title: 'The API is unreachable',
      detail:
        'No response from the TrueIntent API. Check that it is running and that the console is pointed at it.',
    };
  }
  if (error instanceof ApiError) {
    if (error.isAuthFailure) {
      return {
        title: 'Operator authority refused',
        detail: `The API rejected this credential (${String(error.status)} ${error.code}). Sign in again with a valid operator key.`,
      };
    }
    if (error.isNotFound) {
      return { title: 'Not found', detail: `${error.code}: ${error.message}` };
    }
    return {
      title: `Request failed (${String(error.status)})`,
      detail: `${error.code}: ${error.message}`,
    };
  }
  return {
    title: 'Unexpected error',
    detail: error instanceof Error ? error.message : String(error),
  };
}

export function ErrorBlock({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}): ReactNode {
  const { title, detail } = describeError(error);
  return (
    <div className="error-block" role="alert">
      <div className="error-title">{title}</div>
      <div className="error-detail">{detail}</div>
      {onRetry !== undefined && (
        <div className="actions-row" style={{ marginTop: '0.75rem' }}>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The raw record behind a rendered view.
 *
 * Collapsed by default so the human-readable view stays primary, and clearly
 * labelled as the raw API response so nobody mistakes it for something the
 * console composed. It prints exactly what the API returned: if a field ought
 * to have been redacted, that is a server-side bug and hiding it here would
 * conceal it.
 */
export function RawJson({ label, value }: { label: string; value: unknown }): ReactNode {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(value, null, 2);

  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  };

  return (
    <div className="raw">
      <div className="raw-head">
        <button
          type="button"
          className="btn btn-quiet btn-sm"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'} {label}
        </button>
        <span className="raw-label">raw api response</span>
        <div className="topbar-spacer" />
        {open && (
          <button type="button" className="btn btn-quiet btn-sm" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {open && <pre className="raw-pre">{text}</pre>}
    </div>
  );
}
