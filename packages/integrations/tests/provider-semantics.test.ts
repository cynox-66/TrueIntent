/**
 * Tests that the fake provider reproduces Razorpay's real semantics.
 *
 * These matter more than they look. If the fake were forgiving where Razorpay
 * is strict, every downstream test about recovery and duplicate prevention
 * would be passing against a world that does not exist.
 */

import { describe, it, expect } from 'vitest';
import { asTimestamp, money, type Receipt } from '@capturelock/core';
import { FakePaymentProvider } from '../src/razorpay/fake.js';

const AT = asTimestamp('2026-09-03T10:00:00.000Z');
const receipt = (value: string): Receipt => value as Receipt;
const inr = (minor: number) => money('INR', minor);

function newProvider(): FakePaymentProvider {
  return new FakePaymentProvider({ clock: () => AT });
}

describe('order creation', () => {
  it('creates an order and echoes the receipt', async () => {
    const provider = newProvider();
    const outcome = await provider.createOrder({
      receipt: receipt('cl_abc'),
      amount: inr(494_900),
      notes: {},
    });
    expect(outcome.kind).toBe('CREATED');
  });

  it('ACCEPTS a duplicate receipt by default, creating a second order', async () => {
    // Measured against real Razorpay test mode: two creates with the same
    // receipt both succeed and produce two distinct orders. The documentation
    // describes `receipt` as an idempotency key, but rejection is an opt-in
    // account setting that is off by default.
    //
    // The consequence the whole recovery design turns on: retrying a create
    // after a lost response does NOT return the original order, it makes a
    // second one. See ADR-015.
    const provider = newProvider();
    await provider.createOrder({ receipt: receipt('cl_abc'), amount: inr(100), notes: {} });
    const second = await provider.createOrder({
      receipt: receipt('cl_abc'),
      amount: inr(100),
      notes: {},
    });
    expect(second.kind).toBe('CREATED');
    expect(provider.orderCount()).toBe(2);
  });

  it('rejects a duplicate receipt when the account setting is enabled', async () => {
    const provider = new FakePaymentProvider({ clock: () => AT, rejectDuplicateReceipt: true });
    await provider.createOrder({ receipt: receipt('cl_abc'), amount: inr(100), notes: {} });
    const second = await provider.createOrder({
      receipt: receipt('cl_abc'),
      amount: inr(100),
      notes: {},
    });
    expect(second.kind).toBe('DUPLICATE_RECEIPT');
    expect(provider.orderCount()).toBe(1);
  });

  it('models an eventually consistent receipt lookup', async () => {
    // Real Razorpay returned nothing from the receipt filter immediately after
    // a create, and the order some seconds later. A fake that was immediately
    // consistent would hide the hazard that an empty read is not proof of
    // absence.
    const provider = new FakePaymentProvider({
      clock: () => AT,
      lookupImmediatelyConsistent: false,
    });
    await provider.createOrder({ receipt: receipt('cl_lag'), amount: inr(100), notes: {} });

    expect(await provider.findOrderByReceipt(receipt('cl_lag'))).toBeNull();
    provider.indexPendingReceipts();
    expect(await provider.findOrderByReceipt(receipt('cl_lag'))).not.toBeNull();
  });

  it('recovers a lost order by receipt lookup', async () => {
    const provider = newProvider();
    provider.failNextOrderWith('TIMEOUT_AFTER_APPLY');

    const outcome = await provider.createOrder({
      receipt: receipt('cl_lost'),
      amount: inr(100),
      notes: {},
    });
    expect(outcome.kind).toBe('INDETERMINATE');

    // The order exists even though the caller never saw the response.
    const found = await provider.findOrderByReceipt(receipt('cl_lost'));
    expect(found).not.toBeNull();
    expect(provider.orderCount()).toBe(1);
  });

  it('reports nothing found when the create never landed', async () => {
    const provider = newProvider();
    provider.failNextOrderWith('TIMEOUT_BEFORE_APPLY');

    const outcome = await provider.createOrder({
      receipt: receipt('cl_never'),
      amount: inr(100),
      notes: {},
    });
    expect(outcome.kind).toBe('INDETERMINATE');
    expect(await provider.findOrderByReceipt(receipt('cl_never'))).toBeNull();
    expect(provider.orderCount()).toBe(0);
  });
});

