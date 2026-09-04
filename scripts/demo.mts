/**
 * `pnpm demo` — the walkthrough, driven over HTTP against a running API.
 *
 * The README used to carry this as a block of `curl` commands sharing header
 * strings through shell variables. That form is silently broken under zsh,
 * which does not word-split an unquoted parameter expansion: `curl $AGENT ...`
 * passes the whole header string as one argument, every request is rejected
 * with a bare 400, and the first step of the flagship demonstration fails with
 * no indication of why. zsh has been the macOS default since Catalina, so the
 * most likely reader of that block was the one guaranteed to hit it.
 *
 * This runs the same requests, against the same endpoints, with no privileged
 * access of any kind — every call is one an agent, an issuer or an operator
 * could make, with exactly the headers that party would hold. It asserts what
 * it expects at each step and exits non-zero the moment reality disagrees, so
 * it is a check as well as a demonstration.
 *
 *   pnpm demo              the price-drift refusal (the one that matters)
 *   pnpm demo review       the operator flow: paused, approved, re-verified
 *   pnpm demo happy        verified at both gates, captured
 *
 * Requires `pnpm dev` in another terminal, and the fake provider — the
 * catalogue mutation that makes the merchant's price move is a development
 * route that does not exist against a real provider.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env['CAPTURELOCK_API'] ?? 'http://localhost:3000';
/** Where the console is served, for the links this demo prints at the end. */
const WEB = process.env['CAPTURELOCK_WEB'] ?? 'http://localhost:5173';

/** An agent holds a principal and nothing else. */
const AGENT = {
  'content-type': 'application/json',
  'x-capturelock-user': 'user_priya',
  'x-capturelock-session': 'sess_01',
};
/** The trusted user-facing application. An agent never has this. */
const ISSUER = {
  ...AGENT,
  'x-capturelock-issuer-key': process.env['ISSUER_API_KEY'] ?? 'dev-issuer-key-not-for-production',
};
/** A human operator's console. An agent never has this either. */
const OPERATOR = {
  'content-type': 'application/json',
  'x-capturelock-operator-key': process.env['OPERATOR_API_KEY'] ?? 'dev-operator-key-not-for-prod',
  'x-capturelock-operator': 'operator_demo',
};

const SKU = 'SKU-BLK-RUN-42';
const LIST_PRICE_MINOR = 479_900;
const RAISED_PRICE_MINOR = 549_900;

// ------------------------------------------------------------------ output --

const BOLD = '[1m';
const DIM = '[2m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';
const OFF = '[0m';

let step = 0;
function say(what: string): void {
  step += 1;
  console.info(`\n${BOLD}${String(step)}. ${what}${OFF}`);
}
function detail(line: string): void {
  console.info(`   ${DIM}${line}${OFF}`);
}
function verdict(colour: string, line: string): void {
  console.info(`   ${colour}${BOLD}${line}${OFF}`);
}
function inr(minor: number): string {
  return `INR ${(minor / 100).toFixed(2)}`;
}

class DemoError extends Error {}

function assert(condition: boolean, what: string): void {
  if (!condition) throw new DemoError(what);
}

// ------------------------------------------------------------------- client --

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new DemoError(
      `Could not reach the API at ${BASE}. Start it with \`pnpm dev\` in another terminal.`,
    );
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DemoError(`${path} returned a body that is not JSON: ${text.slice(0, 200)}`);
    }
  }
  return { status: response.status, body: parsed as T };
}

/** Idempotency keys must be at least 16 characters, and unique per request. */
function key(label: string): string {
  return `idem-${label}-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

async function setPrice(unitPriceMinor: number): Promise<void> {
  const { status } = await call(
    'POST',
    '/v1/dev/catalog',
    { 'content-type': 'application/json' },
    {
      kind: 'SET_PRICE',
      sku: SKU,
      unitPriceMinor,
    },
  );
  if (status === 404) {
    throw new DemoError(
      'The development catalogue route is not available. This demo needs PAYMENT_PROVIDER=fake ' +
        '(the default) and a non-production NODE_ENV.',
    );
  }
  assert(status === 200, `catalogue mutation failed with ${String(status)}`);
}

// -------------------------------------------------------------------- steps --

interface Ids {
  authorizationId: string;
  snapshotId: string;
  releaseId: string;
}

/** Issue the mandate, price the cart, pass gate 1, and let the payer authorize. */
async function upToPaymentAuthorized(label: string): Promise<Ids> {
  say('The USER’s application issues a mandate.');
  const constraints = JSON.parse(
    await readFile(join(ROOT, 'docs/examples/authorization.json'), 'utf8'),
  ) as Record<string, unknown>;

  const refused = await call('POST', '/v1/authorizations', AGENT, constraints);
  assert(
    refused.status === 403,
    `an agent without the issuer key should be refused, got ${String(refused.status)}`,
  );
  detail('The agent tried first and got 403. It cannot mint the budget it will spend.');

  const auth = await call<{ authorizationId: string; intentHash: string }>(
    'POST',
    '/v1/authorizations',
    ISSUER,
    constraints,
  );
  assert(auth.status === 201, `authorization failed: ${JSON.stringify(auth.body)}`);
  detail(`authorization ${auth.body.authorizationId}`);

  say('The agent proposes SKUs. TrueIntent prices the cart from live merchant state.');
  const quote = await call<{
    snapshotId: string;
    total: { amountMinor: number };
    itemSubtotal: { amountMinor: number };
    feeTotal: { amountMinor: number };
  }>('POST', `/v1/authorizations/${auth.body.authorizationId}/quotes`, AGENT, {
    merchantId: 'merchant_alpha',
    lines: [{ sku: SKU, quantity: 1 }],
    shipTo: { country: 'IN', region: null },
    recurring: false,
  });
  assert(quote.status === 201, `quote failed: ${JSON.stringify(quote.body)}`);
  detail(
    `${inr(quote.body.itemSubtotal.amountMinor)} item + ${inr(quote.body.feeTotal.amountMinor)} fees ` +
      `= ${inr(quote.body.total.amountMinor)} — every figure server-computed, none agent-supplied`,
  );

  say('Gate 1: the order gate.');
  const release = await call<{
    releaseId: string;
    verdict: string;
    state: string;
    providerOrderId: string | null;
    moneyMoved: boolean;
    reasonCodes: string[];
  }>('POST', '/v1/releases', AGENT, {
    authorizationId: auth.body.authorizationId,
    snapshotId: quote.body.snapshotId,
    idempotencyKey: key(`${label}-order`),
  });
  assert(
    release.body.verdict === 'ALLOW',
    `gate 1 refused: ${release.body.reasonCodes.join(', ')}`,
  );
  verdict(GREEN, `ALLOW → ${release.body.state}, order ${String(release.body.providerOrderId)}`);
  detail(`moneyMoved: ${String(release.body.moneyMoved)} — an order is not a charge`);

  say('The payer authorizes. Funds are reserved, not taken.');
  const authorized = await call<{ webhook: { state: string } }>(
    'POST',
    '/v1/dev/simulate-authorization',
    { 'content-type': 'application/json' },
    { releaseId: release.body.releaseId },
  );
  assert(
    authorized.body.webhook?.state === 'PAYMENT_AUTHORIZED',
    `payer authorization did not apply: ${JSON.stringify(authorized.body)}`,
  );
  detail('Delivered as a genuinely signed webhook through the real webhook route.');

  return {
    authorizationId: auth.body.authorizationId,
    snapshotId: quote.body.snapshotId,
    releaseId: release.body.releaseId,
  };
}

/** Replay one decision from its evidence, and verify the chain. */
async function proveIt(authorizationId: string, envelopeId: string | null): Promise<void> {
  if (envelopeId !== null) {
    say('Replay that decision from its evidence.');
    const replay = await call<{ replay: { reproduced: boolean; decisionHash: string | null } }>(
      'GET',
      `/v1/evidence/${envelopeId}`,
      {},
    );
    assert(replay.body.replay.reproduced, 'the recorded decision did not reproduce');
    verdict(GREEN, `reproduced: true (${String(replay.body.replay.decisionHash).slice(0, 16)}…)`);
    detail('The kernel re-ran over the stored context and reached the identical decision hash.');
  }

  say('Verify the evidence chain.');
  const chain = await call<{ valid: boolean; verifiedCount: number; headChainHash: string }>(
    'GET',
    `/v1/evidence/chain/${authorizationId}/verify`,
    {},
  );
  assert(chain.body.valid, 'the evidence chain did not verify');
  verdict(GREEN, `valid: true over ${String(chain.body.verifiedCount)} envelopes`);
  detail(`head ${chain.body.headChainHash.slice(0, 24)}…`);
  console.info(
    `\n   ${DIM}Open the console at http://localhost:5173/#/release/… to see this on screen.${OFF}`,
  );
}

