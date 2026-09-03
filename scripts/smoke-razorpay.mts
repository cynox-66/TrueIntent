/**
 * Opt-in smoke test against real Razorpay TEST MODE.
 *
 * Confirms the two API behaviours the entire recovery design rests on. Both
 * were established from the published documentation during Phase 1; this
 * verifies them against the running API, because a recovery path built on a
 * misread contract is worse than no recovery path.
 *
 *   1. Whether a duplicate `receipt` is rejected. The published documentation
 *      calls it an idempotency key; measured reality on a default account is
 *      that duplicates are ACCEPTED and a second order is created. Rejection is
 *      an opt-in dashboard setting. This check reports what the account
 *      actually does rather than asserting either answer.
 *   2. Whether `GET /v1/orders?receipt=` finds the order, and how quickly.
 *      Measured reality: eventually consistent — empty immediately after the
 *      create, populated seconds later. That is why reconciliation treats an
 *      empty lookup as inconclusive rather than as proof of absence.
 *
 * Both findings are recorded in ADR-015.
 *
 * It creates real test-mode orders. It never captures, so no money moves even
 * in test mode. Run with:  pnpm smoke:razorpay
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { RazorpayTestClient, RazorpayConfigSchema } from '@capturelock/integrations';
import { money, type Receipt } from '@capturelock/core';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    console.error(`${name} is not set. This script needs real Razorpay TEST MODE credentials.`);
    console.error('It will not invent them, and it will not fall back to the fake provider.');
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const config = RazorpayConfigSchema.parse({
    keyId: required('RAZORPAY_KEY_ID'),
    keySecret: required('RAZORPAY_KEY_SECRET'),
    webhookSecret: process.env['RAZORPAY_WEBHOOK_SECRET'] ?? 'unused-by-this-script',
  });

  const client = new RazorpayTestClient(config);
  // Distinct per run: a receipt is an idempotency token, and reusing one across
  // runs would make step 1 pass for the wrong reason.
  const receipt = `cl_smoke_${randomUUID().replace(/-/g, '').slice(0, 20)}` as Receipt;
  const amount = money('INR', 100_00);

  console.info(`Razorpay TEST MODE smoke test`);
  console.info(`  key      ${config.keyId.slice(0, 12)}…`);
  console.info(`  receipt  ${receipt}\n`);

  let failures = 0;
  const check = (label: string, ok: boolean, detail: string): void => {
    console.info(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    console.info(`        ${detail}`);
    if (!ok) failures += 1;
  };

  // ---- 1. create -----------------------------------------------------------
  const first = await client.createOrder({
    receipt,
    amount,
    notes: { source: 'capturelock-smoke' },
  });
  check(
    'orders.create succeeds',
    first.kind === 'CREATED',
    first.kind === 'CREATED' ? `order ${first.order.orderId}` : `got ${first.kind}`,
  );
  if (first.kind !== 'CREATED') {
    console.error('\nCannot continue without an order.');
    process.exit(1);
  }

  // ---- 2. duplicate receipt: report, do not assume -------------------------
  const second = await client.createOrder({ receipt, amount, notes: {} });
  const rejectsDuplicates = second.kind === 'DUPLICATE_RECEIPT';
  console.info(`  INFO  duplicate receipt -> ${second.kind}`);
  console.info(
    rejectsDuplicates
      ? '        this account has "prevent duplicate order with same receipt" ENABLED'
      : '        this account ACCEPTS duplicates: a retried create makes a SECOND order,\n' +
          '        which is why the release machine has no edge that retries a create',
  );

  // ---- 3. lookup consistency ----------------------------------------------
  const immediate = await client.findOrderByReceipt(receipt);
  console.info(
    `  INFO  lookup immediately after create -> ${immediate === null ? 'not found' : 'found'}`,
  );
  if (immediate === null) {
    console.info('        the receipt index lags the write, as reconciliation assumes');
  }

  // Poll for the lag window, which is the behaviour reconciliation is built on.
  let found = immediate;
  const deadline = Date.now() + 30_000;
  while (found === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    found = await client.findOrderByReceipt(receipt);
  }

  check(
    'the order becomes recoverable by receipt lookup',
    found !== null,
    found === null
      ? 'NEVER FOUND within 30s — an order whose response was lost would be unrecoverable'
      : `found ${found.orderId} after the index caught up`,
  );

  // ---- 4. amount fidelity --------------------------------------------------
  check(
    'the amount round-trips exactly in minor units',
    found?.amount.amountMinor === amount.amountMinor && found?.amount.currency === 'INR',
    `sent ${amount.amountMinor}, read back ${String(found?.amount.amountMinor)}`,
  );

  console.info('');
  if (failures > 0) {
    console.error(
      `${failures} check(s) failed. The fake provider models behaviour the real API does not.`,
    );
    process.exit(1);
  }
  console.info('All checks passed. The deterministic fake models these semantics.');
  console.info('No capture was attempted, so no money moved.');
}

void main();
