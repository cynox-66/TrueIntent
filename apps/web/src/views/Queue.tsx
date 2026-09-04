/**
 * The operator queue — what needs a human, and why.
 *
 * Rendered in the order the API returned. The backend orders longest-waiting
 * first with a total tiebreak, and re-sorting here would either duplicate that
 * rule or contradict it.
 *
 * The two categories are distinguished four ways, not one: the wording
 * ("Review required" / "Reconciliation required"), a glyph, the left border
 * weight, and the colour. Colour is the least important of the four.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import type { OperatorQueueItem, OperatorQueueResponse } from '../api/types.js';
import { api, type OperatorCredential } from '../api/client.js';
import { useAsync } from '../lib/useAsync.js';
import { formatAbsolute, formatMoney, formatRelative } from '../lib/format.js';
import { primaryReason } from '../lib/reason-codes.js';
import { hrefFor, navigate } from '../lib/router.js';
import {
  EmptyState,
  ErrorBlock,
  Pill,
  RawJson,
  ReasonList,
  Skeleton,
} from '../components/primitives.js';

const WAITING: Record<
  OperatorQueueItem['waitingOn'],
  { label: string; glyph: string; className: string; explanation: string }
> = {
  REVIEW: {
    label: 'Review required',
    glyph: '⏸',
    className: 'waiting-review',
    explanation:
      'The kernel paused this release and is waiting on a human decision. No money has moved.',
  },
  RECONCILIATION: {
    label: 'Reconciliation required',
    glyph: '⚠',
    className: 'waiting-reconciliation',
    explanation:
      'A provider call may or may not have taken effect. Ask the provider what it knows before doing anything else.',
  },
};

export function Queue({ operator }: { operator: OperatorCredential }): ReactNode {
  const { state, reload, refreshing } = useAsync<OperatorQueueResponse>(
    signal => api.queue(operator, signal),
    [operator],
  );

  return (
    <>
      <div className="page-head">
        <div className="page-title">
          <h1>Operator queue</h1>
          <p className="page-sub">
            Releases the system will not complete on its own. Longest-waiting first.
          </p>
        </div>
        <button type="button" className="btn" onClick={reload} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <Lookup />

      {state.status === 'loading' && <Skeleton rows={3} />}
      {state.status === 'failed' && <ErrorBlock error={state.error} onRetry={reload} />}

      {state.status === 'ready' && state.data.items.length === 0 && (
        <EmptyState
          title="Nothing is waiting"
          actions={
            <button type="button" className="btn" onClick={reload}>
              Refresh
            </button>
          }
        >
          No release is paused for review or stuck in an indeterminate provider state. This is the
          expected steady state — releases that verify cleanly never appear here.
        </EmptyState>
      )}

      {state.status === 'ready' && state.data.items.length > 0 && (
        <>
          <p className="page-sub" style={{ marginBottom: '0.75rem' }}>
            {state.data.count} awaiting attention
            {state.data.count >= state.data.limit && (
              <> — showing the first {state.data.limit}, the queue is capped</>
            )}
          </p>
          <ul className="queue-list">
            {state.data.items.map(item => (
              <QueueRow key={item.releaseId} item={item} />
            ))}
          </ul>
          <div style={{ marginTop: '1rem' }}>
            <RawJson label="Queue response" value={state.data} />
          </div>
        </>
      )}
    </>
  );
}

function QueueRow({ item }: { item: OperatorQueueItem }): ReactNode {
  const kind = WAITING[item.waitingOn];
  // The review's own codes explain a pause more precisely than the release's
  // last codes, so prefer them when there is an open review.
  const codes = item.review?.reasonCodes ?? item.reasonCodes;
  const headline = primaryReason(codes);

  return (
    <li className={`queue-item ${kind.className}`}>
      <div className="queue-status">
        <span className="queue-waiting">
          <span className="glyph" aria-hidden="true">
            {kind.glyph}
          </span>{' '}
          {kind.label}
        </span>
        <Pill>{item.state}</Pill>
        <span className="queue-amount">{formatMoney(item.amount)}</span>
        <span className="queue-ids">
          {item.releaseId}
          <br />
          {item.authorizationId}
        </span>
      </div>

      <div className="queue-reason">
        <p className="page-sub" style={{ marginTop: 0 }}>
          {kind.explanation}
        </p>
        {headline === null ? (
          <p className="muted">No reason codes recorded.</p>
        ) : (
          <ReasonList codes={codes} />
        )}
        {item.review !== null && (
          <p className="field-hint">
            Review <span className="mono">{item.review.reviewId}</span> · {item.review.state} ·
            opened {formatRelative(item.review.createdAt)}
          </p>
        )}
        {item.attemptCount > 0 && (
          <p className="field-hint">
            {item.attemptCount} provider attempt{item.attemptCount === 1 ? '' : 's'}
            {item.providerPaymentId !== null && (
              <>
                {' '}
                · payment <span className="mono">{item.providerPaymentId}</span>
              </>
            )}
          </p>
        )}
      </div>

      <div className="queue-actions">
        <span className="queue-age" title={formatAbsolute(item.updatedAt)}>
          updated {formatRelative(item.updatedAt)}
        </span>
        <a className="btn btn-primary" href={hrefFor({ name: 'release', releaseId: item.releaseId })}>
          Open release
        </a>
        <a
          className="btn btn-sm"
          href={hrefFor({ name: 'evidence', chainId: item.authorizationId })}
        >
          Evidence
        </a>
      </div>
    </li>
  );
}

/**
 * Open a release or an authorization by id.
 *
 * The queue lists only what is *waiting*, which is correct — but it means the
 * releases that best demonstrate the system are the ones it never shows. A
 * transaction the capture gate refused is terminal, needs no operator, and
 * therefore never appears here; without this box the only way to look at one
 * was to hand-edit the URL.
 *
 * Purely navigational: it sets the route and nothing else. The id is already
 * visible on screen and in the API's own URLs, so putting it in the hash
 * reveals nothing new — and the operator credential is never part of a route.
 */
function Lookup(): ReactNode {
  const [value, setValue] = useState('');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const id = value.trim();
    if (id.length === 0) return;
    if (id.startsWith('auth_')) navigate({ name: 'evidence', chainId: id });
    else navigate({ name: 'release', releaseId: id });
    setValue('');
  };

  return (
    <form className="lookup" onSubmit={submit}>
      <label className="lookup-label" htmlFor="lookup-id">
        Open by id
      </label>
      <input
        id="lookup-id"
        className="lookup-input mono"
        value={value}
        onChange={event => setValue(event.target.value)}
        placeholder="rel_… for a release, auth_… for its evidence chain"
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" className="btn" disabled={value.trim().length === 0}>
        Open
      </button>
    </form>
  );
}