describe('capture', () => {
  it('captures an authorized payment exactly once', async () => {
    const provider = newProvider();
    const payment = provider.seedAuthorizedPayment('order_1', inr(494_900));

    const outcome = await provider.capturePayment({
      paymentId: payment.paymentId,
      amount: inr(494_900),
    });
    expect(outcome.kind).toBe('CAPTURED');
    expect(provider.capturedCount()).toBe(1);
  });

  it('is NOT idempotent: a second capture reports ALREADY_CAPTURED', async () => {
    const provider = newProvider();
    const payment = provider.seedAuthorizedPayment('order_1', inr(100));
    await provider.capturePayment({ paymentId: payment.paymentId, amount: inr(100) });

    const second = await provider.capturePayment({
      paymentId: payment.paymentId,
      amount: inr(100),
    });
    expect(second.kind).toBe('ALREADY_CAPTURED');
    // Crucially the money moved only once, even though the caller was told
    // something that reads like an error.
    expect(provider.capturedCount()).toBe(1);
  });

  it('refuses a payment that is not in the authorized state', async () => {
    const provider = newProvider();
    provider.seedPayment({
      paymentId: 'pay_failed',
      orderId: 'order_1',
      amount: inr(100),
      status: 'failed',
    });
    const outcome = await provider.capturePayment({ paymentId: 'pay_failed', amount: inr(100) });
    expect(outcome).toEqual({ kind: 'NOT_CAPTURABLE', providerStatus: 'failed' });
  });

  it('refuses a capture amount that differs from the authorized amount', async () => {
    const provider = newProvider();
    const payment = provider.seedAuthorizedPayment('order_1', inr(494_900));
    const outcome = await provider.capturePayment({
      paymentId: payment.paymentId,
      amount: inr(999_900),
    });
    expect(outcome.kind).toBe('REJECTED');
    expect(provider.capturedCount()).toBe(0);
  });

  it('applies the capture even when the response is lost', async () => {
    // The hardest case: money moved and the caller has no idea.
    const provider = newProvider();
    const payment = provider.seedAuthorizedPayment('order_1', inr(100));
    provider.failNextCaptureWith('TIMEOUT_AFTER_APPLY');

    const outcome = await provider.capturePayment({
      paymentId: payment.paymentId,
      amount: inr(100),
    });
    expect(outcome.kind).toBe('INDETERMINATE');
    expect(provider.capturedCount()).toBe(1);

    // Only asking the provider reveals the truth.
    expect((await provider.getPayment(payment.paymentId))?.status).toBe('captured');
  });

  it('does not apply the capture when the request never arrived', async () => {
    const provider = newProvider();
    const payment = provider.seedAuthorizedPayment('order_1', inr(100));
    provider.failNextCaptureWith('TIMEOUT_BEFORE_APPLY');

    const outcome = await provider.capturePayment({
      paymentId: payment.paymentId,
      amount: inr(100),
    });
    expect(outcome.kind).toBe('INDETERMINATE');
    expect(provider.capturedCount()).toBe(0);
    expect((await provider.getPayment(payment.paymentId))?.status).toBe('authorized');
  });

  it('treats 5xx as indeterminate, not as a rejection', async () => {
    const provider = newProvider();
    const payment = provider.seedAuthorizedPayment('order_1', inr(100));
    provider.failNextCaptureWith('UNKNOWN_5XX');
    const outcome = await provider.capturePayment({
      paymentId: payment.paymentId,
      amount: inr(100),
    });
    expect(outcome).toEqual({ kind: 'INDETERMINATE', cause: 'UNKNOWN_5XX' });
  });
});