// ----------------------------------------------------------------- the demos --

/** The one that matters: allowed at gate 1, refused at gate 2. */
async function priceDrift(): Promise<void> {
  await setPrice(LIST_PRICE_MINOR);
  const ids = await upToPaymentAuthorized('drift');

  say('The merchant raises the price. TrueIntent is told nothing.');
  await setPrice(RAISED_PRICE_MINOR);
  detail(
    `${inr(LIST_PRICE_MINOR)} → ${inr(RAISED_PRICE_MINOR)} in the merchant's catalogue. ` +
      'TrueIntent finds out on its next live read, which is the whole point.',
  );

  say('Gate 2: the capture gate. The kernel runs again against a fresh live read.');
  const capture = await call<{
    verdict: string;
    state: string;
    reasonCodes: string[];
    moneyMoved: boolean;
    evidenceEnvelopeId: string | null;
  }>('POST', `/v1/releases/${ids.releaseId}/capture`, AGENT, {
    idempotencyKey: key('drift-capture'),
  });

  assert(capture.body.verdict === 'DENY', `expected DENY, got ${capture.body.verdict}`);
  assert(
    capture.body.reasonCodes.includes('LIVE_PRICE_DIVERGED'),
    `expected LIVE_PRICE_DIVERGED, got ${capture.body.reasonCodes.join(', ')}`,
  );
  assert(!capture.body.moneyMoved, 'money moved on a refused capture');
  verdict(RED, `DENY → ${capture.body.state} (${capture.body.reasonCodes.join(', ')})`);
  detail('moneyMoved: false. The provider was never asked to capture.');

  await proveIt(ids.authorizationId, capture.body.evidenceEnvelopeId);
  await setPrice(LIST_PRICE_MINOR);
}

/** Verified at both gates, and captured. */
async function happyPath(): Promise<void> {
  await setPrice(LIST_PRICE_MINOR);
  const ids = await upToPaymentAuthorized('happy');

  say('Gate 2, with reality unchanged.');
  const capture = await call<{
    verdict: string;
    state: string;
    moneyMoved: boolean;
    reasonCodes: string[];
    evidenceEnvelopeId: string | null;
  }>('POST', `/v1/releases/${ids.releaseId}/capture`, AGENT, {
    idempotencyKey: key('happy-capture'),
  });
  assert(
    capture.body.verdict === 'ALLOW',
    `gate 2 refused: ${capture.body.reasonCodes.join(', ')}`,
  );
  assert(capture.body.moneyMoved, 'the allowed capture did not move money');
  verdict(GREEN, `ALLOW → ${capture.body.state}, moneyMoved: true`);

  say('The same mandate cannot be spent again.');
  const again = await call<{
    verdict: string;
    state: string;
    reasonCodes: string[];
    moneyMoved: boolean;
  }>('POST', `/v1/releases/${ids.releaseId}/capture`, AGENT, {
    idempotencyKey: key('happy-capture-again'),
  });
  assert(
    again.body.verdict === 'DENY',
    `a duplicate capture was not refused: ${again.body.verdict}`,
  );
  assert(again.body.state === 'CAPTURED', `the release moved on a refused duplicate`);
  verdict(GREEN, `DENY (${again.body.reasonCodes.join(', ')})`);
  detail('Refused by the state machine, not by a retry check the second caller could race past.');
  detail(
    'moneyMoved is still true — it describes the release, which was captured once. ' +
      'The verdict is what says this request did not capture it.',
  );

  await proveIt(ids.authorizationId, capture.body.evidenceEnvelopeId);
}

/**
 * The operator flow, at the gate where it is hardest: capture.
 *
 * Uses the seeded `household_review` policy, whose spend ceiling PAUSEs rather
 * than DENIES. Policy severity is chosen server-side and bound at issuance, so
 * an agent cannot select it — which is why the review path is reachable here
 * without weakening anything.
 */
