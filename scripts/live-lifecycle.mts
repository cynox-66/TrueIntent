/**
 * Drives the complete live lifecycle through the running API.
 *
 * Splits either side of the one step that cannot be automated: obtaining an
 * authorized payment needs hosted checkout, because Razorpay's
 * server-to-server payment APIs are not enabled on a standard account
 * (verified: `POST /v1/payments/create/upi` → "The requested URL was not found
 * on the server").
 *
 *   pnpm live:setup             create an authorization, quote and REAL order
 *                               → prints the checkout URL, then stops
 *   pnpm live:finish <release>  run the capture gate against the live provider
 *                               and report exactly what came back
 *
 * Nothing here bypasses the domain lifecycle: every call goes through the same
 * HTTP endpoints an agent would use, with the same separated authority.
 */

import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const BASE = process.env['CAPTURELOCK_BASE_URL'] ?? 'http://localhost:3000';
const AGENT = {
  'content-type': 'application/json',
  'x-capturelock-user': 'user_priya',
  'x-capturelock-session': 'sess_01',
};
const ISSUER = { ...AGENT, 'x-capturelock-issuer-key': 'dev-issuer-key-not-for-production' };

async function call(
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.status, json };
}

function line(label: string, value: unknown): void {
  console.info(
    `  ${label.padEnd(22)} ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
}

async function assertLiveProvider(): Promise<void> {
  const health = await call('GET', '/health', {});
  if (health.json['paymentProvider'] !== 'razorpay-test') {
    console.error(
      `\n  The API is running with paymentProvider="${String(health.json['paymentProvider'])}".`,
    );
    console.error('  This script verifies the LIVE provider and will not silently use the fake.');
    console.error('  Restart it with:');
    console.error(
      '    PAYMENT_PROVIDER=razorpay-test PERSISTENCE=postgres pnpm --filter @capturelock/api dev\n',
    );
    process.exit(1);
  }
}

async function setup(): Promise<void> {
  await assertLiveProvider();
  console.info('\nLive lifecycle — setup\n──────────────────────');

  const auth = await call('POST', '/v1/authorizations', ISSUER, {
    rawIntent: 'Find me the cheapest pair of black running shoes under 5,000 rupees.',
    policyId: 'household_default',
    policyVersion: '1.0.0',
    constraints: {
      currency: 'INR',
      maxTotal: { currency: 'INR', amountMinor: 500_000 },
      maxUnitPrice: { currency: 'INR', amountMinor: 500_000 },
      quantity: { min: 1, max: 1 },
      allowedCategories: ['footwear'],
      forbiddenCategories: [],
      requiredAttributes: [{ name: 'colour', anyOf: ['black'] }],
      forbiddenAttributes: [{ name: 'colour', anyOf: ['white'] }],
      merchants: { mode: 'ALLOWLIST', merchantIds: ['merchant_alpha'] },
      fees: {
        maxShipping: { currency: 'INR', amountMinor: 20_000 },
        maxTax: null,
        maxTip: { currency: 'INR', amountMinor: 10_000 },
        maxConvenienceFee: null,
        maxTotalFees: { currency: 'INR', amountMinor: 30_000 },
      },
      recurrence: 'ONE_TIME_ONLY',
      geography: { allowedCountries: ['IN'], allowedRegions: null },
      maxSnapshotAgeSeconds: 3_600,
      notBefore: '2020-01-01T00:00:00.000Z',
      notAfter: '2099-01-01T00:00:00.000Z',
    },
    normalization: { method: 'MANUAL', modelId: null, confirmedByUser: true },
  });
  if (auth.status !== 201) {
    console.error('  authorization failed:', auth.json);
    process.exit(1);
  }
  const authorizationId = String(auth.json['authorizationId']);
  line('authorization', authorizationId);

  const quote = await call('POST', `/v1/authorizations/${authorizationId}/quotes`, AGENT, {
    merchantId: 'merchant_alpha',
    lines: [{ sku: 'SKU-BLK-RUN-42', quantity: 1 }],
    shipTo: { country: 'IN', region: null },
    recurring: false,
  });
  if (quote.status !== 201) {
    console.error('  quote failed:', quote.json);
    process.exit(1);
  }
  const total = (quote.json['total'] as { amountMinor: number }).amountMinor;
  line('quote total', `INR ${(total / 100).toFixed(2)} (server-priced from live state)`);

  const release = await call('POST', '/v1/releases', AGENT, {
    authorizationId,
    snapshotId: quote.json['snapshotId'],
    idempotencyKey: `idem-live-${Date.now()}`,
  });
  line('gate 1 verdict', String(release.json['verdict']));
  if (release.json['verdict'] !== 'ALLOW') {
    console.error('  reason codes:', release.json['reasonCodes']);
    process.exit(1);
  }
  const releaseId = String(release.json['releaseId']);
  line('release', releaseId);
  line('Razorpay order', String(release.json['providerOrderId']));
  line('money moved', String(release.json['moneyMoved']));

  console.info('\n  ── YOUR STEP ───────────────────────────────────────────────────────');
  console.info(`   1. open   ${BASE}/v1/dev/checkout/${releaseId}`);
  console.info("   2. pay with Razorpay's published TEST card:");
  console.info('        4100 2800 0000 1007 · any future expiry · any CVV · OTP: any 4–10 digits');
  console.info("        (Razorpay's published DOMESTIC Visa test card. A generic number such as");
  console.info('         4111 1111 1111 1111 is international and is refused by domestic-only accounts.)');
  console.info('   3. Razorpay sends payment.authorized to the webhook; then run:');
  console.info(`        pnpm live:finish ${releaseId}`);
  console.info('  ────────────────────────────────────────────────────────────────────');
  console.info('\n  Test mode. No real money moves.\n');
}

async function finish(releaseId: string): Promise<void> {
  await assertLiveProvider();
  console.info('\nLive lifecycle — capture gate\n─────────────────────────────');

  const before = await call('GET', `/v1/releases/${releaseId}`, AGENT);
  if (before.status !== 200) {
    console.error('  release not found:', before.json);
    process.exit(1);
  }
  const release = before.json['release'] as Record<string, unknown>;
  line('state before', String(release['state']));
  line('provider payment', String(release['providerPaymentId'] ?? '(none yet)'));

  if (release['state'] !== 'PAYMENT_AUTHORIZED') {
    console.error(`\n  The release is "${String(release['state'])}", not PAYMENT_AUTHORIZED.`);
    if (release['providerPaymentId'] === null) {
      console.error('  No payment.authorized webhook has arrived. Either the checkout has not');
      console.error('  been completed, or the tunnel is not reaching this API. Check:');
      console.error('    curl -H "ngrok-skip-browser-warning: 1" <tunnel>/health');
    }
    if (release['state'] === 'CAPTURED' || release['state'] === 'SETTLED') {
      console.error('  It is already captured — which, if you did not run this, would mean the');
      console.error('  order auto-captured and payment_capture: 0 did NOT take effect. That is');
      console.error('  a finding: record it.');
    }
    process.exit(1);
  }

  console.info('\n  Running the capture gate. The kernel re-reads live merchant state and');
  console.info('  re-verifies before any money moves.\n');

  const capture = await call('POST', `/v1/releases/${releaseId}/capture`, AGENT, {
    idempotencyKey: `idem-cap-${Date.now()}`,
  });
  line('HTTP', capture.status);
  line('verdict', String(capture.json['verdict']));
  line('state', String(capture.json['state']));
  line('money moved', String(capture.json['moneyMoved']));
  line('reason codes', capture.json['reasonCodes']);

  // A second attempt: the state machine must refuse it.
  const again = await call('POST', `/v1/releases/${releaseId}/capture`, AGENT, {
    idempotencyKey: `idem-cap-again-${Date.now()}`,
  });
  console.info('\n  Second capture attempt (must not reach the provider):');
  line('HTTP', again.status);
  line('verdict', String(again.json['verdict']));
  line('reason codes', again.json['reasonCodes']);

  const after = await call('GET', `/v1/releases/${releaseId}`, AGENT);
  const evaluations = after.json['evaluations'] as { gate: string; verdict: string }[];
  console.info('\n  Evaluations recorded:');
  for (const e of evaluations) console.info(`    ${e.gate.padEnd(16)} ${e.verdict}`);

  console.info('\n  Verify the evidence chain:');
  console.info(
    `    curl -s ${BASE}/v1/evidence/chain/${String(release['authorizationId'])}/verify\n`,
  );
}

const command = process.argv[2];
if (command === 'setup') void setup();
else if (command === 'finish' && process.argv[3] !== undefined) void finish(process.argv[3]);
else {
  console.error('usage: pnpm live:setup   |   pnpm live:finish <releaseId>');
  process.exit(1);
}
