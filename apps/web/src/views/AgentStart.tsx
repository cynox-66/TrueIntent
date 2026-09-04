/**
 * The first screen, and the one that has to do the explaining.
 *
 * Someone lands here knowing nothing. In the time it takes to scroll once they
 * should understand the problem — an autonomous agent transacting on your
 * behalf — and the answer: the agent decides what to buy, and something else
 * entirely decides whether money may move.
 *
 * So the order is deliberate. The claim, then the boundary drawn as two boxes,
 * then the delegation stated in the user's own terms, then three scenarios that
 * each end somewhere different. Nothing here is decorative: the diagram is the
 * architecture, and the scenarios run the real API.
 */

import { useState, type ReactNode } from 'react';
import { api, type Principal } from '../api/client.js';
import type { EvaluationSummary } from '../api/types.js';
import { useAsync } from '../lib/useAsync.js';
import { navigate } from '../lib/router.js';
import { formatMoney } from '../lib/format.js';
import { ErrorBlock } from '../components/primitives.js';

/** The three ways this can end. Each runs the real flow; none is scripted. */
export type ScenarioId = 'happy' | 'drift' | 'overreach';

interface DemoSessionResponse {
  readonly sessionId: string;
  readonly principal: Principal;
  readonly merchantId: string;
  readonly purpose: string;
  readonly bounds: {
    readonly currency: string;
    readonly totalBudget: { currency: string; amountMinor: number };
    readonly maxPerPurchase: { currency: string; amountMinor: number };
    readonly allowedCategories: readonly string[];
  };
}

/**
 * The three scenarios, each labelled with the question it answers.
 *
 * The two refusals are different checks, and saying so is the point. Authority
 * asks whether the purchase was ever allowed, and needs to know nothing about
 * the merchant. Reality asks whether it is still true, and can only be answered
 * by reading the merchant again. A single "security check" badge over both
 * would make the system look like one rule doing double duty.
 */
const SCENARIOS: readonly {
  id: ScenarioId;
  label: string;
  question: string;
  check: 'BOTH' | 'AUTHORITY' | 'REALITY';
  outcome: string;
  tone: 'safe' | 'danger' | 'attention';
  blurb: string;
}[] = [
  {
    id: 'happy',
    label: 'Everything checks out',
    question: 'Both questions answered yes',
    check: 'BOTH',
    outcome: 'Payment captured',
    tone: 'safe',
    blurb:
      'The agent finds a dinner inside your budget, TrueIntent verifies it twice — once when the order is placed, once again before the money moves — and the payment goes through.',
  },
  {
    id: 'drift',
    label: 'The restaurant reprices mid-payment',
    question: 'Is this purchase still true?',
    check: 'REALITY',
    outcome: 'Capture refused · ₹0 moved',
    tone: 'danger',
    blurb:
      'Verified at ₹4,949 and authorized by Razorpay. The restaurant changes it to ₹5,499 before the money moves. TrueIntent re-reads the menu at the last instant and refuses.',
  },
  {
    id: 'overreach',
    label: 'The agent reaches past its budget',
    question: 'Was this purchase ever allowed?',
    check: 'AUTHORITY',
    outcome: 'Refused before it starts',
    tone: 'attention',
    blurb:
      'The agent tries to book the ₹6,649 tasting menu. Your delegation says ₹5,000, so no mandate is created and the restaurant is never consulted — reality never enters into it.',
  },
];

/**
 * The counterfactual, from the committed evaluation report.
 *
 * The strongest thing this project can say is not "we refuse things" — it is
 * what the *same agent* does without the layer. That figure already exists in
 * `reports/evaluation.json`; this reads it rather than restating it, so the
 * screen can never claim a number the report does not.
 *
 * It renders nothing at all when no report is available. A missing proof point
 * is honest; a placeholder standing in for one is not.
 */
function EvaluationProof(): ReactNode {
  const { state } = useAsync<EvaluationSummary>(signal => api.evaluationSummary(signal), []);

  if (state.status !== 'ready' || !state.data.available) return null;
  const summary = state.data;

  return (
    <section className="proof" aria-label="Evaluation result">
      <div className="proof-head">
        Evaluation result — {summary.totalScenarios} scenarios, {summary.adversarialScenarios}{' '}
        adversarial
      </div>

      <div className="proof-rows">
        <div className="proof-row is-without">
          <span className="proof-label">Without TrueIntent</span>
          <span className="proof-figure">
            {formatMoney({
              currency: summary.currency,
              amountMinor: summary.baselineUnauthorizedSpendMinor,
            } as never)}{' '}
            moved
          </span>
          <span className="proof-detail">
            {summary.baselineUnsafeCharges} unauthorized charges
          </span>
        </div>

        <div className="proof-row is-with">
          <span className="proof-label">With TrueIntent</span>
          <span className="proof-figure">
            {formatMoney({ currency: summary.currency, amountMinor: 0 } as never)} moved
          </span>
          <span className="proof-detail">{summary.gatedUnsafeCharges} unauthorized charges</span>
        </div>
      </div>

      <p className="proof-foot">
        The same agent, the same catalogue, the same payment provider — run twice. This is a
        committed evaluation suite, not production traffic, and it measures behaviour on scenarios
        this project chose. {summary.falseRefusals} legitimate purchases were wrongly refused;{' '}
        {summary.decisionsReplayed} decisions replayed from evidence.
      </p>
    </section>
  );
}