async function reviewFlow(): Promise<void> {
  await setPrice(LIST_PRICE_MINOR);

  say('A mandate bound to a policy that pauses above a low ceiling.');
  const constraints = JSON.parse(
    await readFile(join(ROOT, 'docs/examples/authorization.json'), 'utf8'),
  ) as Record<string, unknown>;
  const auth = await call<{ authorizationId: string }>('POST', '/v1/authorizations', ISSUER, {
    ...constraints,
    policyId: 'household_review',
    policyVersion: '1.0.0',
  });
  assert(auth.status === 201, `authorization failed: ${JSON.stringify(auth.body)}`);
  detail(`authorization ${auth.body.authorizationId} (policy household_review)`);

  const quote = await call<{ snapshotId: string; total: { amountMinor: number } }>(
    'POST',
    `/v1/authorizations/${auth.body.authorizationId}/quotes`,
    AGENT,
    {
      merchantId: 'merchant_alpha',
      lines: [{ sku: SKU, quantity: 1 }],
      shipTo: { country: 'IN', region: null },
      recurring: false,
    },
  );
  assert(quote.status === 201, `quote failed: ${JSON.stringify(quote.body)}`);

  const orderRequest = {
    authorizationId: auth.body.authorizationId,
    snapshotId: quote.body.snapshotId,
    // The SAME key throughout. The operator's approval has to make the agent's
    // identical retry succeed; if the agent had to change anything, the
    // approval would not be what unblocked it.
    idempotencyKey: key('review-order'),
  };

  say('Gate 1 pauses. A human must look.');
  const paused = await call<{ releaseId: string; verdict: string; reasonCodes: string[] }>(
    'POST',
    '/v1/releases',
    AGENT,
    orderRequest,
  );
  assert(paused.body.verdict === 'PAUSE', `expected PAUSE, got ${paused.body.verdict}`);
  verdict(YELLOW, `PAUSE (${paused.body.reasonCodes.join(', ')})`);
  detail(`${inr(quote.body.total.amountMinor)} over the review ceiling.`);

  say('The agent tries to clear its own pause.');
  const selfResolve = await call('POST', '/v1/reviews/rev_' + 'a'.repeat(32) + '/resolve', AGENT, {
    resolution: 'APPROVED',
  });
  assert(
    selfResolve.status === 403,
    `an agent must not be able to resolve a review, got ${String(selfResolve.status)}`,
  );
  verdict(GREEN, '403 — an agent cannot approve itself. That is what makes PAUSE mean something.');

  say('The operator finds it in the queue and approves it.');
  const queue = await call<{
    items: { releaseId: string; review: { reviewId: string } | null }[];
  }>('GET', '/v1/operator/queue', OPERATOR);
  const orderReview = queue.body.items.find(i => i.releaseId === paused.body.releaseId)?.review;
  assert(
    orderReview !== null && orderReview !== undefined,
    'the paused release has no open review',
  );
  await call('POST', `/v1/reviews/${orderReview!.reviewId}/resolve`, OPERATOR, {
    resolution: 'APPROVED',
  });
  detail(`review ${orderReview!.reviewId} approved by operator_demo`);

  say('The agent retries the identical request.');
  const created = await call<{ verdict: string; state: string; reasonCodes: string[] }>(
    'POST',
    '/v1/releases',
    AGENT,
    orderRequest,
  );
  assert(
    created.body.verdict === 'ALLOW',
    `gate 1 retry refused: ${created.body.reasonCodes.join(', ')}`,
  );
  verdict(GREEN, `ALLOW → ${created.body.state} (${created.body.reasonCodes.join(', ')})`);

  await call(
    'POST',
    '/v1/dev/simulate-authorization',
    { 'content-type': 'application/json' },
    {
      releaseId: paused.body.releaseId,
    },
  );

  say('Gate 2 pauses too. The order-gate approval does not carry across the gate.');
  const capturePaused = await call<{ verdict: string; reasonCodes: string[]; moneyMoved: boolean }>(
    'POST',
    `/v1/releases/${paused.body.releaseId}/capture`,
    AGENT,
    { idempotencyKey: key('review-cap-1') },
  );
  assert(
    capturePaused.body.verdict === 'PAUSE',
    `expected PAUSE, got ${capturePaused.body.verdict}`,
  );
  assert(!capturePaused.body.moneyMoved, 'money moved on a paused capture');
  verdict(YELLOW, `PAUSE (${capturePaused.body.reasonCodes.join(', ')})`);
  detail('An approval names the gate it was given at. This one was never shown to a human.');

  say('The operator approves the capture-gate pause.');
  const queue2 = await call<{
    items: { releaseId: string; review: { reviewId: string } | null }[];
  }>('GET', '/v1/operator/queue', OPERATOR);
  const captureReview = queue2.body.items.find(i => i.releaseId === paused.body.releaseId)?.review;
  assert(
    captureReview !== null && captureReview !== undefined,
    'the capture-gate pause opened no review — the operator has nothing to resolve',
  );
  assert(
    captureReview!.reviewId !== orderReview!.reviewId,
    'the second pause reused the first review instead of opening its own',
  );
  await call('POST', `/v1/reviews/${captureReview!.reviewId}/resolve`, OPERATOR, {
    resolution: 'APPROVED',
  });
  detail(`review ${captureReview!.reviewId} — its own record, approved by operator_demo`);

  say('The agent retries the capture. The kernel runs a third time, against live state.');
  const captured = await call<{
    verdict: string;
    state: string;
    moneyMoved: boolean;
    reasonCodes: string[];
    evidenceEnvelopeId: string | null;
  }>('POST', `/v1/releases/${paused.body.releaseId}/capture`, AGENT, {
    idempotencyKey: key('review-cap-2'),
  });
  assert(
    captured.body.verdict === 'ALLOW',
    `gate 2 retry refused: ${captured.body.reasonCodes.join(', ')}`,
  );
  assert(captured.body.moneyMoved, 'the approved capture did not move money');
  verdict(GREEN, `ALLOW → ${captured.body.state}, moneyMoved: true`);
  detail('The approval authorized re-verification. The kernel still had the last word.');

  await proveIt(auth.body.authorizationId, captured.body.evidenceEnvelopeId);
}

// --------------------------------------------------------------------- main --

// ================================================================ agentic ==
//
// The Phase 5 demo: a bounded buyer agent shopping inside delegated authority.
//
// Five scenes, each asserted, so the demo fails loudly rather than narrating a
// success it did not have. Everything the agent does here goes through the same
// HTTP surface an external agent would use, holding only a principal — it never
// has the issuer key that delegates budget or the operator key that clears a
// pause.

const AGENT_GOAL = 'Thai curry dinner for 4, vegetarian, under 800 rupees';
const CURRY_SKU = 'SKU-THAI-CURRY-KIT';
const CURRY_PRICE_MINOR = 28_000;
const CURRY_RAISED_MINOR = 34_000;
const ENERGY_SKU = 'SKU-ENERGY-500';
const AGENT_MERCHANT = 'merchant_alpha';

interface SessionView {
  sessionId: string;
  spentMinor: number;
  reservedMinor: number;
  remaining: { amountMinor: number };
}

