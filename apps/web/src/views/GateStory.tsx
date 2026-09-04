/**
 * The two gates, side by side, and what moved between them.
 *
 * This is the one screen that has to make TrueIntent's central property
 * legible without commentary:
 *
 *   the purchase was allowed earlier · the world changed ·
 *   the same purchase was re-evaluated · TrueIntent refused to move money
 *
 * Everything rendered here is already in the API's response. Nothing is
 * recomputed, nothing is inferred, and no verdict is decided in the browser:
 * the gate rows are the recorded evaluations in the order the server returned
 * them, and "what changed" is the kernel's own finding details, carried through
 * unaltered. If the console showed a conclusion the ledger did not contain, it
 * would be a second opinion about money — which is the failure mode this whole
 * project exists to prevent.
 */

import type { ReactNode } from 'react';
import type { EvaluationFinding, Money, ReleaseEvaluationSummary } from '../api/types.js';
import { formatAbsolute, formatMoney, formatRelative } from '../lib/format.js';
import { Pill, VerdictBanner, type Tone } from '../components/primitives.js';

export function verdictTone(verdict: string): Tone {
  if (verdict === 'ALLOW') return 'safe';
  if (verdict === 'PAUSE') return 'attention';
  return 'danger';
}

/** The last evaluation recorded at a gate, or null if that gate never ran. */
function lastAt(
  evaluations: readonly ReleaseEvaluationSummary[],
  gate: 'ORDER_CREATION' | 'CAPTURE',
): ReleaseEvaluationSummary | null {
  const matching = evaluations.filter(e => e.gate === gate);
  return matching.length === 0 ? null : matching[matching.length - 1]!;
}

/** The findings that actually blocked something, in the kernel's severity order. */
function blocking(evaluation: ReleaseEvaluationSummary | null): readonly EvaluationFinding[] {
  if (evaluation === null) return [];
  return evaluation.findings.filter(f => f.severity === 'DENY' || f.severity === 'PAUSE');
}

/** Milliseconds between two evaluations, or null when either is missing. */
function elapsedBetween(
  first: ReleaseEvaluationSummary | null,
  second: ReleaseEvaluationSummary | null,
): number | null {
  if (first === null || second === null) return null;
  const a = new Date(first.evaluatedAt).getTime();
  const b = new Date(second.evaluatedAt).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return b - a;
}

function humanizeDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${String(hours)} hour${hours === 1 ? '' : 's'}`;
}

/** `liveUnitPriceMinor` -> `Live unit price`. Presentation only. */
function humanizeKey(key: string): string {
  const withoutMinor = key.replace(/Minor$/, '');
  const spaced = withoutMinor.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Renders one detail value.
 *
 * A key ending in `Minor` holds minor units — a convention the kernel keeps
 * throughout — so it is rendered in the release's own currency. That is a
 * display choice over the kernel's naming, not a recomputation: the integer is
 * shown verbatim in the `title` so the underlying value is never hidden.
 */
function formatDetailValue(
  key: string,
  value: string | number | boolean | null,
  currency: string,
): { text: string; title: string } {
  const raw = value === null ? '—' : String(value);
  if (key.endsWith('Minor') && typeof value === 'number') {
    return { text: formatMoney({ currency, amountMinor: value } as Money), title: raw };
  }
  return { text: raw, title: raw };
}

function FindingCard({
  finding,
  currency,
}: {
  finding: EvaluationFinding;
  currency: string;
}): ReactNode {
  const entries = Object.entries(finding.detail);
  return (
    <li className="story-finding">
      <div className="story-finding-head">
        <Pill tone={finding.severity === 'DENY' ? 'danger' : 'attention'}>{finding.severity}</Pill>
        <span className="reason-code">{finding.code}</span>
        <span className="story-finding-stage">{finding.stage}</span>
      </div>
      <p className="story-finding-message">{finding.message}</p>
      {entries.length > 0 && (
        <dl className="story-detail">
          {entries.map(([key, value]) => {
            const rendered = formatDetailValue(key, value, currency);
            return (
              <div className="story-detail-row" key={key}>
                <dt>{humanizeKey(key)}</dt>
                <dd className="mono" title={rendered.title}>
                  {rendered.text}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </li>
  );
}

function GateColumn({
  label,
  caption,
  evaluation,
}: {
  label: string;
  caption: string;
  evaluation: ReleaseEvaluationSummary | null;
}): ReactNode {
  return (
    <div className="story-gate">
      <div className="story-gate-label">{label}</div>
      <div className="story-gate-caption">{caption}</div>
      {evaluation === null ? (
        <p className="muted" style={{ margin: 0 }}>
          Never ran.
        </p>
      ) : (
        <>
          <Pill tone={verdictTone(evaluation.verdict)}>{evaluation.verdict}</Pill>
          <ul className="story-codes">
            {evaluation.reasonCodes.map(code => (
              <li className="reason-code" key={code}>
                {code}
              </li>
            ))}
          </ul>
          <div className="story-gate-when" title={formatAbsolute(evaluation.evaluatedAt)}>
            {formatRelative(evaluation.evaluatedAt)}
          </div>
          <div className="story-gate-hash mono" title={evaluation.decisionHash}>
            {evaluation.decisionHash.slice(0, 16)}…
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The headline, chosen from what the record says and nothing else.
 *
 * `moneyMoved` is not guessed from the verdict: the release state is the
 * server's own answer to whether funds moved, and it is the only thing allowed
 * to drive the wording here.
 */
function Headline({
  order,
  capture,
  amount,
  state,
}: {
  order: ReleaseEvaluationSummary | null;
  capture: ReleaseEvaluationSummary | null;
  amount: Money;
  state: string;
}): ReactNode {
  const elapsed = elapsedBetween(order, capture);
  const gap = elapsed === null ? null : humanizeDuration(elapsed);
  const money = formatMoney(amount);

  const allowedEarlier = order?.verdict === 'ALLOW';
  const refusedAtCapture = capture !== null && capture.verdict !== 'ALLOW';

  if (allowedEarlier && refusedAtCapture) {
    // The moment the product is named after.
    return (
      <VerdictBanner
        tone="danger"
        glyph="⛔"
        title={
          capture.verdict === 'DENY'
            ? 'TRUEINTENT REFUSED TO MOVE MONEY'
            : 'TRUEINTENT STOPPED SHORT OF MOVING MONEY'
        }
      >
        {money} passed the order gate{gap === null ? '' : ` ${gap} earlier`}, and was re-verified
        against live merchant state at the capture gate. It did not pass the second time. The
        payment provider was never asked to capture, and no money moved.
      </VerdictBanner>
    );
  }

  if (capture?.verdict === 'ALLOW' && (state === 'CAPTURED' || state === 'SETTLED')) {
    return (
      <VerdictBanner tone="safe" glyph="✓" title="VERIFIED AT BOTH GATES, THEN CAPTURED">
        {money} was verified when the order was created and verified again
        {gap === null ? '' : ` ${gap} later`} against a fresh live read, immediately before the
        capture call. Money moved only after the second decision.
      </VerdictBanner>
    );
  }

  if (order !== null && order.verdict !== 'ALLOW') {
    return (
      <VerdictBanner
        tone={order.verdict === 'DENY' ? 'danger' : 'attention'}
        glyph={order.verdict === 'DENY' ? '⛔' : '⏸'}
        title={order.verdict === 'DENY' ? 'REFUSED AT THE ORDER GATE' : 'PAUSED AT THE ORDER GATE'}
      >
        {money} did not pass the first gate, so no payable order was ever created and there is
        nothing for a payer to authorize.
      </VerdictBanner>
    );
  }

  return null;
}

/**
 * The whole story for one release, or nothing at all.
 *
 * Renders nothing when only one gate has run and it allowed: there is no
 * contrast to draw yet, and a panel saying so would be noise on the screen an
 * operator reaches for during an incident.
 */
export function GateStory({
  evaluations,
  amount,
  state,
}: {
  evaluations: readonly ReleaseEvaluationSummary[];
  amount: Money;
  state: string;
}): ReactNode {
  const order = lastAt(evaluations, 'ORDER_CREATION');
  const capture = lastAt(evaluations, 'CAPTURE');
  if (order === null && capture === null) return null;

  const headline = <Headline order={order} capture={capture} amount={amount} state={state} />;
  const elapsed = elapsedBetween(order, capture);

  // What blocked the *later* gate is what changed. A finding present at both
  // gates was not news at the second one, so it is the difference that is worth
  // the operator's eye — but the full list stays below either way.
  const changed = blocking(capture);
  const alreadyKnown = new Set(blocking(order).map(f => f.code));
  const newAtCapture = changed.filter(f => !alreadyKnown.has(f.code));

  return (
    <div className="stack" style={{ marginBottom: '1rem' }}>
      {headline}

      <section className="panel">
        <header className="panel-head">
          <h2>Two gates, one transaction</h2>
        </header>
        <div className="panel-body">
          <div className="story-gates">
            <GateColumn
              label="GATE 1"
              caption="Order creation — binds the terms. No money moves."
              evaluation={order}
            />
            <div className="story-arrow" aria-hidden="true">
              <div className="story-arrow-line" />
              <div className="story-arrow-label">
                {elapsed === null
                  ? 'time passes'
                  : `${humanizeDuration(elapsed)} later · live state re-read`}
              </div>
            </div>
            <GateColumn
              label="GATE 2"
              caption="Capture — money moves here, on ALLOW only."
              evaluation={capture}
            />
          </div>

          {capture === null && (
            <p className="field-hint" style={{ marginTop: '1rem' }}>
              The capture gate has not run for this release yet. It runs against a fresh live
              merchant read, so its answer is not knowable from the first gate&rsquo;s.
            </p>
          )}
        </div>
      </section>

      {changed.length > 0 && (
        <section className="panel">
          <header className="panel-head">
            <h2>
              {newAtCapture.length > 0
                ? 'What changed between the gates'
                : 'Why the capture gate refused'}
            </h2>
          </header>
          <div className="panel-body">
            {newAtCapture.length > 0 && (
              <p className="page-sub" style={{ marginTop: 0 }}>
                These findings were <strong>not</strong> present when the order gate allowed this
                transaction. They are the difference the second verification found.
              </p>
            )}
            <ul className="story-findings">
              {(newAtCapture.length > 0 ? newAtCapture : changed).map((finding, index) => (
                <FindingCard
                  finding={finding}
                  currency={amount.currency}
                  key={`${finding.code}-${String(index)}`}
                />
              ))}
            </ul>
            <p className="field-hint" style={{ marginTop: '0.75rem' }}>
              Values come from the kernel&rsquo;s own findings, recorded in the evidence envelope
              for this decision. Re-running that envelope reproduces the same decision hash.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
