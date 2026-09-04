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

const SCENARIOS: readonly {
  id: ScenarioId;
  label: string;
  outcome: string;
  tone: 'safe' | 'danger' | 'attention';
  blurb: string;
}[] = [
  {
    id: 'happy',
    label: 'Everything checks out',
    outcome: 'Payment captured',
    tone: 'safe',
    blurb:
      'The agent finds a dinner inside your budget, CaptureLock verifies it twice, and the payment goes through.',
  },
  {
    id: 'drift',
    label: 'The restaurant reprices mid-payment',
    outcome: 'Capture refused · ₹0 moved',
    tone: 'danger',
    blurb:
      'Verified at ₹4,949. The restaurant changes it to ₹5,499 before the money moves. CaptureLock re-reads reality at the last moment and refuses.',
  },
  {
    id: 'overreach',
    label: 'The agent reaches past its budget',
    outcome: 'Refused before it starts',
    tone: 'attention',
    blurb:
      'The agent tries to book the ₹6,649 tasting menu. Your delegation says ₹5,000, so no mandate is ever created — reality never enters into it.',
  },
];

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
          decides <em>whether the payment may happen</em>. CaptureLock sits between them and
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
          <div className="boundary-role">CaptureLock</div>
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
              <span className="scenario-label">{scenario.label}</span>
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

      <section className="landing-foot">
        <p>
          Behind this is an operator console — the human control surface for anything CaptureLock
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
