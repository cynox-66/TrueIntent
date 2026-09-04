/**
 * The evidence chain.
 *
 * This screen is the product's argument made visible: every decision and
 * provider outcome is recorded in an append-only, hash-linked chain, the chain
 * verifies cryptographically, and a recorded decision can be re-run from its
 * stored context to see whether it still produces the same hash.
 *
 * Nothing here recomputes any of that. Verification comes from
 * `/v1/evidence/chain/:id/verify` and replay from `/v1/evidence/:id`; the
 * console renders the server's answers. A browser-side reimplementation would
 * be a second opinion that could disagree with the ledger, and — since it would
 * be checking data the same server just handed it — would prove nothing extra.
 */

import { useState, type ReactNode } from 'react';
import type {
  ChainVerificationResponse,
  EvidenceDetailResponse,
  EvidenceEnvelope,
  EvidenceTimelineResponse,
} from '../api/types.js';
import { api } from '../api/client.js';
import { useAsync } from '../lib/useAsync.js';
import { formatAbsolute, formatRelative, truncateHash } from '../lib/format.js';
import { hrefFor } from '../lib/router.js';
import {
  EmptyState,
  ErrorBlock,
  Field,
  Panel,
  Pill,
  RawJson,
  Skeleton,
  VerdictBanner,
} from '../components/primitives.js';

