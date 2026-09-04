/**
 * One release: what the agent asked for, what TrueIntent decided, and what an
 * operator may now do about it.
 *
 * Two rules govern the actions.
 *
 * **An action is offered only when the current server state permits it.** The
 * buttons are derived from the release state the API just returned, not from a
 * local guess and not from what the operator did a moment ago. A resolve button
 * on a release that is no longer paused would be an invitation to a 409.
 *
 * **There is no optimistic state.** After an action the release is re-fetched
 * and the outcome shown is the server's. Painting a success and reconciling
 * later is how a console ends up disagreeing with the ledger about whether
 * money moved.
 */

import { useCallback, useState, type ReactNode } from 'react';
import type {
  AuthorizationView,
  ReconciliationResponse,
  ReleaseDetailResponse,
  ReviewResolution,
} from '../api/types.js';
import { api, type OperatorCredential } from '../api/client.js';
import { useAsync } from '../lib/useAsync.js';
import { formatAbsolute, formatMoney, formatRelative, humanizeState } from '../lib/format.js';
import { hrefFor } from '../lib/router.js';
import { GateStory, verdictTone } from './GateStory.js';
import { AgentContextPanel } from './AgentContext.js';
import {
  ErrorBlock,
  Field,
  Panel,
  Pill,
  RawJson,
  ReasonList,
  Skeleton,
  VerdictBanner,
  describeError,
  type Tone,
} from '../components/primitives.js';

/**
 * Terminal states a release reaches without any money having moved.
 *
 * Used only for wording. `moneyHasMoved` on the server remains the authority
 * for the fact itself; this list exists so the console does not tell an
 * operator there is "nothing to do" on a refusal without also saying that the
 * refusal is the outcome, not an omission.
 */
const TERMINAL_WITHOUT_MONEY = new Set(['DENIED', 'ABORTED', 'FAILED', 'CAPTURE_REJECTED']);

/** States in which each operator action is legal, taken from the state machine. */
const RECONCILABLE = new Set([
  'ORDER_IN_FLIGHT',
  'ORDER_INDETERMINATE',
  'CAPTURE_IN_FLIGHT',
  'CAPTURE_INDETERMINATE',
]);

function stateTone(state: string): Tone {
  if (state === 'CAPTURED' || state === 'SETTLED') return 'safe';
  if (state === 'PAUSED') return 'attention';
  if (RECONCILABLE.has(state)) return 'danger';
  if (state === 'DENIED' || state === 'FAILED' || state === 'CAPTURE_REJECTED') return 'danger';
  return 'neutral';
}

export function ReleaseDetail({
  releaseId,
  operator,
}: {
  releaseId: string;
  operator: OperatorCredential;
}): ReactNode {
  const { state, reload, refreshing } = useAsync<ReleaseDetailResponse>(
    signal => api.release(releaseId, signal),
    [releaseId],
  );

  return (
    <>
      <nav className="breadcrumb">
        <a href={hrefFor({ name: 'queue' })}>Queue</a> / <span className="mono">{releaseId}</span>
      </nav>

      {state.status === 'loading' && <Skeleton rows={4} />}
      {state.status === 'failed' && <ErrorBlock error={state.error} onRetry={reload} />}
      {state.status === 'ready' && (
        <Loaded detail={state.data} operator={operator} reload={reload} refreshing={refreshing} />
      )}
    </>
  );
}