interface AgentRunView {
  model: string;
  outcome:
    | {
        kind: 'PURCHASE_REQUESTED';
        cart: { sku: string; quantity: number }[];
        reason: string;
        catalogVersion: string;
      }
    | { kind: 'ABANDONED'; reason: string }
    | { kind: 'FAILED'; reasonCode: string; detail: string };
  steps: {
    index: number;
    action: { action: string } | null;
    accepted: boolean;
    refusedWith: string | null;
    detail: string;
  }[];
  observed: { sku: string; name: string; category: string; indicativeUnitPriceMinor: number }[];
}

interface PurchaseView {
  authorizationId?: string;
  releaseId?: string | null;
  snapshotId?: string;
  capsuleHash?: string;
  verdict?: string;
  reasonCodes?: string[];
  state?: string | null;
  moneyMoved?: boolean;
  evidenceEnvelopeId?: string | null;
  replayedPurchase?: boolean;
  error?: string;
  message?: string;
}

/** Sets a grocery SKU's price at the merchant. Moves the world, not our copy of it. */
async function setSkuPrice(sku: string, unitPriceMinor: number): Promise<void> {
  const { status } = await call(
    'POST',
    '/v1/dev/catalog',
    { 'content-type': 'application/json' },
    { kind: 'SET_PRICE', sku, unitPriceMinor },
  );
  if (status === 404) {
    throw new DemoError(
      'The development catalogue route is not available. This demo needs PAYMENT_PROVIDER=fake ' +
        '(the default) and a non-production NODE_ENV.',
    );
  }
  assert(status === 200, `catalogue mutation failed with ${String(status)}`);
}

/** The user delegates a bounded session. The agent cannot do this for itself. */
async function delegateSession(
  totalBudgetMinor = 200_000,
  maxPerPurchaseMinor = 80_000,
): Promise<SessionView> {
  const created = await call<SessionView>('POST', '/v1/sessions', ISSUER, {
    userId: 'user_priya',
    purpose: AGENT_GOAL,
    bounds: {
      currency: 'INR',
      totalBudget: { currency: 'INR', amountMinor: totalBudgetMinor },
      maxPerPurchase: { currency: 'INR', amountMinor: maxPerPurchaseMinor },
      merchants: { mode: 'ALLOWLIST', merchantIds: [AGENT_MERCHANT] },
      allowedCategories: ['thai-meal-kit', 'groceries'],
      forbiddenCategories: [],
      itemsPerPurchase: { min: 1, max: 4 },
      recurrence: 'ONE_TIME_ONLY',
      expiresAt: '2027-01-01T00:00:00.000Z',
    },
  });
  assert(created.status === 201, `session delegation failed with ${String(created.status)}`);
  return created.body;
}

/** Headers for an agent operating inside a given session. */
function agentIn(sessionId: string): Record<string, string> {
  return { ...AGENT, 'x-capturelock-session': sessionId };
}

async function runAgent(sessionId: string): Promise<AgentRunView> {
  const run = await call<AgentRunView>(
    'POST',
    `/v1/sessions/${sessionId}/agent`,
    agentIn(sessionId),
    {
      merchantId: AGENT_MERCHANT,
      goal: AGENT_GOAL,
    },
  );
  assert(run.status === 200, `agent run failed with ${String(run.status)}`);
  return run.body;
}

async function requestPurchase(
  sessionId: string,
  lines: { sku: string; quantity: number }[],
  label: string,
  run?: AgentRunView,
  idempotencyKey?: string,
): Promise<{ status: number; body: PurchaseView }> {
  const refused = run === undefined ? 0 : run.steps.filter(s => !s.accepted).length;
  return call<PurchaseView>('POST', `/v1/sessions/${sessionId}/purchase`, agentIn(sessionId), {
    merchantId: AGENT_MERCHANT,
    lines,
    idempotencyKey: idempotencyKey ?? key(label),
    rationale:
      run !== undefined && run.outcome.kind === 'PURCHASE_REQUESTED'
        ? run.outcome.reason
        : 'Selected from the merchant catalogue for the stated goal.',
    agentModel: run?.model ?? 'deterministic-planner',
    agentSteps: run?.steps.length ?? 0,
    agentRefusedSteps: refused,
    catalogVersion:
      run !== undefined && run.outcome.kind === 'PURCHASE_REQUESTED'
        ? run.outcome.catalogVersion
        : 'unknown',
  });
}

async function authorizePayer(releaseId: string): Promise<void> {
  const simulated = await call(
    'POST',
    '/v1/dev/simulate-authorization',
    {
      'content-type': 'application/json',
    },
    { releaseId },
  );
  assert(simulated.status === 200, `payer authorization failed with ${String(simulated.status)}`);
}

async function readSession(sessionId: string): Promise<SessionView> {
  const view = await call<SessionView>('GET', `/v1/sessions/${sessionId}`, agentIn(sessionId));
  assert(view.status === 200, `session read failed with ${String(view.status)}`);
  return view.body;
}

/** Shows that the evidence chain carries the agentic context ahead of the decisions. */
async function proveAgenticEvidence(authorizationId: string): Promise<void> {
  const chain = await call<{ envelopes: { kind: string; sequence: number }[] }>(
    'GET',
    `/v1/evidence/chain/${authorizationId}`,
    {},
  );
  assert(chain.status === 200, `evidence chain read failed with ${String(chain.status)}`);

  const kinds = chain.body.envelopes.map(e => e.kind);
  assert(
    kinds[0] === 'AGENT_CONTEXT',
    `the chain should open with the agentic context, got ${kinds[0] ?? '(empty)'}`,
  );
  detail(`chain: ${kinds.join(' -> ')}`);

  const verified = await call<{ valid: boolean; verifiedCount: number }>(
    'GET',
    `/v1/evidence/chain/${authorizationId}/verify`,
    {},
  );
  assert(verified.body.valid, 'the evidence chain does not verify');
  detail(
    `${String(verified.body.verifiedCount)} envelope(s) verified: hash chain intact, signatures valid`,
  );
}