export function Evidence({ chainId }: { chainId: string }): ReactNode {
  const timeline = useAsync<EvidenceTimelineResponse>(
    signal => api.evidenceChain(chainId, signal),
    [chainId],
  );

  return (
    <>
      <nav className="breadcrumb">
        <a href={hrefFor({ name: 'queue' })}>Queue</a> / evidence /{' '}
        <span className="mono">{chainId}</span>
      </nav>

      <div className="page-head">
        <div className="page-title">
          <h1>Evidence chain</h1>
          <p className="page-sub">
            Append-only, hash-linked, signed. Each entry commits to its position and to the entry
            before it.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={timeline.reload}
          disabled={timeline.refreshing}
        >
          {timeline.refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <ChainVerification chainId={chainId} />

      {timeline.state.status === 'loading' && <Skeleton rows={4} />}
      {timeline.state.status === 'failed' && (
        <ErrorBlock error={timeline.state.error} onRetry={timeline.reload} />
      )}
      {timeline.state.status === 'ready' && timeline.state.data.envelopes.length === 0 && (
        <EmptyState title="No evidence recorded">
          This authorization has not produced any evidence envelopes yet. That is a valid state, not
          an error — a chain begins at its first decision.
        </EmptyState>
      )}
      {timeline.state.status === 'ready' && timeline.state.data.envelopes.length > 0 && (
        <Timeline data={timeline.state.data} />
      )}
    </>
  );
}

function Timeline({ data }: { data: EvidenceTimelineResponse }): ReactNode {
  return (
    <>
      <Panel title={`Timeline — ${String(data.envelopes.length)} entries`}>
        <ol className="timeline">
          {data.envelopes.map((envelope, index) => (
            <TimelineEntry
              key={envelope.envelopeId}
              envelope={envelope}
              isLast={index === data.envelopes.length - 1}
            />
          ))}
        </ol>
      </Panel>
      <RawJson label="Evidence timeline" value={data} />
    </>
  );
}

/**
 * "Is this chain cryptographically valid?", answered above the fold.
 *
 * An invalid chain is the most serious thing this console can report, so it
 * gets the strongest treatment on the page and names the defects rather than
 * leaving them in a JSON blob.
 */
function ChainVerification({ chainId }: { chainId: string }): ReactNode {
  const { state, reload, refreshing } = useAsync<ChainVerificationResponse>(
    signal => api.verifyChain(chainId, signal),
    [chainId],
  );

  return (
    <div style={{ marginBottom: '1rem' }}>
      {state.status === 'loading' && <Skeleton rows={1} />}
      {state.status === 'failed' && <ErrorBlock error={state.error} onRetry={reload} />}
      {state.status === 'ready' && (
        <div className="stack">
          {state.data.valid ? (
            <VerdictBanner tone="safe" glyph="✓" title="CHAIN VERIFIED">
              All {state.data.verifiedCount} envelopes verify: every signature checks against the
              ledger&rsquo;s public key, and each entry&rsquo;s hash commits to the one before it.
              Nothing has been inserted, removed or reordered.
            </VerdictBanner>
          ) : (
            <VerdictBanner tone="danger" glyph="✕" title="CHAIN VERIFICATION FAILED">
              The evidence chain for this authorization does not verify. Treat the records below as
              untrustworthy until this is explained.
            </VerdictBanner>
          )}

          <Panel
            title="Verification detail"
            actions={
              <button type="button" className="btn btn-sm" onClick={reload} disabled={refreshing}>
                {refreshing ? 'Re-verifying…' : 'Re-verify'}
              </button>
            }
          >
            <dl className="fields">
              <Field label="Envelopes verified">{state.data.verifiedCount}</Field>
              <Field label="Head chain hash">
                <span className="mono">{state.data.headChainHash ?? '—'}</span>
              </Field>
              <Field label="Defects">
                {state.data.defects.length === 0 ? (
                  <span className="muted">None</span>
                ) : (
                  <ul className="reason-list">
                    {state.data.defects.map((defect, i) => (
                      <li className="reason" key={i}>
                        <span className="reason-code">
                          {typeof defect === 'string' ? defect : JSON.stringify(defect)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Field>
            </dl>
            <p className="field-hint" style={{ marginTop: '0.75rem' }}>
              Verification runs on the server against the ledger&rsquo;s Ed25519 key. This console
              displays that result; it does not perform its own cryptographic check, and an
              independent auditor should verify signatures against{' '}
              <code>GET /v1/evidence/public-key</code> outside this browser.
            </p>
          </Panel>
        </div>
      )}
    </div>
  );
}

function TimelineEntry({
  envelope,
  isLast,
}: {
  envelope: EvidenceEnvelope;
  isLast: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const gate = readGate(envelope.body);

  return (
    <li className="timeline-entry">
      <div className="timeline-rail" aria-hidden="true">
        <span className="timeline-seq">{String(envelope.sequence).padStart(2, '0')}</span>
        {!isLast && <span className="timeline-link" />}
      </div>
      <div className="timeline-body">
        <button
          type="button"
          className="timeline-card"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
        >
          <span className="timeline-top">
            <span className="timeline-kind">{envelope.kind}</span>
            {gate !== null && <Pill>{gate}</Pill>}
            <span className="timeline-when" title={formatAbsolute(envelope.recordedAt)}>
              {formatRelative(envelope.recordedAt)}
            </span>
          </span>
          <span className="timeline-hashes">
            <span>prev</span>
            <span>{truncateHash(envelope.prevChainHash)}</span>
            <span>hash</span>
            <span>{truncateHash(envelope.chainHash)}</span>
          </span>
        </button>
        {open && <EnvelopeDetail envelopeId={envelope.envelopeId} envelope={envelope} />}
      </div>
    </li>
  );
}

/** Pulls the gate label out of a decision body without asserting a shape. */
function readGate(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const gate = (body as { gate?: unknown }).gate;
  return typeof gate === 'string' ? gate : null;
}

/**
 * One envelope, with the server's replay result.
 *
 * A failed replay is reported as "did not reproduce" and nothing stronger. It
 * means the kernel re-run over the stored context produced a different hash;
 * a changed kernel, a context the current code cannot deserialize, and actual
 * tampering all look identical from here, and calling it tampering would be
 * a conclusion this screen has not earned.
 */
function EnvelopeDetail({
  envelopeId,
  envelope,
}: {
  envelopeId: string;
  envelope: EvidenceEnvelope;
}): ReactNode {
  const { state, reload } = useAsync<EvidenceDetailResponse>(
    signal => api.evidence(envelopeId, signal),
    [envelopeId],
  );

  return (
    <div className="timeline-detail">
      {state.status === 'loading' && <Skeleton rows={1} />}
      {state.status === 'failed' && <ErrorBlock error={state.error} onRetry={reload} />}
      {state.status === 'ready' && (
        <div className="stack">
          <ReplayResult detail={state.data} />
          <dl className="fields">
            <Field label="Envelope">
              <span className="mono">{envelope.envelopeId}</span>
            </Field>
            <Field label="Sequence">{envelope.sequence}</Field>
            <Field label="Recorded">
              <span className="mono">{formatAbsolute(envelope.recordedAt)}</span>
            </Field>
            <Field label="Chain hash">
              <span className="mono">{envelope.chainHash}</span>
            </Field>
            <Field label="Previous">
              <span className="mono">{envelope.prevChainHash}</span>
            </Field>
            <Field label="Signed with">
              <span className="mono">{envelope.publicKeyId}</span>
            </Field>
          </dl>
          <RawJson label="Envelope body" value={state.data.envelope.body} />
        </div>
      )}
    </div>
  );
}

function ReplayResult({ detail }: { detail: EvidenceDetailResponse }): ReactNode {
  const hasDecision = detail.replay.decisionHash !== null;

  // Only decision envelopes carry a replayable context; a provider outcome or a
  // webhook has nothing to re-run, and reporting those as "not reproduced"
  // would be a false alarm.
  if (!hasDecision && !detail.replay.reproduced) {
    return (
      <p className="muted">
        This envelope kind carries no replayable decision context, so there is nothing to reproduce.
      </p>
    );
  }

  return detail.replay.reproduced ? (
    <VerdictBanner tone="safe" glyph="✓" title="DECISION REPRODUCED">
      Re-running the kernel over the stored context produced the same decision hash (
      <span className="mono">{truncateHash(detail.replay.decisionHash ?? '', 10)}</span>). The
      recorded verdict is reproducible, not merely asserted.
    </VerdictBanner>
  ) : (
    <VerdictBanner tone="danger" glyph="✕" title="DECISION DID NOT REPRODUCE">
      Re-running the kernel over the stored context produced{' '}
      {detail.replay.decisionHash === null ? (
        <>no decision hash</>
      ) : (
        <span className="mono">{truncateHash(detail.replay.decisionHash, 10)}</span>
      )}
      , which differs from the recorded value. This does not by itself mean tampering — a changed
      kernel or a context this build cannot deserialize produce the same result. It means the
      recorded decision could not be reproduced here, and needs explaining.
    </VerdictBanner>
  );
}