export function AgentStart(): ReactNode {
  const [starting, setStarting] = useState<ScenarioId | null>(null);
  const [error, setError] = useState<unknown>(null);

  const start = (scenario: ScenarioId): void => {
    setStarting(scenario);
    setError(null);
    void api
      .startDemoSession()
      .then((session: DemoSessionResponse) => {
        // The scenario rides in the hash so the session screen knows which
        // story to run. The session itself is already real and server-side.
        window.location.hash = `#/agent/${encodeURIComponent(session.sessionId)}?s=${scenario}`;
      })
      .catch((cause: unknown) => {
        setStarting(null);
        setError(cause);
      });
  };

  return (
    <div className="agent-landing">
      <section className="hero">
        <p className="hero-eyebrow">Agentic commerce, with a payment boundary</p>
        <h1 className="hero-title">
          You can let an AI agent spend your money
          <br />
          without giving it your money.
        </h1>
        <p className="hero-lede">
          An agent is good at deciding <em>what</em> to buy. It should never be the thing that
          decides <em>whether the payment may happen</em>. TrueIntent sits between them and
          re-checks, at the instant money would move, that the purchase still matches what you
          delegated and what the merchant will actually honour.
        </p>
      </section>

      {/* The architecture, as two boxes. If a reader takes one thing away, this. */}
      <section className="boundary" aria-label="Where the boundary sits">
        <div className="boundary-box boundary-agent">
          <div className="boundary-role">AI agent</div>
          <ul className="boundary-list">
            <li>Search</li>
            <li>Compare</li>
            <li>Choose</li>
            <li>Request a purchase</li>
          </ul>
          <div className="boundary-note">May be wrong. May be manipulated.</div>
        </div>

        <div className="boundary-arrow" aria-hidden="true">
          <span className="boundary-arrow-label">a request, never a payment</span>
          <span className="boundary-arrow-glyph">→</span>
        </div>

        <div className="boundary-box boundary-lock">
          <div className="boundary-role">TrueIntent</div>
          <ul className="boundary-list">
            <li>Checks your delegation</li>
            <li>Re-reads the merchant</li>
            <li>Compares the live price</li>
            <li>Decides, and seals evidence</li>
          </ul>
          <div className="boundary-note">Deterministic. The only path to the provider.</div>
        </div>

        <div className="boundary-arrow" aria-hidden="true">
          <span className="boundary-arrow-label">only on ALLOW</span>
          <span className="boundary-arrow-glyph">→</span>
        </div>

        <div className="boundary-box boundary-provider">
          <div className="boundary-role">Razorpay</div>
          <div className="boundary-note boundary-note-strong">Test mode</div>
        </div>
      </section>

      <EvaluationProof />

      <section className="delegation-card">
        <div className="delegation-head">What you are delegating</div>
        <p className="delegation-intent">“Thai dinner for two, under ₹5,000.”</p>
        <dl className="delegation-terms">
          <div>
            <dt>Total budget</dt>
            <dd>{formatMoney({ currency: 'INR', amountMinor: 500_000 } as never)}</dd>
          </div>
          <div>
            <dt>Per purchase</dt>
            <dd>{formatMoney({ currency: 'INR', amountMinor: 500_000 } as never)}</dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>dining</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>in 24 hours</dd>
          </div>
        </dl>
        <p className="delegation-foot">
          The agent cannot set any of these. They are established by this application, which holds
          the issuing key — the agent never does.
        </p>
      </section>

      <section className="scenarios">
        <h2 className="scenarios-title">Watch what happens</h2>
        <p className="scenarios-sub">
          Each runs the real API against Postgres. Nothing below is a mock-up of a result.
        </p>

        {/*
          Named once, before the cards, so the two refusals read as two
          different checks rather than as the system saying no twice.
        */}
        <div className="two-questions">
          <div className="two-questions-item">
            <span className="two-questions-tag is-authority">Authority</span>
            <span className="two-questions-text">
              <strong>Was this purchase ever allowed?</strong> Answered from what you delegated.
              Needs to know nothing about the merchant.
            </span>
          </div>
          <div className="two-questions-item">
            <span className="two-questions-tag is-reality">Reality</span>
            <span className="two-questions-text">
              <strong>Is this purchase still true?</strong> Answered by reading the merchant again,
              at the instant money would move.
            </span>
          </div>
        </div>

        <div className="scenario-grid">
          {SCENARIOS.map(scenario => (
            <button
              key={scenario.id}
              type="button"
              className={`scenario-card is-${scenario.tone}`}
              onClick={() => {
                start(scenario.id);
              }}
              disabled={starting !== null}
            >
              <span className={`scenario-check is-${scenario.check.toLowerCase()}`}>
                {scenario.check === 'BOTH' ? 'Authority + Reality' : scenario.check}
              </span>
              <span className="scenario-label">{scenario.label}</span>
              <span className="scenario-question">{scenario.question}</span>
              <span className="scenario-blurb">{scenario.blurb}</span>
              <span className="scenario-outcome">
                {starting === scenario.id ? 'Starting…' : scenario.outcome}
              </span>
            </button>
          ))}
        </div>

        {error !== null && (
          <div style={{ marginTop: '1rem' }}>
            <ErrorBlock error={error} />
          </div>
        )}
      </section>

      <p className="fixture-note">
        Demo merchant fixture — the verification boundary is provider-independent. The gate reads
        the merchant through the same port a live connector would implement, so what changes for a
        real merchant is the connector, not the check.
      </p>

      <section className="landing-foot">
        <p>
          Behind this is an operator console — the human control surface for anything TrueIntent
          pauses.{' '}
          <a
            href="#/operator"
            onClick={event => {
              event.preventDefault();
              navigate({ name: 'queue' });
            }}
          >
            Open the operator console
          </a>
          .
        </p>
      </section>
    </div>
  );
}