function Loaded({
  detail,
  operator,
  reload,
  refreshing,
}: {
  detail: ReleaseDetailResponse;
  operator: OperatorCredential;
  reload: () => void;
  refreshing: boolean;
}): ReactNode {
  const { release, evaluations } = detail;
  const paused = release.state === 'PAUSED';
  const reconcilable = RECONCILABLE.has(release.state);

  return (
    <>
      <div className="page-head">
        <div className="page-title">
          <h1>{humanizeState(release.state)}</h1>
          <p className="page-sub">
            {formatMoney(release.amount)} · release{' '}
            <span className="mono">{release.releaseId}</span>
          </p>
        </div>
        <button type="button" className="btn" onClick={reload} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <GateStory evaluations={evaluations} amount={release.amount} state={release.state} />

      {paused && (
        <div style={{ marginBottom: '1rem' }}>
          <VerdictBanner tone="attention" glyph="⏸" title="PAUSED — AWAITING A HUMAN DECISION">
            The kernel refused to complete this release on its own and no money has moved. It stays
            here until an operator approves or rejects it.
          </VerdictBanner>
        </div>
      )}
      {reconcilable && (
        <div style={{ marginBottom: '1rem' }}>
          <VerdictBanner tone="danger" glyph="⚠" title="INDETERMINATE — PROVIDER TRUTH UNKNOWN">
            A provider call may already have taken effect. Do not retry it. Reconciliation asks the
            provider what actually happened and adopts that answer.
          </VerdictBanner>
        </div>
      )}

      <div className="stack">
        <Panel title="Release status">
          <dl className="fields">
            <Field label="State">
              <Pill tone={stateTone(release.state)}>{release.state}</Pill>
            </Field>
            <Field label="Amount">{formatMoney(release.amount)}</Field>
            <Field label="Attempts">{release.attemptCount}</Field>
            <Field label="Last reason codes">
              <ReasonList codes={release.lastReasonCodes} />
            </Field>
            <Field label="Provider order">
              <span className="mono">{release.providerOrderId ?? '—'}</span>
            </Field>
            <Field label="Provider payment">
              <span className="mono">{release.providerPaymentId ?? '—'}</span>
            </Field>
            <Field label="In flight since">
              <span className="mono">{formatAbsolute(release.inFlightSince)}</span>
            </Field>
            <Field label="Created">
              <span className="mono" title={formatAbsolute(release.createdAt)}>
                {formatRelative(release.createdAt)}
              </span>
            </Field>
            <Field label="Updated">
              <span className="mono" title={formatAbsolute(release.updatedAt)}>
                {formatRelative(release.updatedAt)}
              </span>
            </Field>
            <Field label="Authorization">
              <a href={hrefFor({ name: 'evidence', chainId: release.authorizationId })}>
                <span className="mono">{release.authorizationId}</span>
              </a>
            </Field>
          </dl>
        </Panel>

        <OperatorActions
          detail={detail}
          operator={operator}
          onCompleted={reload}
          paused={paused}
          reconcilable={reconcilable}
        />

        {/*
          Placed above the mandate, because it answers the earlier question.
          "Why did an agent think the user wanted this?" comes before "what was
          it authorized to spend?" when an operator is deciding whether to
          approve.
        */}
        <AgentContextPanel releaseId={release.releaseId} operator={operator} />

        <AuthorizationPanel authorizationId={release.authorizationId} />

        <Panel title="Gate evaluations" flush>
          {evaluations.length === 0 ? (
            <p className="muted" style={{ padding: '1rem' }}>
              No evaluations recorded yet.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th scope="col">Gate</th>
                    <th scope="col">Verdict</th>
                    <th scope="col">Reasons</th>
                    <th scope="col">Decision hash</th>
                    <th scope="col">Evaluated</th>
                  </tr>
                </thead>
                <tbody>
                  {evaluations.map(evaluation => (
                    <tr key={evaluation.evaluationId}>
                      <td className="nowrap">{evaluation.gate}</td>
                      <td>
                        <Pill tone={verdictTone(evaluation.verdict)}>{evaluation.verdict}</Pill>
                      </td>
                      <td>
                        <ReasonList codes={evaluation.reasonCodes} />
                      </td>
                      <td className="mono">{evaluation.decisionHash}</td>
                      <td className="mono nowrap" title={formatAbsolute(evaluation.evaluatedAt)}>
                        {formatRelative(evaluation.evaluatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Evidence">
          <p className="page-sub" style={{ marginTop: 0 }}>
            Every decision and provider outcome for this authorization, hash-linked in sequence.
          </p>
          <a
            className="btn btn-primary"
            href={hrefFor({ name: 'evidence', chainId: release.authorizationId })}
          >
            Open evidence chain
          </a>
        </Panel>

        <RawJson label="Release record" value={detail} />
      </div>
    </>
  );
}

/**
 * The two operator actions.
 *
 * Rendered only when the server's current state allows them. When neither
 * applies the panel says why rather than showing disabled buttons, which read
 * as "broken" rather than "not applicable".
 */
function OperatorActions({
  detail,
  operator,
  onCompleted,
  paused,
  reconcilable,
}: {
  detail: ReleaseDetailResponse;
  operator: OperatorCredential;
  onCompleted: () => void;
  paused: boolean;
  reconcilable: boolean;
}): ReactNode {
  if (!paused && !reconcilable) {
    const settled = TERMINAL_WITHOUT_MONEY.has(detail.release.state);
    return (
      <Panel title="Operator actions">
        <p className="muted">
          {settled
            ? 'Nothing to do, and nothing to undo: this release ended without money moving. '
            : 'Nothing to do. '}
          A release in <span className="mono">{detail.release.state}</span> is not waiting on an
          operator — actions appear only when the current state allows them.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="Operator actions">
      {paused && <ResolveReview detail={detail} operator={operator} onCompleted={onCompleted} />}
      {reconcilable && <Reconcile detail={detail} operator={operator} onCompleted={onCompleted} />}
    </Panel>
  );
}

/**
 * Resolving a paused release.
 *
 * Two steps on purpose: choosing a resolution arms it, and a second explicit
 * click commits it. This is the point at which a human authorizes money to move
 * (or not), and it should not be reachable by one stray click.
 *
 * The request body carries the resolution and nothing else — attribution is the
 * `x-capturelock-operator` header the server reads.
 */
function ResolveReview({
  detail,
  operator,
  onCompleted,
}: {
  detail: ReleaseDetailResponse;
  operator: OperatorCredential;
  onCompleted: () => void;
}): ReactNode {
  const [armed, setArmed] = useState<ReviewResolution | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  // The release detail endpoint does not carry the review id, so it is read
  // from the queue — the one place the API exposes it.
  const { state: queueState } = useAsync(
    signal => api.queue(operator, signal),
    [operator, detail.release.releaseId],
  );
  const reviewId =
    queueState.status === 'ready'
      ? (queueState.data.items.find(i => i.releaseId === detail.release.releaseId)?.review
          ?.reviewId ?? null)
      : null;

  const commit = useCallback(() => {
    if (armed === null || reviewId === null || busy) return;
    setBusy(true);
    setError(null);
    void api.resolveReview(reviewId, armed, operator).then(
      result => {
        setBusy(false);
        setArmed(null);
        setOutcome(`Recorded as ${armed}. Server reported: ${result.kind}.`);
        // The server is the source of truth for what happened next.
        onCompleted();
      },
      (cause: unknown) => {
        setBusy(false);
        setError(cause);
      },
    );
  }, [armed, reviewId, busy, operator, onCompleted]);

  if (queueState.status === 'loading') return <Skeleton rows={1} />;

  if (reviewId === null) {
    return (
      <p className="muted">
        This release is paused but no open review is currently listed for it. Refresh — it may have
        just been resolved by another operator.
      </p>
    );
  }

  return (
    <div>
      <h3 style={{ marginBottom: '0.5rem' }}>Resolve review</h3>
      <dl className="fields" style={{ marginBottom: '1rem' }}>
        <Field label="Review">
          <span className="mono">{reviewId}</span>
        </Field>
        <Field label="Release">
          <span className="mono">{detail.release.releaseId}</span>
        </Field>
        <Field label="Amount">{formatMoney(detail.release.amount)}</Field>
        <Field label="Resolved by">
          <strong>{operator.name}</strong>{' '}
          <span className="muted">(from your authenticated header)</span>
        </Field>
      </dl>

      {error !== null && <ErrorBlock error={error} />}
      {outcome !== null && (
        <div style={{ marginBottom: '1rem' }}>
          <VerdictBanner tone="safe" glyph="✓" title="RESOLUTION RECORDED">
            {outcome}
          </VerdictBanner>
        </div>
      )}

      {armed === null ? (
        <div className="actions-row">
          <button type="button" className="btn btn-safe" onClick={() => setArmed('APPROVED')}>
            Approve…
          </button>
          <button type="button" className="btn btn-danger" onClick={() => setArmed('REJECTED')}>
            Reject…
          </button>
        </div>
      ) : (
        <div>
          <p style={{ marginTop: 0 }}>
            {armed === 'APPROVED' ? (
              <>
                Approving re-runs verification against live state — it does not skip the capture
                gate. If reality has moved since the pause, the release can still be refused.
              </>
            ) : (
              <>Rejecting aborts this release permanently. No money will move.</>
            )}
          </p>
          <div className="actions-row">
            <button
              type="button"
              className={armed === 'APPROVED' ? 'btn btn-safe' : 'btn btn-danger'}
              onClick={commit}
              disabled={busy}
            >
              {busy ? 'Submitting…' : `Confirm ${armed.toLowerCase()}`}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setArmed(null)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Reconciliation.
 *
 * `moneyMoved` is the answer an operator came for, so it is rendered as a
 * banner rather than as a field in a table. Both answers are stated explicitly:
 * silence about money not moving is as unhelpful as silence about money moving.
 */
function Reconcile({
  detail,
  operator,
  onCompleted,
}: {
  detail: ReleaseDetailResponse;
  operator: OperatorCredential;
  onCompleted: () => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<ReconciliationResponse | null>(null);

  const run = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void api.reconcile(detail.release.releaseId, operator).then(
      outcome => {
        setBusy(false);
        setResult(outcome);
        onCompleted();
      },
      (cause: unknown) => {
        setBusy(false);
        setError(cause);
      },
    );
  };

  return (
    <div>
      <h3 style={{ marginBottom: '0.5rem' }}>Reconcile with the provider</h3>
      <p style={{ marginTop: 0 }}>
        This asks the provider what it knows and adopts that answer. It is read-only against the
        provider and cannot itself move money — which is exactly why it is safe from an
        indeterminate state, where a retry would not be.
      </p>

      {error !== null && <ErrorBlock error={error} />}

      {result !== null && (
        <div className="stack" style={{ marginBottom: '1rem' }}>
          {result.moneyMoved ? (
            <VerdictBanner tone="danger" glyph="●" title="MONEY MOVED">
              The provider confirms this payment was captured. The release is recorded as{' '}
              <span className="mono">{result.after}</span>. Do not retry it.
            </VerdictBanner>
          ) : (
            <VerdictBanner tone="safe" glyph="○" title="NO MONEY MOVED">
              The provider has no record of a completed capture for this release. It is now{' '}
              <span className="mono">{result.after}</span>.
            </VerdictBanner>
          )}
          <dl className="fields">
            <Field label="Before">
              <Pill>{result.before}</Pill>
            </Field>
            <Field label="After">
              <Pill tone={stateTone(result.after)}>{result.after}</Pill>
            </Field>
            {result.before === result.after && (
              <Field label="Note">
                <span className="muted">
                  Unchanged. The provider could not settle the question yet — this stays
                  indeterminate rather than being forced to a conclusion.
                </span>
              </Field>
            )}
          </dl>
          <RawJson label="Reconciliation outcome" value={result} />
        </div>
      )}

      <button type="button" className="btn btn-primary" onClick={run} disabled={busy}>
        {busy ? 'Asking the provider…' : 'Reconcile now'}
      </button>
    </div>
  );
}

/** The mandate this release spends against. */
function AuthorizationPanel({ authorizationId }: { authorizationId: string }): ReactNode {
  const { state } = useAsync<AuthorizationView>(
    signal => api.authorization(authorizationId, signal),
    [authorizationId],
  );

  return (
    <Panel title="Authorization context">
      {state.status === 'loading' && <Skeleton rows={1} />}
      {state.status === 'failed' && <p className="muted">{describeError(state.error).detail}</p>}
      {state.status === 'ready' && (
        <>
          <dl className="fields">
            <Field label="Authorization">
              <span className="mono">{state.data.authorizationId}</span>
            </Field>
            <Field label="State">
              <Pill>{state.data.state}</Pill>
            </Field>
            <Field label="What the user asked for">{state.data.rawIntent}</Field>
            <Field label="Intent hash">
              <span className="mono">{state.data.intentHash}</span>
            </Field>
            <Field label="Policy hash">
              <span className="mono">{state.data.policyHash}</span>
            </Field>
            <Field label="Consumed by">
              <span className="mono">{state.data.consumedByReleaseId ?? '—'}</span>
            </Field>
          </dl>
          <p className="field-hint" style={{ marginTop: '0.75rem' }}>
            The mandate&rsquo;s constraints are in the raw record below. This endpoint deliberately
            does not expose the user or session identity.
          </p>
          <div style={{ marginTop: '1rem' }}>
            <RawJson label="Authorization record" value={state.data} />
          </div>
        </>
      )}
    </Panel>
  );
}
