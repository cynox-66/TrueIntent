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

/** An agent holds a principal and nothing else. */
const AGENT = {
  'content-type': 'application/json',
  'x-capturelock-user': 'user_priya',
  'x-capturelock-session': 'sess_01',
};
/** The trusted user-facing application. An agent never has this. */
const ISSUER = {
  ...AGENT,
  'x-capturelock-issuer-key':
    process.env['ISSUER_API_KEY'] ?? 'dev-issuer-key-not-for-production',
};
/** A human operator's console. An agent never has this either. */
const OPERATOR = {
  'content-type': 'application/json',
  'x-capturelock-operator-key':
    process.env['OPERATOR_API_KEY'] ?? 'dev-operator-key-not-for-prod',
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
  const { status } = await call('POST', '/v1/dev/catalog', { 'content-type': 'application/json' }, {
    kind: 'SET_PRICE',
    sku: SKU,
    unitPriceMinor,
  });
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

  say('The agent proposes SKUs. CaptureLock prices the cart from live merchant state.');
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

  say('The merchant raises the price. CaptureLock is told nothing.');
  await setPrice(RAISED_PRICE_MINOR);
  detail(
    `${inr(LIST_PRICE_MINOR)} → ${inr(RAISED_PRICE_MINOR)} in the merchant's catalogue. ` +
      'CaptureLock finds out on its next live read, which is the whole point.',
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
  assert(capture.body.verdict === 'ALLOW', `gate 2 refused: ${capture.body.reasonCodes.join(', ')}`);
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
  assert(again.body.verdict === 'DENY', `a duplicate capture was not refused: ${again.body.verdict}`);
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
  assert(orderReview !== null && orderReview !== undefined, 'the paused release has no open review');
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
  assert(created.body.verdict === 'ALLOW', `gate 1 retry refused: ${created.body.reasonCodes.join(', ')}`);
  verdict(GREEN, `ALLOW → ${created.body.state} (${created.body.reasonCodes.join(', ')})`);

  await call('POST', '/v1/dev/simulate-authorization', { 'content-type': 'application/json' }, {
    releaseId: paused.body.releaseId,
  });

  say('Gate 2 pauses too. The order-gate approval does not carry across the gate.');
  const capturePaused = await call<{ verdict: string; reasonCodes: string[]; moneyMoved: boolean }>(
    'POST',
    `/v1/releases/${paused.body.releaseId}/capture`,
    AGENT,
    { idempotencyKey: key('review-cap-1') },
  );
  assert(capturePaused.body.verdict === 'PAUSE', `expected PAUSE, got ${capturePaused.body.verdict}`);
  assert(!capturePaused.body.moneyMoved, 'money moved on a paused capture');
  verdict(YELLOW, `PAUSE (${capturePaused.body.reasonCodes.join(', ')})`);
  detail('An approval names the gate it was given at. This one was never shown to a human.');

  say('The operator approves the capture-gate pause.');
  const queue2 = await call<{
    items: { releaseId: string; review: { reviewId: string } | null }[];
  }>('GET', '/v1/operator/queue', OPERATOR);
  const captureReview = queue2.body.items.find(
    i => i.releaseId === paused.body.releaseId,
  )?.review;
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
  assert(captured.body.verdict === 'ALLOW', `gate 2 retry refused: ${captured.body.reasonCodes.join(', ')}`);
  assert(captured.body.moneyMoved, 'the approved capture did not move money');
  verdict(GREEN, `ALLOW → ${captured.body.state}, moneyMoved: true`);
  detail('The approval authorized re-verification. The kernel still had the last word.');

  await proveIt(auth.body.authorizationId, captured.body.evidenceEnvelopeId);
}

// --------------------------------------------------------------------- main --

const DEMOS: Record<string, { title: string; run: () => Promise<void> }> = {
  drift: { title: 'Price drift: allowed at the order gate, refused at capture', run: priceDrift },
  review: { title: 'Operator review: paused, approved, and still re-verified', run: reviewFlow },
  happy: { title: 'Nominal purchase: verified twice, then captured', run: happyPath },
};

async function main(): Promise<void> {
  const wanted = process.argv[2] ?? 'drift';
  const demo = DEMOS[wanted];
  if (demo === undefined) {
    console.error(`No demo named "${wanted}". Available: ${Object.keys(DEMOS).join(', ')}`);
    process.exit(1);
  }

  const health = await call<{ paymentProvider: string }>('GET', '/health', {});
  console.info(`${BOLD}CaptureLock — ${demo.title}${OFF}`);
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
