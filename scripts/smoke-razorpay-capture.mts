/**
 * Live capture verification against real Razorpay TEST MODE.
 *
 * Phase 2 measured Razorpay's *order* semantics and found two documented
 * behaviours to be false. The capture half was left unverified, and this script
 * closes that gap: it establishes empirically what the API does on a first
 * capture, a duplicate capture, and an invalid capture, and checks our adapter
 * maps each outcome correctly.
 *
 * It is opt-in, it refuses anything that is not a test key, and it never falls
 * back to the fake provider — a script whose purpose is live verification must
 * fail loudly rather than quietly verify nothing.
 *
 * ONE HUMAN STEP IS UNAVOIDABLE. Razorpay's server-to-server payment APIs are
 * not enabled on a standard account (verified: `POST /v1/payments/create/upi`
 * returns "The requested URL was not found on the server"), so an authorized
 * payment can only be produced through hosted checkout. The script stops at
 * exactly that point, prints the next action, and resumes automatically once a
 * payment exists on the order. Faking the payment and calling the result "live
 * capture verification" would defeat the purpose.
 *
 *   pnpm smoke:razorpay:capture           # create an order, then wait for payment
 *   pnpm smoke:razorpay:capture <orderId> # resume against an existing order
 */

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { RazorpayConfigSchema, RazorpayTestClient } from '@capturelock/integrations';
import { money, type Receipt } from '@capturelock/core';

const BASE = 'https://api.razorpay.com';
const AMOUNT_MINOR = 10_000; // INR 100.00

interface Observation {
  readonly step: string;
  readonly method: string;
  readonly path: string;
  readonly status: number | string;
  /** Response body with anything sensitive removed. */
  readonly body: unknown;
  readonly note?: string;
}

const observations: Observation[] = [];

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    console.error(`\n  ${name} is not set.`);
    console.error(
      '  This script verifies the LIVE Razorpay API and will not fall back to the fake',
    );
    console.error('  provider. Set it in .env and re-run.\n');
    process.exit(1);
  }
  return value;
}

/**
 * Strips anything that could carry a credential before a body is recorded.
 *
 * Razorpay echoes card and contact details on a payment object. None of it is
 * needed to establish capture semantics, and a findings file is something that
 * gets pasted into reports.
 */
function redact(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body;
  if (Array.isArray(body)) return body.map(redact);
  const out: Record<string, unknown> = {};
  const drop = new Set([
    'card',
    'card_id',
    'token_id',
    'vpa',
    'email',
    'contact',
    'customer_id',
    'bank',
    'wallet',
    'acquirer_data',
    'notes',
  ]);
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    out[key] = drop.has(key) ? '<redacted>' : redact(value);
  }
  return out;
}

class Api {
  constructor(private readonly authorization: string) {}

  async call(
    step: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: this.authorization,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      json = { '<unparseable>': true };
    }
    observations.push({ step, method, path, status: response.status, body: redact(json) });
    return { status: response.status, json };
  }
}

function heading(text: string): void {
  console.info(`\n${text}\n${'─'.repeat(text.length)}`);
}

