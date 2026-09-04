/**
 * The live session: what the agent did, and what TrueIntent made of it.
 *
 * Two rules shaped this screen.
 *
 * **Nothing here is simulated.** Every step runs the real API in order, and
 * every fact rendered afterwards is read back from the server's own timeline
 * projection rather than remembered from the request that caused it. If the
 * server and this screen ever disagreed, the server would be right and the
 * screen would show it — which is the only arrangement worth having in a
 * payment UI.
 *
 * **A refusal is the interesting outcome, so it gets the strongest treatment.**
 * The number that matters is not the verdict, it is whether money moved, and
 * those are different claims: a refusal after a provider call would still be a
 * charge. So `moneyMoved` is stated on its own, in its own words, read from
 * release state.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, type Principal } from '../api/client.js';
import type {
  AgentRunResponse,
  AgentTimelinePurchase,
  AgentTimelineResponse,
  PurchaseOutcomeResponse,
} from '../api/types.js';
import { formatMoney } from '../lib/format.js';
import { explainReason } from '../lib/reason-codes.js';
import { hrefFor, navigate } from '../lib/router.js';
import { ErrorBlock, Panel, Pill, RawJson, Skeleton } from '../components/primitives.js';
import type { ScenarioId } from './AgentStart.js';

const DINNER_SKU = 'SKU-THAI-DINNER-2';
const TASTING_SKU = 'SKU-THAI-DINNER-DLX';
/** 4,799 + 150 service = 4,949 all-in. */
const DINNER_PRICE_MINOR = 479_900;
/** 5,349 + 150 service = 5,499 all-in — past the 5,000 delegation. */
const DRIFTED_PRICE_MINOR = 534_900;

/** One line in the running narrative. Its state is what the UI animates. */
interface Step {
  readonly key: string;
  readonly label: string;
  readonly actor: 'user' | 'agent' | 'merchant' | 'capturelock' | 'provider';
  readonly status: 'pending' | 'running' | 'done' | 'refused';
  readonly detail?: string;
}

interface AgentSessionProps {
  readonly sessionId: string;
  readonly scenario: ScenarioId;
}

function money(amountMinor: number): string {
  return formatMoney({ currency: 'INR', amountMinor } as never);
}

function idempotencyKey(label: string): string {
  // At least 16 characters, unique per attempt. The server refuses a reused key
  // carrying a different payload, which is a property worth not tripping over
  // by accident in a demo.
  return `idem-${label}-${Math.random().toString(36).slice(2, 14).padEnd(12, '0')}`;
}

export function AgentSession({ sessionId, scenario }: AgentSessionProps): ReactNode {
  const [steps, setSteps] = useState<readonly Step[]>([]);
  const [run, setRun] = useState<AgentRunResponse | null>(null);
  /**
   * The SKU actually submitted to TrueIntent.
   *
   * Not always what the planner picked: the overreach scenario deliberately
   * sends something the planner rejected, and badging the planner's choice
   * there would show a reader the opposite of what happened.
   */
  const [submittedSku, setSubmittedSku] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<AgentTimelineResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [finished, setFinished] = useState(false);
  const started = useRef(false);

  const push = useCallback((step: Step): void => {
    setSteps((current: readonly Step[]) => {
      const index = current.findIndex(entry => entry.key === step.key);
      if (index === -1) return [...current, step];
      const next = [...current];
      next[index] = step;
      return next;
    });
  }, []);

  useEffect(() => {
    // A scenario runs once per mount. React's development double-invoke would
    // otherwise start two flows against one session, and the second would be
    // refused for reasons that have nothing to do with the story being told.
    if (started.current) return;
    started.current = true;

    const principal: Principal = { userId: 'user_priya', sessionId };

    void (async () => {
      try {
        await runScenario({ scenario, sessionId, principal, push, setRun, setSubmittedSku });
      } catch (cause) {
        setError(cause);
      } finally {
        // Whatever happened, the truth is whatever the server says it is.
        try {
          setTimeline(await api.timeline(sessionId, principal));
        } catch (cause) {
          setError((current: unknown) => current ?? cause);
        }
        setFinished(true);
      }
    })();
  }, [scenario, sessionId, push]);

  const purchase = timeline?.purchases[0] ?? null;

  return (
    <div className="agent-session">
      <header className="session-head">
        <a
          className="breadcrumb"
          href={hrefFor({ name: 'agent' })}
          onClick={event => {
            event.preventDefault();
            navigate({ name: 'agent' });
          }}
        >
          ← Start over
        </a>
        <h1 className="session-title">“Thai dinner for two, under ₹5,000.”</h1>
        <p className="session-sub">
          Delegated to a bounded agent · session <span className="mono">{sessionId}</span>
        </p>
      </header>

      {finished && purchase !== null && <Verdict purchase={purchase} timeline={timeline} />}

      <div className="session-body">
        <section className="session-timeline" aria-label="What happened">
          <ol className="timeline">
            {steps.map(step => (
              <li key={step.key} className={`timeline-step is-${step.status} actor-${step.actor}`}>
                <span className="timeline-dot" aria-hidden="true" />
                <div className="timeline-content">
                  <div className="timeline-actor">{actorLabel(step.actor)}</div>
                  <div className="timeline-label">{step.label}</div>
                  {step.detail !== undefined && (
                    <div className="timeline-detail">{step.detail}</div>
                  )}
                </div>
              </li>
            ))}
            {!finished && steps.length === 0 && <Skeleton rows={4} />}
          </ol>

          {error !== null && (
            <div style={{ marginTop: '1rem' }}>
              <ErrorBlock error={error} />
            </div>
          )}
        </section>

        <aside className="session-aside">
          {run !== null && <AgentReasoning run={run} submittedSku={submittedSku} />}
          {finished && purchase !== null && <GateEvidence purchase={purchase} />}
          {timeline !== null && <BudgetPanel timeline={timeline} />}
        </aside>
      </div>
    </div>
  );
}