async function agentPurchase(): Promise<void> {
  // Reset the world, so the demo is the same on every run.
  await setSkuPrice(CURRY_SKU, CURRY_PRICE_MINOR);

  // ---------------------------------------------------------------- scene 1 --
  say('The user delegates a bounded commerce session');
  detail(`"${AGENT_GOAL}"`);
  const session = await delegateSession();
  detail(`session ${session.sessionId}`);
  detail(
    `budget ${inr(session.remaining.amountMinor)} total, ${inr(80_000)} per purchase, ` +
      `categories thai-meal-kit + groceries, merchant ${AGENT_MERCHANT}`,
  );
  detail(
    'The ISSUER key delegated this. The agent below holds only a principal and could not have done it.',
  );

  say('The agent goes shopping');
  const run = await runAgent(session.sessionId);
  detail(`model: ${run.model}`);
  for (const s of run.steps) {
    const label = s.action?.action ?? 'INVALID';
    const mark = s.accepted ? ' ' : '!';
    detail(`${mark} step ${String(s.index)}: ${label} — ${s.detail}`);
  }
  assert(run.outcome.kind === 'PURCHASE_REQUESTED', 'the agent did not reach a purchase request');
  if (run.outcome.kind !== 'PURCHASE_REQUESTED') return;
  const cart = run.outcome.cart;
  detail(`draft cart: ${cart.map(l => `${String(l.quantity)}x ${l.sku}`).join(', ')}`);
  detail(
    'Note the cart carries SKUs and quantities. There is no price in it for the agent to lie about.',
  );

  say('The agent asks TrueIntent to verify the purchase');
  const first = await requestPurchase(session.sessionId, cart, 'agent-buy', run);
  assert(first.status === 200, `the order gate refused: ${JSON.stringify(first.body)}`);
  verdict(GREEN, `GATE 1 (ORDER_CREATION): ${String(first.body.verdict)}`);
  detail(`server-priced, and the agent never saw the total until now`);
  detail(`capsule ${String(first.body.capsuleHash).slice(0, 16)}...`);
  const authorizationId = String(first.body.authorizationId);
  const releaseId = String(first.body.releaseId);

  say('The payer authorizes at the provider');
  await authorizePayer(releaseId);
  detail('A genuinely signed webhook, through the real webhook route.');

  say('The agent asks TrueIntent to capture');
  const captured = await call<PurchaseView>(
    'POST',
    `/v1/sessions/${session.sessionId}/capture`,
    agentIn(session.sessionId),
    { authorizationId, idempotencyKey: key('agent-capture') },
  );
  assert(captured.status === 200, `the capture gate refused: ${JSON.stringify(captured.body)}`);
  verdict(GREEN, `GATE 2 (CAPTURE): ${String(captured.body.verdict)} — money moved`);
  assert(captured.body.moneyMoved === true, 'money should have moved');

  const afterOne = await readSession(session.sessionId);
  detail(
    `session spent ${inr(afterOne.spentMinor)}, ${inr(afterOne.remaining.amountMinor)} remaining`,
  );

  await proveAgenticEvidence(authorizationId);

  // ---------------------------------------------------------------- scene 2 --
  console.info(`\n${BOLD}${YELLOW}--- SCENE 2: reality changes under the agent ---${OFF}`);

  say('The same agent builds a second cart at the price it can see');
  const secondRun = await runAgent(session.sessionId);
  assert(secondRun.outcome.kind === 'PURCHASE_REQUESTED', 'the agent should have built a cart');
  if (secondRun.outcome.kind !== 'PURCHASE_REQUESTED') return;
  detail(`the curry kit is listed at ${inr(CURRY_PRICE_MINOR)}`);

  const second = await requestPurchase(
    session.sessionId,
    [{ sku: CURRY_SKU, quantity: 1 }],
    'agent-drift',
    secondRun,
  );
  assert(
    second.status === 200,
    `the order gate refused unexpectedly: ${JSON.stringify(second.body)}`,
  );
  verdict(GREEN, `GATE 1: ${String(second.body.verdict)} — terms bound at ${inr(43_000)}`);
  const driftAuthorization = String(second.body.authorizationId);
  const driftRelease = String(second.body.releaseId);

  await authorizePayer(driftRelease);

  say('The merchant raises the price before the money moves');
  await setSkuPrice(CURRY_SKU, CURRY_RAISED_MINOR);
  detail(`${CURRY_SKU}: ${inr(CURRY_PRICE_MINOR)} -> ${inr(CURRY_RAISED_MINOR)}`);
  detail('Nothing in TrueIntent changed. The world did.');

  say('The agent tries to capture using what it learned a moment ago');
  const refusedCapture = await call<PurchaseView>(
    'POST',
    `/v1/sessions/${session.sessionId}/capture`,
    agentIn(session.sessionId),
    { authorizationId: driftAuthorization, idempotencyKey: key('agent-drift-cap') },
  );

  assert(refusedCapture.status === 422, `expected a refusal, got ${String(refusedCapture.status)}`);
  verdict(RED, `GATE 2: ${String(refusedCapture.body.verdict)}`);
  const codes = refusedCapture.body.reasonCodes ?? [];
  assert(
    codes.includes('LIVE_PRICE_DIVERGED'),
    `expected LIVE_PRICE_DIVERGED, got ${codes.join(', ')}`,
  );
  detail(`reason: ${codes.join(', ')}`);
  assert(refusedCapture.body.moneyMoved === false, 'money must not have moved');
  verdict(GREEN, 'moneyMoved: false — the provider was never asked to capture');

  const afterDrift = await readSession(session.sessionId);
  assert(
    afterDrift.spentMinor === afterOne.spentMinor,
    'a refused purchase must not consume budget',
  );
  detail(`session spend unchanged at ${inr(afterDrift.spentMinor)}; the hold was released`);

  await setSkuPrice(CURRY_SKU, CURRY_PRICE_MINOR);

  // ---------------------------------------------------------------- scene 3 --
  console.info(`\n${BOLD}${YELLOW}--- SCENE 3: the agent drifts from the intent ---${OFF}`);

  say('A confused agent proposes something numerically fine and semantically wrong');
  detail(`4x ${ENERGY_SKU} at ${inr(5_000)} + ${inr(15_000)} shipping = ${inr(35_000)}`);
  detail(`well under the ${inr(80_000)} per-purchase cap — and not a vegetarian Thai dinner`);

  const drifted = await requestPurchase(
    session.sessionId,
    [{ sku: ENERGY_SKU, quantity: 4 }],
    'agent-intent-drift',
  );
  assert(drifted.status === 422, `expected a refusal, got ${String(drifted.status)}`);
  const driftCodes = drifted.body.reasonCodes ?? [];
  verdict(RED, `REFUSED: ${drifted.body.error ?? driftCodes.join(', ')}`);
  detail(
    driftCodes.includes('INTENT_CATEGORY_MISMATCH')
      ? 'The deterministic intent stage refused it against the LIVE merchant category, not the agent’s claim about it.'
      : `Refused by the session layer before a mandate existed: ${String(drifted.body.message)}`,
  );
  assert(drifted.body.moneyMoved !== true, 'money must not have moved');

  // ---------------------------------------------------------------- scene 4 --
  console.info(`\n${BOLD}${YELLOW}--- SCENE 4: the agent retries ---${OFF}`);

  say('The agent repeats a purchase request with the same idempotency key');
  const retryKey = key('agent-retry');
  const attemptA = await requestPurchase(
    session.sessionId,
    [{ sku: CURRY_SKU, quantity: 1 }],
    'agent-retry',
    undefined,
    retryKey,
  );
  const attemptB = await requestPurchase(
    session.sessionId,
    [{ sku: CURRY_SKU, quantity: 1 }],
    'agent-retry',
    undefined,
    retryKey,
  );

  assert(attemptA.status === 200, `first attempt refused: ${JSON.stringify(attemptA.body)}`);
  assert(attemptB.status === 200, `second attempt refused: ${JSON.stringify(attemptB.body)}`);
  assert(
    attemptA.body.authorizationId === attemptB.body.authorizationId,
    'a retry must not mint a second mandate',
  );
  assert(
    attemptA.body.releaseId === attemptB.body.releaseId,
    'a retry must not create a second release',
  );
  verdict(GREEN, 'one mandate, one release, one budget hold');
  detail(`both attempts resolved to release ${String(attemptA.body.releaseId)}`);

  const purchases = await call<{ purchases: { authorizationId: string }[] }>(
    'GET',
    `/v1/sessions/${session.sessionId}/purchases`,
    agentIn(session.sessionId),
  );
  detail(`${String(purchases.body.purchases.length)} purchase(s) recorded on this session`);

  // ---------------------------------------------------------------- scene 5 --
  console.info(`\n${BOLD}${YELLOW}--- SCENE 5: the aggregate budget ---${OFF}`);

  // 700 total with a 700 per-purchase cap. One 430 cart fits; a second does
  // not, and the per-transaction cap has nothing to say about it — which is
  // exactly the gap the aggregate exists to close.
  say('A small session, to reach the budget boundary in two purchases');
  const small = await delegateSession(70_000, 70_000);
  detail(`budget ${inr(70_000)} total, ${inr(70_000)} per purchase`);

  const firstSmall = await requestPurchase(
    small.sessionId,
    [{ sku: CURRY_SKU, quantity: 1 }],
    'small-one',
  );
  assert(
    firstSmall.status === 200,
    `first small purchase refused: ${JSON.stringify(firstSmall.body)}`,
  );
  detail(`purchase 1: ${inr(43_000)} — allowed`);
  await authorizePayer(String(firstSmall.body.releaseId));
  const smallCapture = await call<PurchaseView>(
    'POST',
    `/v1/sessions/${small.sessionId}/capture`,
    agentIn(small.sessionId),
    { authorizationId: String(firstSmall.body.authorizationId), idempotencyKey: key('small-cap') },
  );
  assert(smallCapture.body.moneyMoved === true, 'the first small purchase should have captured');

  say('A second purchase, inside the per-transaction cap and outside what is left');
  const remaining = (await readSession(small.sessionId)).remaining.amountMinor;
  detail(`${inr(remaining)} remains; the next cart costs ${inr(43_000)}`);

  const secondSmall = await requestPurchase(
    small.sessionId,
    [{ sku: CURRY_SKU, quantity: 1 }],
    'small-two',
  );

  assert(secondSmall.status === 422, `expected a refusal, got ${String(secondSmall.status)}`);
  assert(
    secondSmall.body.error === 'SESSION_BUDGET_EXCEEDED',
    `expected SESSION_BUDGET_EXCEEDED, got ${String(secondSmall.body.error)}`,
  );
  verdict(RED, `REFUSED: ${String(secondSmall.body.error)}`);
  detail(String(secondSmall.body.message));
  detail(
    `${inr(43_000)} is inside the ${inr(70_000)} per-purchase cap. It is the aggregate that refuses it — ` +
      'the check a per-transaction ceiling structurally cannot make.',
  );

  console.info(`\n${BOLD}What this demonstrated${OFF}`);
  detail('A user delegated a bounded authority; the agent never held the key that created it.');
  detail('The agent chose SKUs. The server priced them. The agent could not state a total.');
  detail('The merchant changed its mind, and the capture gate refused a stale snapshot.');
  detail('An agent that drifted from the intent was refused against live merchant data.');
  detail('A retry produced one release, not two.');
  detail('The aggregate budget refused a purchase every per-transaction check would allow.');
  detail('The evidence chain opens with what the agent was trying to buy, and verifies.');
}