function show(label: string, value: unknown): void {
  console.info(
    `  ${label.padEnd(34)} ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
}

async function main(): Promise<void> {
  const keyId = required('RAZORPAY_KEY_ID');
  const keySecret = required('RAZORPAY_KEY_SECRET');

  // Guard, before anything reaches the network. The schema refuses a live key;
  // this refuses anything that is not explicitly a test key, including a
  // malformed one.
  if (!keyId.startsWith('rzp_test_')) {
    console.error(`\n  Refusing to run: RAZORPAY_KEY_ID does not begin with rzp_test_.`);
    console.error(
      '  This script creates orders and captures payments. It runs in test mode only.\n',
    );
    process.exit(1);
  }
  const config = RazorpayConfigSchema.parse({
    keyId,
    keySecret,
    webhookSecret: process.env['RAZORPAY_WEBHOOK_SECRET'] ?? 'unused-by-this-script',
  });

  const api = new Api(`Basic ${Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64')}`);
  // The same adapter the application uses, so mapping is verified rather than
  // assumed from the raw responses.
  const adapter = new RazorpayTestClient(config);

  heading('CaptureLock — live Razorpay capture verification (TEST MODE)');
  show('key', `${keyId.slice(0, 12)}…`);

  // ---- 1. an order that must be captured manually --------------------------
  let orderId = process.argv[2];
  // Razorpay requires the capture amount to equal the authorized amount, so it
  // is read from the order rather than assumed. Resuming against an order
  // created by the API (INR 4,949) with this file's constant would simply be
  // rejected, and the rejection would look like a capture-semantics finding
  // when it was only a bug here.
  let amountMinor = AMOUNT_MINOR;

  if (orderId === undefined) {
    heading('1. Create an order with payment_capture = 0');
    const receipt = `cl_cap_${randomUUID().replace(/-/g, '').slice(0, 18)}` as Receipt;
    const created = await adapter.createOrder({
      receipt,
      amount: money('INR', AMOUNT_MINOR),
      notes: { purpose: 'capturelock-live-capture-verification' },
    });
    if (created.kind !== 'CREATED') {
      console.error(`  order creation returned ${created.kind}; cannot continue.`);
      process.exit(1);
    }
    orderId = created.order.orderId;
    show('order', orderId);
    show('amount', `INR ${(AMOUNT_MINOR / 100).toFixed(2)}`);
    show('receipt', receipt);
    console.info(
      '\n  Created through the application adapter, which now sends payment_capture: 0.',
    );
    console.info('  Without it the account default may auto-capture, and the capture gate');
    console.info('  would have nothing left to gate.');
  } else {
    heading(`1. Resuming against order ${orderId}`);
    const existing = await api.call('read order', 'GET', `/v1/orders/${orderId}`);
    if (existing.status !== 200) {
      console.error(`  Could not read order ${orderId} (HTTP ${existing.status}).`);
      process.exit(1);
    }
    amountMinor = Number(existing.json['amount']);
    show('order', orderId);
    show('amount', `INR ${(amountMinor / 100).toFixed(2)}`);
    show('order.status', String(existing.json['status']));
  }

  // ---- 2. wait for a payment (the human step) ------------------------------
  heading('2. Obtain an authorized payment');
  const found = await waitForPayment(api, orderId);
  if (found === null) {
    printHumanStep(keyId, orderId, amountMinor);
    writeFindings();
    process.exit(2);
  }

  const paymentId = String(found['id']);
  show('payment', paymentId);
  show('status BEFORE capture', String(found['status']));
  show('captured flag', String(found['captured']));
  show('amount', String(found['amount']));

  if (found['status'] !== 'authorized') {
    console.error(`\n  Payment is "${String(found['status'])}", not "authorized".`);
    if (found['status'] === 'captured') {
      console.error('  It was auto-captured, which means payment_capture: 0 did NOT take effect.');
      console.error('  That is a finding in itself: record it and do not proceed.');
    }
    writeFindings();
    process.exit(1);
  }

  // ---- 3. first capture ----------------------------------------------------
  heading('3. First capture');
  const first = await api.call('capture #1', 'POST', `/v1/payments/${paymentId}/capture`, {
    amount: amountMinor,
    currency: 'INR',
  });
  show('HTTP', first.status);
  show('status', String(first.json['status'] ?? '-'));
  show('captured', String(first.json['captured'] ?? '-'));
  show('amount_captured', String(first.json['amount'] ?? '-'));

  // ---- 4. state after capture ---------------------------------------------
  heading('4. Payment and order state after capture');
  const afterPayment = await api.call('read payment', 'GET', `/v1/payments/${paymentId}`);
  show('payment.status', String(afterPayment.json['status']));
  show('payment.captured', String(afterPayment.json['captured']));
  const afterOrder = await api.call('read order', 'GET', `/v1/orders/${orderId}`);
  show('order.status', String(afterOrder.json['status']));
  show('order.amount_paid', String(afterOrder.json['amount_paid']));

  // ---- 5. DUPLICATE capture — the critical experiment ----------------------
  heading('5. Duplicate capture (the critical experiment)');
  const second = await api.call('capture #2', 'POST', `/v1/payments/${paymentId}/capture`, {
    amount: amountMinor,
    currency: 'INR',
  });
  const err = second.json['error'] as Record<string, unknown> | undefined;
  show('HTTP', second.status);
  show('error.code', String(err?.['code'] ?? '(no error envelope)'));
  show('error.description', String(err?.['description'] ?? '-'));
  show('error.reason', String(err?.['reason'] ?? '-'));

  // Did the money move twice?
  const afterDuplicate = await api.call(
    'read payment after dup',
    'GET',
    `/v1/payments/${paymentId}`,
  );
  show('payment.amount after dup', String(afterDuplicate.json['amount']));
  show('payment.status after dup', String(afterDuplicate.json['status']));

  // ---- 6. does OUR adapter map the duplicate correctly? --------------------
  heading('6. Adapter mapping of the duplicate');
  const mapped = await adapter.capturePayment({
    paymentId,
    amount: money('INR', amountMinor),
  });
  show('adapter outcome', mapped.kind);
  const correct = mapped.kind === 'ALREADY_CAPTURED';
  show('maps to ALREADY_CAPTURED?', correct ? 'YES' : `NO — got ${mapped.kind}`);
  if (!correct) {
    console.error('\n  The adapter does NOT recognise this response as an already-captured');
    console.error('  payment. Left uncorrected it would record a completed capture as a');
    console.error('  failure, or drive a retry. The prose markers in client.ts need the');
    console.error('  exact description observed above.');
  }
  observations.push({
    step: 'adapter mapping',
    method: '-',
    path: '-',
    status: mapped.kind,
    body: { mapsToAlreadyCaptured: correct },
  });

  // ---- 7. invalid capture --------------------------------------------------
  heading('7. Invalid capture (wrong amount on a captured payment)');
  const wrong = await api.call(
    'capture wrong amount',
    'POST',
    `/v1/payments/${paymentId}/capture`,
    {
      amount: amountMinor * 3,
      currency: 'INR',
    },
  );
  const wrongErr = wrong.json['error'] as Record<string, unknown> | undefined;
  show('HTTP', wrong.status);
  show('error.code', String(wrongErr?.['code'] ?? '(no error envelope)'));
  show('error.description', String(wrongErr?.['description'] ?? '-'));

  writeFindings();
  heading('Done');
  console.info('  Findings written to reports/razorpay-capture-findings.json');
  console.info(`  No further money can move: payment ${paymentId} is terminal.\n`);
  if (!correct) process.exit(1);
}

/**
 * Polls the order for a payment.
 *
 * Returns null if none appears, which is the signal that the human step has not
 * happened yet. Deliberately short: this script is not a daemon.
 */
async function waitForPayment(
  api: Api,
  orderId: string,
  attempts = 3,
): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < attempts; i += 1) {
    const result = await api.call('poll order payments', 'GET', `/v1/orders/${orderId}/payments`);
    const items = (result.json['items'] as Record<string, unknown>[] | undefined) ?? [];
    if (items.length > 0) return items[items.length - 1]!;
    if (i < attempts - 1) {
      console.info(`  no payment yet (attempt ${i + 1}/${attempts}); waiting 5s…`);
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
  }
  return null;
}

function printHumanStep(keyId: string, orderId: string, amountMinor: number): void {
  const page = buildCheckoutPage(keyId, orderId, amountMinor);
  writeFileSync('reports/checkout.html', page, 'utf8');

  console.info('\n  No payment on this order yet. One human step is required, because');
  console.info('  Razorpay does not expose server-side payment creation on this account.');
  console.info('\n  ── DO THIS ─────────────────────────────────────────────────────────');
  console.info('   1. open  reports/checkout.html  in a browser');
  console.info("   2. pay with Razorpay's published TEST card:");
  console.info('        card    4100 2800 0000 1007   (DOMESTIC Visa — see note)');
  console.info('        expiry  any future date        CVV  any 3 digits');
  console.info('        OTP     any 4–10 digits       (under 4 digits fails on purpose)');
  console.info('   3. re-run, resuming against this order:');
  console.info(`        pnpm smoke:razorpay:capture ${orderId}`);
  console.info('  ────────────────────────────────────────────────────────────────────');
  console.info("\n  Test mode: no real money moves. The card above is Razorpay's own");
  console.info('  published test number, not a real card.\n');
}

/** A minimal Razorpay Checkout page bound to one order. */
function buildCheckoutPage(keyId: string, orderId: string, amountMinor: number): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>CaptureLock — live capture verification</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.5rem; }
  code { background: #f4f4f5; padding: .15em .4em; border-radius: 4px; }
  button { font: inherit; padding: .7em 1.4em; border: 0; border-radius: 6px;
           background: #0b5fff; color: #fff; cursor: pointer; }
  .warn { background: #fff8e1; border-left: 3px solid #f5a623; padding: .8rem 1rem; margin: 1.5rem 0; }
</style>
<h1>Live capture verification</h1>
<p>Order <code>${orderId}</code> — INR ${(amountMinor / 100).toFixed(2)}, created with
   <code>payment_capture: 0</code> so it must be captured manually.</p>
<div class="warn">
  <strong>Razorpay TEST MODE.</strong> No real money moves.<br>
  Card <code>4100 2800 0000 1007</code>, any future expiry, any CVV, OTP: any 4–10 digits.<br>
  <small>Razorpay's published <strong>domestic</strong> Visa test card. Generic numbers such as
  4111&nbsp;1111&nbsp;1111&nbsp;1111 are classified <code>international: true</code> and are refused
  by accounts that accept domestic cards only.</small>
</div>
<button id="pay">Pay with Razorpay</button>
<p id="out"></p>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
  document.getElementById('pay').onclick = function () {
    new Razorpay({
      key: ${JSON.stringify(keyId)},
      order_id: ${JSON.stringify(orderId)},
      name: 'CaptureLock',
      description: 'Live capture verification (test mode)',
      handler: function (r) {
        document.getElementById('out').textContent =
          'Payment ' + r.razorpay_payment_id + ' created. Now re-run the smoke script.';
      },
    }).open();
  };
</script>
`;
}

function writeFindings(): void {
  writeFileSync(
    'reports/razorpay-capture-findings.json',
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        mode: 'razorpay-test',
        note: 'Observed against one test account. Test mode only; no production claim.',
        observations,
      },
      null,
      2,
    ),
    'utf8',
  );
}

void main();