/**
 * The headline answer.
 *
 * `moneyMoved` gets its own line because it is a different claim from the
 * verdict. A system that only said "DENY" would be leaving the reader to infer
 * the part that actually matters.
 */
function Verdict({
  purchase,
  timeline,
}: {
  purchase: AgentTimelinePurchase;
  timeline: AgentTimelineResponse | null;
}): ReactNode {
  const captureGate = [...purchase.gates].reverse().find(gate => gate.gate === 'CAPTURE');
  const orderGate = purchase.gates.find(gate => gate.gate === 'ORDER_CREATION');
  const decisive = captureGate ?? orderGate ?? null;
  const refusedBeforeGates = purchase.gates.length === 0;

  const tone = purchase.moneyMoved ? 'safe' : 'danger';
  const title = purchase.moneyMoved
    ? 'Payment captured'
    : refusedBeforeGates
      ? 'Refused before a mandate existed'
      : `Refused at ${decisive?.gate === 'CAPTURE' ? 'the capture gate' : 'the order gate'}`;

  return (
    <section className={`verdict-hero is-${tone}`}>
      <div className="verdict-hero-main">
        <div className="verdict-hero-title">{title}</div>
        <div className="verdict-hero-money">
          {purchase.moneyMoved ? (
            <>
              {money(purchase.amount?.amountMinor ?? 0)} charged
              <span className="verdict-hero-provider">
                {timeline?.paymentProvider === 'fake'
                  ? ' · simulated provider, no real payment'
                  : ' · Razorpay test mode'}
              </span>
            </>
          ) : (
            <>₹0 moved — the provider was never asked to capture</>
          )}
        </div>
      </div>
      {decisive !== null && decisive.reasonCodes.length > 0 && (
        <div className="verdict-hero-reasons">
          {decisive.reasonCodes.slice(0, 2).map(code => (
            <span key={code} className="verdict-code">
              {code}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/** What the agent looked at and what it picked. Labelled as its own account. */
function AgentReasoning({
  run,
  submittedSku,
}: {
  run: AgentRunResponse;
  submittedSku: string | null;
}): ReactNode {
  // What was submitted, falling back to what the planner chose while the
  // request is still in flight.
  const chosen = new Set<string>(
    submittedSku !== null
      ? [submittedSku]
      : run.outcome.kind === 'PURCHASE_REQUESTED'
        ? run.outcome.cart.map(line => line.sku)
        : [],
  );

  return (
    <Panel title="What the agent considered">
      {/*
        Which model chose this, said plainly. A viewer should not have to
        recognise a model name to know whether they are watching an LLM reason
        or the deterministic fallback stand in for one.
      */}
      <div className="model-badge-row">
        <span className={`model-badge is-${run.modelKind.toLowerCase()}`}>{run.modelLabel}</span>
        <span className="model-name mono">{run.model}</span>
        <span className="model-steps">{run.steps.length} steps</span>
      </div>
      <p className="aside-note">{run.modelReason}</p>
      <ul className="candidate-list">
        {run.observed
          .filter(product => product.category === 'dining')
          .map(product => (
            <li
              key={product.sku}
              className={`candidate ${chosen.has(product.sku) ? 'is-chosen' : ''}`}
            >
              <span className="candidate-name">{product.name}</span>
              <span className="candidate-price">
                {money(product.indicativeUnitPriceMinor)}
                <span className="candidate-indicative"> listed</span>
              </span>
              {chosen.has(product.sku) && <span className="candidate-tag">chosen</span>}
            </li>
          ))}
      </ul>
      {run.outcome.kind === 'PURCHASE_REQUESTED' && (
        <div className="agent-rationale">
          <div className="agent-rationale-label">The agent’s reasoning — a judgement</div>
          <div className="agent-rationale-text">{run.outcome.reason}</div>
        </div>
      )}
      <p className="aside-note">
        Listed prices are what the agent saw. What gets charged is priced by the server from a live
        merchant read, and re-read again before the money moves.
      </p>
    </Panel>
  );
}

/** Both gate decisions, with the findings that produced them. */
function GateEvidence({ purchase }: { purchase: AgentTimelinePurchase }): ReactNode {
  return (
    <Panel title="What TrueIntent checked">
      {purchase.gates.length === 0 ? (
        <p className="muted">
          No gate ran. The request was refused against the delegation before any mandate was
          created, so there was nothing for the kernel to verify.
        </p>
      ) : (
        <ul className="gate-list">
          {purchase.gates.map(gate => (
            <li key={`${gate.gate}-${gate.decisionHash}`} className={`gate is-${gate.verdict}`}>
              <div className="gate-head">
                <span className="gate-name">
                  {gate.gate === 'ORDER_CREATION'
                    ? 'Gate 1 · binds the terms'
                    : 'Gate 2 · money moves here'}
                </span>
                <Pill tone={gate.verdict === 'ALLOW' ? 'safe' : 'danger'}>{gate.verdict}</Pill>
              </div>
              {gate.findings
                .filter(finding => finding.severity !== 'INFO' || gate.verdict === 'ALLOW')
                .slice(0, 2)
                .map(finding => (
                  <div key={finding.code} className="gate-finding">
                    <span className="mono">{finding.code}</span>
                    <span className="gate-finding-text">
                      {explainReason(finding.code).description ?? finding.message}
                    </span>
                    <PriceDelta detail={finding.detail} />
                  </div>
                ))}
            </li>
          ))}
        </ul>
      )}

      <div className="evidence-line">
        <span>
          {purchase.evidence.envelopeCount} evidence envelope
          {purchase.evidence.envelopeCount === 1 ? '' : 's'} ·{' '}
          {purchase.evidence.valid ? 'chain verified' : 'chain INVALID'}
        </span>
        <a
          href={hrefFor({ name: 'evidence', chainId: purchase.evidence.chainId })}
          onClick={event => {
            event.preventDefault();
            navigate({ name: 'evidence', chainId: purchase.evidence.chainId });
          }}
        >
          Inspect the chain →
        </a>
      </div>
      <RawJson label="Raw server timeline" value={purchase} />
    </Panel>
  );
}

/**
 * The two prices, side by side.
 *
 * Rendered from the finding's own detail rather than from anything this screen
 * remembers, so the numbers shown are the numbers the kernel compared.
 */
function PriceDelta({
  detail,
}: {
  detail: Readonly<Record<string, string | number | boolean | null>>;
}): ReactNode {
  const charged = detail['chargedUnitPriceMinor'];
  const live = detail['liveUnitPriceMinor'];
  if (typeof charged !== 'number' || typeof live !== 'number') return null;

  return (
    <div className="price-delta">
      {/*
        Unit prices, which is what the kernel compared. The timeline above
        quotes all-in totals, and a reader seeing two different pairs of
        numbers without being told why would reasonably wonder which is real.
      */}
      <span className="price-delta-label">item price</span>
      <span className="price-was">verified at {money(charged)}</span>
      <span className="price-arrow" aria-hidden="true">
        →
      </span>
      <span className="price-now">merchant now wants {money(live)}</span>
    </div>
  );
}

function BudgetPanel({ timeline }: { timeline: AgentTimelineResponse }): ReactNode {
  const session = timeline.session;
  const budget = session.bounds['totalBudget'] as { amountMinor: number } | undefined;
  const total = budget?.amountMinor ?? 0;
  const spent = session.spentMinor;
  const held = session.reservedMinor;

  return (
    <Panel title="Your delegated budget">
      <div
        className="budget-bar"
        role="img"
        aria-label={`${money(spent)} spent of ${money(total)}`}
      >
        <span className="budget-spent" style={{ width: `${String((spent / total) * 100)}%` }} />
        <span className="budget-held" style={{ width: `${String((held / total) * 100)}%` }} />
      </div>
      <dl className="budget-figures">
        <div>
          <dt>Spent</dt>
          <dd>{money(spent)}</dd>
        </div>
        <div>
          <dt>Held</dt>
          <dd>{money(held)}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>{money(session.remaining.amountMinor)}</dd>
        </div>
      </dl>
      <p className="aside-note">
        A refused purchase releases its hold. Your budget is only consumed by money that actually
        moved.
      </p>
    </Panel>
  );
}

function actorLabel(actor: Step['actor']): string {
  switch (actor) {
    case 'user':
      return 'You';
    case 'agent':
      return 'AI agent';
    case 'merchant':
      return 'Restaurant';
    case 'capturelock':
      return 'TrueIntent';
    case 'provider':
      return 'Razorpay';
  }
}

/**
 * Runs one scenario against the real API.
 *
 * Written as a straight sequence rather than a state machine, because it is a
 * straight sequence and the reader should be able to check it against the
 * narrative on screen line by line.
 */
async function runScenario(input: {
  scenario: ScenarioId;
  sessionId: string;
  principal: Principal;
  push: (step: Step) => void;
  setRun: (run: AgentRunResponse) => void;
  setSubmittedSku: (sku: string) => void;
}): Promise<void> {
  const { scenario, sessionId, principal, push, setRun, setSubmittedSku } = input;

  // The merchant's world is global and the drift scenario changes it. Reset it
  // to the baseline first, so a second run tells the same story as the first —
  // a demo whose outcome depends on how many times it has been clicked is not
  // demonstrating anything.
  await api.setCatalogPrice(DINNER_SKU, DINNER_PRICE_MINOR);

  push({
    key: 'delegate',
    label: 'Delegated a bounded session',
    actor: 'user',
    status: 'done',
    detail: '₹5,000 total · dining only · expires in 24 hours',
  });

  // ---- the agent shops --------------------------------------------------
  push({
    key: 'shop',
    label: 'Searching the restaurant’s menu',
    actor: 'agent',
    status: 'running',
  });
  const run = await api.runAgent(
    sessionId,
    { merchantId: 'merchant_alpha', goal: 'Thai dinner for two under 5000 rupees' },
    principal,
  );
  setRun(run);

  const dining = run.observed.filter(product => product.category === 'dining');
  push({
    key: 'shop',
    label: `Compared ${String(dining.length)} dining options`,
    actor: 'agent',
    status: 'done',
    detail: dining.map(p => `${p.name} ${money(p.indicativeUnitPriceMinor)}`).join(' · '),
  });

  // ---- which one does this scenario ask for? -----------------------------
  const overreaching = scenario === 'overreach';
  const sku = overreaching ? TASTING_SKU : DINNER_SKU;
  setSubmittedSku(sku);

  // The rationale that goes into evidence has to describe what was actually
  // submitted. Carrying the planner's reasoning about a different item would
  // put a false explanation into an append-only ledger.
  const rationale = overreaching
    ? 'Reached for the chef’s tasting menu despite the delegated ceiling.'
    : run.outcome.kind === 'PURCHASE_REQUESTED'
      ? run.outcome.reason
      : 'Selected from the restaurant’s menu for the stated goal.';

  push({
    key: 'select',
    label: overreaching
      ? 'Chose the chef’s tasting menu — outside your budget'
      : 'Chose the dinner for two',
    actor: 'agent',
    status: 'done',
    detail: overreaching
      ? 'An agent reaching past what it was delegated. It is allowed to ask.'
      : 'Inside the delegation, on the agent’s own reading of the menu.',
  });

  // ---- ask TrueIntent ---------------------------------------------------
  push({
    key: 'gate1',
    label: 'Asked TrueIntent to verify the purchase',
    actor: 'agent',
    status: 'running',
  });

  const purchase: PurchaseOutcomeResponse = await api.requestPurchase(
    sessionId,
    {
      merchantId: 'merchant_alpha',
      lines: [{ sku, quantity: 1 }],
      idempotencyKey: idempotencyKey('buy'),
      rationale,
      agentModel: run.model,
      agentSteps: run.steps.length,
      agentRefusedSteps: run.steps.filter(step => !step.accepted).length,
      catalogVersion:
        run.outcome.kind === 'PURCHASE_REQUESTED' ? run.outcome.catalogVersion : 'unknown',
    },
    principal,
  );

  // Refused before a mandate existed — the authority violation.
  if (purchase.error !== undefined) {
    push({
      key: 'gate1',
      label: 'Refused against your delegation',
      actor: 'capturelock',
      status: 'refused',
      detail: purchase.message ?? purchase.error,
    });
    push({
      key: 'nothing',
      label: 'No mandate created · no order placed · ₹0 moved',
      actor: 'capturelock',
      status: 'done',
      detail:
        'The merchant was never consulted. Whether the price was right is beside the point — the agent was not authorized to spend that much.',
    });
    return;
  }

  push({
    key: 'gate1',
    label: `Gate 1 · ${String(purchase.verdict)} — terms bound`,
    actor: 'capturelock',
    status: purchase.verdict === 'ALLOW' ? 'done' : 'refused',
    detail: 'Priced by the server from a live read of the menu. The agent never stated a total.',
  });

  if (purchase.verdict !== 'ALLOW' || purchase.releaseId == null) return;

  // ---- the payer authorizes ---------------------------------------------
  push({
    key: 'authorize',
    label: 'Payment authorized, not yet captured',
    actor: 'provider',
    status: 'running',
  });
  await api.simulatePayerAuthorization(purchase.releaseId);
  push({
    key: 'authorize',
    label: 'Payment authorized, not yet captured',
    actor: 'provider',
    status: 'done',
    detail: 'Funds are held. Nothing has been taken yet — that is what the second gate is for.',
  });

  // ---- reality moves, if this scenario says so ---------------------------
  if (scenario === 'drift') {
    push({ key: 'drift', label: 'Reprices the dinner', actor: 'merchant', status: 'running' });
    await api.setCatalogPrice(DINNER_SKU, DRIFTED_PRICE_MINOR);
    push({
      key: 'drift',
      label: `Reprices the dinner · ${money(DINNER_PRICE_MINOR + 15_000)} → ${money(DRIFTED_PRICE_MINOR + 15_000)}`,
      actor: 'merchant',
      status: 'done',
      detail: 'Nothing in TrueIntent changed. The world did.',
    });
  }

  // ---- the capture gate --------------------------------------------------
  push({ key: 'gate2', label: 'Asked TrueIntent to capture', actor: 'agent', status: 'running' });
  const captured = await api.requestCapture(
    sessionId,
    {
      authorizationId: String(purchase.authorizationId),
      idempotencyKey: idempotencyKey('cap'),
    },
    principal,
  );

  const refusedAtCapture = captured.error !== undefined || captured.verdict !== 'ALLOW';
  push({
    key: 'gate2',
    label: refusedAtCapture
      ? 'Gate 2 · DENY — re-read the menu and refused'
      : 'Gate 2 · ALLOW — captured',
    actor: 'capturelock',
    status: refusedAtCapture ? 'refused' : 'done',
    detail: refusedAtCapture
      ? (captured.reasonCodes?.join(', ') ?? captured.message ?? 'Refused.')
      : 'Verified a second time against a fresh read, then released the payment.',
  });

  if (refusedAtCapture) {
    push({
      key: 'result',
      label: 'The provider was never asked to capture · ₹0 moved',
      actor: 'capturelock',
      status: 'done',
      detail: 'The authorization will expire on its own. Your budget hold was released.',
    });
  }
}

export { ApiError };