// =============================================================== agentic ==
//
// `pnpm demo agentic` — the canonical demonstration.
//
// One delegation, three outcomes, in the order that makes the argument:
//
//   1. AUTHORITY VIOLATION  the agent asks for something outside what it was
//                           delegated. Refused before a mandate exists, before
//                           the merchant is consulted at all.
//   2. REALITY DRIFT        the agent asks for something inside its delegation,
//                           is allowed, and the restaurant reprices before the
//                           money moves. Refused at the second gate.
//   3. THE PURCHASE         nothing is wrong, and it goes through.
//
// The two refusals are deliberately separated. Conflating them would make this
// look like one check doing double duty; they are different checks catching
// different failures at different moments, and only the second one needs the
// merchant to have changed its mind.
//
// Every step asserts. Nothing here prints a success it did not have.

const DINNER_SKU = 'SKU-THAI-DINNER-2';
const TASTING_SKU = 'SKU-THAI-DINNER-DLX';
/** 4,799 + 150 service = 4,949 all-in. */
const DINNER_UNIT_MINOR = 479_900;
/** 5,349 + 150 service = 5,499 all-in, past the 5,000 delegation. */
const DRIFTED_UNIT_MINOR = 534_900;
const SERVICE_MINOR = 15_000;
const DELEGATED_MINOR = 500_000;

interface DemoSession {
  sessionId: string;
  principal: { userId: string; sessionId: string };
  merchantId: string;
}

interface AgenticPurchase {
  authorizationId?: string;
  releaseId?: string | null;
  verdict?: string;
  reasonCodes?: string[];
  moneyMoved?: boolean;
  capsuleHash?: string;
  error?: string;
  message?: string;
}

interface TimelineView {
  session: { spentMinor: number; reservedMinor: number; remaining: { amountMinor: number } };
  purchases: {
    authorizationId: string;
    releaseId: string | null;
    state: string | null;
    moneyMoved: boolean;
    settlementState: string;
    gates: { gate: string; verdict: string; reasonCodes: string[] }[];
    evidence: { chainId: string; envelopeCount: number; kinds: string[]; valid: boolean };
  }[];
  anyMoneyMoved: boolean;
  paymentProvider: string;
}

async function setUnitPrice(sku: string, unitPriceMinor: number): Promise<void> {
  const { status } = await call(
    'POST',
    '/v1/dev/catalog',
    { 'content-type': 'application/json' },
    { kind: 'SET_PRICE', sku, unitPriceMinor },
  );
  if (status === 404) {
    throw new DemoError(
      'The development catalogue route is not available. This demo needs PAYMENT_PROVIDER=fake ' +
        '(the default) and a non-production NODE_ENV.',
    );
  }
  assert(status === 200, `catalogue mutation failed with ${String(status)}`);
}

/**
 * Delegates the session through the dev route.
 *
 * The same route the browser demo uses, and for the same reason: delegating a
 * budget is issuer authority, and the point of this system is that the agent
 * never holds it.
 */
async function delegate(): Promise<DemoSession> {
  const created = await call<DemoSession>('POST', '/v1/dev/demo-session', {
    'content-type': 'application/json',
  });
  if (created.status === 404) {
    throw new DemoError(
      'The demo-session route is not available. This demo needs PAYMENT_PROVIDER=fake and a ' +
        'non-production NODE_ENV.',
    );
  }
  assert(created.status === 201, `session delegation failed with ${String(created.status)}`);
  return created.body;
}

async function ask(
  session: DemoSession,
  sku: string,
  label: string,
  rationale: string,
): Promise<{ status: number; body: AgenticPurchase }> {
  return call<AgenticPurchase>(
    'POST',
    `/v1/sessions/${session.sessionId}/purchase`,
    agentIn(session.sessionId),
    {
      merchantId: session.merchantId,
      lines: [{ sku, quantity: 1 }],
      idempotencyKey: key(label),
      rationale,
      agentModel: 'deterministic-planner',
      agentSteps: 3,
      agentRefusedSteps: 0,
      catalogVersion: 'demo',
    },
  );
}

async function timelineOf(session: DemoSession): Promise<TimelineView> {
  const view = await call<TimelineView>(
    'GET',
    `/v1/sessions/${session.sessionId}/timeline`,
    agentIn(session.sessionId),
  );
  assert(view.status === 200, `timeline read failed with ${String(view.status)}`);
  return view.body;
}

async function agenticDemo(): Promise<void> {
  // The merchant's world, set to a known state. The drift scene moves it later.
  await setUnitPrice(DINNER_SKU, DINNER_UNIT_MINOR);

  // ---------------------------------------------------------------- setup --
  say('The user delegates a bounded commerce session');
  detail('"Thai dinner for two, under ₹5,000."');
  const session = await delegate();
  detail(`session ${session.sessionId}`);
  detail(`${inr(DELEGATED_MINOR)} total · ${inr(DELEGATED_MINOR)} per purchase · category dining`);
  detail(
    'Delegated with the ISSUER key, server-side. The agent below holds a principal and nothing else.',
  );

  say('The agent looks at what the restaurant offers');
  const run = await call<{
    model: string;
    modelLabel: string;
    modelReason: string;
    outcome: { kind: string };
    observed: { sku: string; name: string; indicativeUnitPriceMinor: number; category: string }[];
  }>('POST', `/v1/sessions/${session.sessionId}/agent`, agentIn(session.sessionId), {
    merchantId: session.merchantId,
    goal: 'Thai dinner for two under 5000 rupees',
  });
  assert(run.status === 200, `agent run failed with ${String(run.status)}`);
  detail(`model: ${run.body.modelLabel} (${run.body.model})`);
  detail(run.body.modelReason);
  const dining = run.body.observed.filter(product => product.category === 'dining');
  assert(dining.length >= 2, 'expected at least two dining candidates to compare');
  for (const product of dining) {
    detail(
      `  ${product.name} — listed ${inr(product.indicativeUnitPriceMinor)} ` +
        `(+ ${inr(SERVICE_MINOR)} service = ${inr(product.indicativeUnitPriceMinor + SERVICE_MINOR)})`,
    );
  }

  // ------------------------------------------------- 1. authority violation --
  console.info(`\n${BOLD}${YELLOW}--- 1. THE AGENT REACHES PAST ITS DELEGATION ---${OFF}`);

  say("The agent asks for the chef's tasting menu");
  detail(`${inr(649_900 + SERVICE_MINOR)} all-in, against a ${inr(DELEGATED_MINOR)} delegation`);
  const overreach = await ask(
    session,
    TASTING_SKU,
    'overreach',
    'Reached for the tasting menu despite the delegated ceiling.',
  );

  assert(overreach.status === 422, `expected a refusal, got ${String(overreach.status)}`);
  assert(
    overreach.body.error === 'SESSION_BUDGET_EXCEEDED',
    `expected SESSION_BUDGET_EXCEEDED, got ${String(overreach.body.error)}`,
  );
  verdict(RED, `REFUSED: ${String(overreach.body.error)}`);
  detail(String(overreach.body.message));
  assert(overreach.body.releaseId == null, 'no release should exist for a refused delegation');
  verdict(GREEN, 'No mandate created · the merchant was never consulted · ₹0 moved');
  detail(
    'Whether the price was right never came up. The agent was not authorized to spend that much.',
  );

  // ------------------------------------------------------- 2. reality drift --
  console.info(`\n${BOLD}${YELLOW}--- 2. REALITY CHANGES UNDER THE AGENT ---${OFF}`);

  say('The agent asks for the dinner for two, inside its delegation');
  const drift = await ask(
    session,
    DINNER_SKU,
    'drift',
    'Closest match to a Thai dinner for two, inside the delegated budget.',
  );
  assert(drift.status === 200, `the order gate refused: ${JSON.stringify(drift.body)}`);
  assert(drift.body.verdict === 'ALLOW', `expected ALLOW, got ${String(drift.body.verdict)}`);
  verdict(GREEN, `GATE 1: ALLOW — terms bound at ${inr(DINNER_UNIT_MINOR + SERVICE_MINOR)}`);
  detail('Priced by the server from a live read. The agent never stated a total.');
  detail(`capsule ${String(drift.body.capsuleHash).slice(0, 16)}…`);
  const driftAuthorization = String(drift.body.authorizationId);
  const driftRelease = String(drift.body.releaseId);

  say('The payer authorizes at the provider');
  const authorized = await call(
    'POST',
    '/v1/dev/simulate-authorization',
    {
      'content-type': 'application/json',
    },
    { releaseId: driftRelease },
  );
  assert(authorized.status === 200, `payer authorization failed with ${String(authorized.status)}`);
  detail('Funds are held. Nothing has been taken — that is what the second gate is for.');

  say('The restaurant reprices before the money moves');
  await setUnitPrice(DINNER_SKU, DRIFTED_UNIT_MINOR);
  detail(
    `${inr(DINNER_UNIT_MINOR + SERVICE_MINOR)} → ${inr(DRIFTED_UNIT_MINOR + SERVICE_MINOR)} all-in`,
  );
  detail('Nothing in TrueIntent changed. The world did.');

  say('The agent asks TrueIntent to capture');
  const refused = await call<AgenticPurchase>(
    'POST',
    `/v1/sessions/${session.sessionId}/capture`,
    agentIn(session.sessionId),
    { authorizationId: driftAuthorization, idempotencyKey: key('driftcap') },
  );

  assert(refused.status === 422, `expected a refusal, got ${String(refused.status)}`);
  const driftCodes = refused.body.reasonCodes ?? [];
  verdict(RED, `GATE 2: DENY — ${driftCodes.join(', ')}`);
  assert(
    driftCodes.includes('LIVE_PRICE_DIVERGED'),
    `expected LIVE_PRICE_DIVERGED, got ${driftCodes.join(', ')}`,
  );
  assert(refused.body.moneyMoved === false, 'money must not have moved');
  verdict(GREEN, 'moneyMoved: false — the provider was never asked to capture');

  // Restore the world before the last scene.
  await setUnitPrice(DINNER_SKU, DINNER_UNIT_MINOR);

  // -------------------------------------------------------- 3. the purchase --
  console.info(`\n${BOLD}${YELLOW}--- 3. NOTHING IS WRONG, AND IT GOES THROUGH ---${OFF}`);

  say('The agent asks again, against an unchanged menu');
  const good = await ask(
    session,
    DINNER_SKU,
    'buy',
    'Closest match to a Thai dinner for two, inside the delegated budget.',
  );
  assert(good.status === 200, `the order gate refused: ${JSON.stringify(good.body)}`);
  verdict(GREEN, `GATE 1: ${String(good.body.verdict)}`);
  const goodAuthorization = String(good.body.authorizationId);

  await call(
    'POST',
    '/v1/dev/simulate-authorization',
    { 'content-type': 'application/json' },
    {
      releaseId: String(good.body.releaseId),
    },
  );

  const captured = await call<AgenticPurchase>(
    'POST',
    `/v1/sessions/${session.sessionId}/capture`,
    agentIn(session.sessionId),
    { authorizationId: goodAuthorization, idempotencyKey: key('cap') },
  );
  assert(captured.status === 200, `the capture gate refused: ${JSON.stringify(captured.body)}`);
  assert(captured.body.moneyMoved === true, 'money should have moved');
  verdict(GREEN, `GATE 2: ALLOW — ${inr(DINNER_UNIT_MINOR + SERVICE_MINOR)} captured`);

  // ------------------------------------------------------------- the record --
  console.info(`\n${BOLD}What the server says happened${OFF}`);
  const timeline = await timelineOf(session);

  detail(`payment provider: ${timeline.paymentProvider}`);
  for (const purchase of timeline.purchases) {
    const gates = purchase.gates.map(g => `${g.gate}:${g.verdict}`).join(' → ') || 'no gate ran';
    detail(
      `${purchase.authorizationId.slice(0, 18)}… ${String(purchase.state ?? 'no release')} · ` +
        `${gates} · moneyMoved=${String(purchase.moneyMoved)} · hold=${purchase.settlementState}`,
    );
    if (purchase.evidence.envelopeCount > 0) {
      detail(`    evidence: ${purchase.evidence.kinds.join(' → ')}`);
      assert(purchase.evidence.valid, 'an evidence chain failed verification');
    }
  }

  const moved = timeline.purchases.filter(purchase => purchase.moneyMoved);
  assert(
    moved.length === 1,
    `exactly one purchase should have moved money, got ${String(moved.length)}`,
  );
  assert(
    timeline.session.spentMinor === DINNER_UNIT_MINOR + SERVICE_MINOR,
    `session spend should be ${String(DINNER_UNIT_MINOR + SERVICE_MINOR)}, got ${String(timeline.session.spentMinor)}`,
  );
  assert(
    timeline.session.reservedMinor === 0,
    `refused purchases must release their holds, ${String(timeline.session.reservedMinor)} still held`,
  );

  detail(
    `session spent ${inr(timeline.session.spentMinor)} of ${inr(DELEGATED_MINOR)} · ` +
      `${inr(timeline.session.remaining.amountMinor)} remaining · ${inr(timeline.session.reservedMinor)} held`,
  );

  console.info(`\n${BOLD}Open it in the console${OFF}`);
  detail(`agent view:    ${WEB}/#/agent/${session.sessionId}`);
  detail(`operator view: ${WEB}/#/operator`);

  console.info(`\n${BOLD}What this demonstrated${OFF}`);
  detail('An agent asked for something outside its delegation. Refused before a mandate existed.');
  detail('An agent asked for something inside it, and reality moved. Refused at the capture gate.');
  detail('Two different protections, catching two different failures, at two different moments.');
  detail('One legitimate purchase went through, and only that one consumed the budget.');
  detail('Every decision is in a signed, verified evidence chain.');
}

const DEMOS: Record<string, { title: string; run: () => Promise<void> }> = {
  drift: { title: 'Price drift: allowed at the order gate, refused at capture', run: priceDrift },
  review: { title: 'Operator review: paused, approved, and still re-verified', run: reviewFlow },
  happy: { title: 'Nominal purchase: verified twice, then captured', run: happyPath },
  agentic: {
    title: 'Agentic commerce: an AI agent shopping inside a delegated budget',
    run: agenticDemo,
  },
  // The earlier, grocery-basket telling of the same story. Kept because it
  // exercises a different delegation shape — several small purchases against an
  // aggregate — which `agentic` does not.
  agent: {
    title: 'Bounded agentic commerce: aggregate budget across several purchases',
    run: agentPurchase,
  },
};

async function main(): Promise<void> {
  const wanted = process.argv[2] ?? 'agentic';
  const demo = DEMOS[wanted];
  if (demo === undefined) {
    console.error(`No demo named "${wanted}". Available: ${Object.keys(DEMOS).join(', ')}`);
    process.exit(1);
  }

  const health = await call<{ paymentProvider: string }>('GET', '/health', {});
  console.info(`${BOLD}TrueIntent — ${demo.title}${OFF}`);
  console.info(
    `${DIM}${BASE} · payment provider: ${health.body.paymentProvider}` +
      `${health.body.paymentProvider === 'fake' ? ' (deterministic fake — no request reaches Razorpay)' : ''}${OFF}`,
  );

  await demo.run();
  console.info(`\n${GREEN}${BOLD}Every step behaved as declared.${OFF}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${RED}${BOLD}The demo did not behave as declared.${OFF}`);
  console.error(`${RED}${message}${OFF}\n`);
  process.exit(1);
});
