/**
 * Adapter mapping, tested against responses actually recorded from the live
 * Razorpay test API.
 *
 * These are not invented fixtures. Every body marked OBSERVED below was
 * captured from `api.razorpay.com` against a real `rzp_test_` account, and the
 * exact status codes are the ones the API returned. Bodies marked DOCUMENTED
 * come from Razorpay's published documentation and have NOT been reproduced
 * live. The distinction is kept explicit so nobody later mistakes an assumption
 * for a measurement.
 *
 * The duplicate-capture wording below was the one genuinely open question, and
 * it is now closed: a full live lifecycle (order with payment_capture: 0 →
 * hosted checkout → authorized → capture gate → capture) was run against the
 * test account, and re-capturing the captured payment produced the first
 * description in the list verbatim. See ADR-016.
 *
 * `fetch` is stubbed rather than called, so this file stays in the offline
 * suite: `pnpm test` must never touch the network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { money, type Receipt } from '@capturelock/core';
import { RazorpayTestClient } from '../src/razorpay/client.js';

const config = {
  keyId: 'rzp_test_offlinefixture',
  keySecret: 'secret',
  webhookSecret: 'wh',
  baseUrl: 'https://api.razorpay.com',
  timeoutMs: 5_000,
} as const;

interface Recorded {
  readonly status: number;
  readonly body: unknown;
}

/** Replays one recorded response and captures what the adapter sent. */
function stubFetch(recorded: Recorded): { sent: () => unknown; url: () => string } {
  let sentBody: unknown = null;
  let sentUrl = '';
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    sentUrl = url;
    sentBody = init?.body === undefined ? null : JSON.parse(init.body);
    return {
      ok: recorded.status >= 200 && recorded.status < 300,
      status: recorded.status,
      json: async () => recorded.body,
    } as Response;
  });
  return { sent: () => sentBody, url: () => sentUrl };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('order creation asserts manual capture', () => {
  it('sends payment_capture: 0 on every order', async () => {
    // OBSERVED: the Orders API rejects unknown fields with `extra_field_sent`,
    // and accepts payment_capture — so this is a real, honoured parameter.
    //
    // It matters architecturally: Razorpay's default comes from an
    // account-level setting, and if that is auto-capture the payment goes
    // straight to `captured` and never passes through `authorized`. The capture
    // gate would then have nothing left to gate.
    const probe = stubFetch({
      status: 200,
      body: {
        id: 'order_TEST123',
        receipt: 'cl_x',
        amount: 494_900,
        currency: 'INR',
        status: 'created',
        created_at: 1_788_000_000,
      },
    });

    const client = new RazorpayTestClient(config);
    await client.createOrder({
      receipt: 'cl_x' as Receipt,
      amount: money('INR', 494_900),
      notes: {},
    });

    expect(probe.sent()).toMatchObject({ payment_capture: 0, amount: 494_900, currency: 'INR' });
  });
});

describe('a 4xx with no Razorpay error envelope is not a refusal', () => {
  it('maps the observed capture-404 to INDETERMINATE, not REJECTED', async () => {
    // OBSERVED, verbatim:
    //   POST /v1/payments/pay_NONEXISTENT0000/capture
    //   -> HTTP 404 {"message":"no Route matched with those values"}
    //
    // No `error` object: this is the API gateway declining to route, not
    // Razorpay's payments service refusing a payment. The identical response
    // would appear if the route were renamed or the path built wrongly, in
    // which case the payments service may never have seen the request.
    // CAPTURE_REJECTED is terminal, so reading this as a definitive refusal
    // would terminally reject releases whose payments are fine.
    stubFetch({ status: 404, body: { message: 'no Route matched with those values' } });

    const client = new RazorpayTestClient(config);
    const outcome = await client.capturePayment({
      paymentId: 'pay_NONEXISTENT0000',
      amount: money('INR', 494_900),
    });

    expect(outcome.kind).toBe('INDETERMINATE');
  });

  it('applies the same reading to order creation', async () => {
    stubFetch({ status: 404, body: { message: 'no Route matched with those values' } });
    const client = new RazorpayTestClient(config);
    const outcome = await client.createOrder({
      receipt: 'cl_x' as Receipt,
      amount: money('INR', 100),
      notes: {},
    });
    expect(outcome.kind).toBe('INDETERMINATE');
  });

  it('still treats a 4xx WITH an error envelope as a definitive refusal', async () => {
    // OBSERVED shape, from GET /v1/payments/<bad id>:
    //   HTTP 400 {"error":{"code":"BAD_REQUEST_ERROR",
    //             "description":"The id provided does not exist", ...}}
    // The request reached Razorpay's business logic, so the answer is real.
    stubFetch({
      status: 400,
      body: {
        error: {
          code: 'BAD_REQUEST_ERROR',
          description: 'The id provided does not exist',
          source: 'internal',
          step: 'payment_initiation',
          reason: 'input_validation_failed',
        },
      },
    });

    const client = new RazorpayTestClient(config);
    const outcome = await client.capturePayment({
      paymentId: 'pay_whatever',
      amount: money('INR', 100),
    });

    expect(outcome).toMatchObject({ kind: 'REJECTED', code: 'BAD_REQUEST_ERROR' });
  });

  it('rejects an order whose body carries a real error envelope', async () => {
    // OBSERVED: the Orders API is strict about unknown fields.
    stubFetch({
      status: 400,
      body: {
        error: {
          code: 'BAD_REQUEST_ERROR',
          description: 'not_a_real_field is/are not required and should not be sent',
          reason: 'extra_field_sent',
          source: 'business',
        },
      },
    });
    const client = new RazorpayTestClient(config);
    const outcome = await client.createOrder({
      receipt: 'cl_x' as Receipt,
      amount: money('INR', 100),
      notes: {},
    });
    expect(outcome).toMatchObject({ kind: 'REJECTED', code: 'BAD_REQUEST_ERROR' });
  });
});

describe('duplicate capture', () => {
  it.each([
    // OBSERVED, verbatim, from re-capturing a payment this system had just
    // captured live:
    //   POST /v1/payments/<captured id>/capture
    //   -> HTTP 400 {"error":{"code":"BAD_REQUEST_ERROR",
    //                "description":"This payment has already been captured",
    //                "source":"NA","step":"NA","reason":"NA",
    //                "metadata":{"payment_id":"<id without the pay_ prefix>"}}}
    // Note that `source`, `step` and `reason` are all the string "NA" — none of
    // them distinguishes this from any other BAD_REQUEST_ERROR, which is why
    // the adapter has to match on the description prose.
    'This payment has already been captured',
    // DOCUMENTED, not observed. Kept so a wording change on Razorpay's side
    // still maps to ALREADY_CAPTURED rather than to a false failure.
    'The payment has already been either captured or voided',
    'Your payment has been declined as the order is already paid.',
  ])('maps %s to ALREADY_CAPTURED, not to a failure', async description => {
    // The distinction matters more than it looks: this 400 means the money
    // MOVED. Recording it as a rejection would report a loss that did not
    // happen, and would invite a retry of an operation that already succeeded.
    let call = 0;
    vi.stubGlobal('fetch', async () => {
      call += 1;
      // First call: the capture attempt. Second: the adapter's follow-up read.
      return call === 1
        ? ({
            ok: false,
            status: 400,
            json: async () => ({ error: { code: 'BAD_REQUEST_ERROR', description } }),
          } as Response)
        : ({
            ok: true,
            status: 200,
            json: async () => ({
              id: 'pay_X',
              order_id: 'order_X',
              amount: 494_900,
              currency: 'INR',
              status: 'captured',
            }),
          } as Response);
    });

    const client = new RazorpayTestClient(config);
    const outcome = await client.capturePayment({
      paymentId: 'pay_X',
      amount: money('INR', 494_900),
    });

    expect(outcome.kind).toBe('ALREADY_CAPTURED');
    if (outcome.kind === 'ALREADY_CAPTURED') {
      expect(outcome.payment?.status).toBe('captured');
    }
  });

  it('reports ALREADY_CAPTURED even when the follow-up read fails', async () => {
    // The provider already told us the money moved. A failed lookup afterwards
    // does not make that less true, and must not downgrade the outcome.
    let call = 0;
    vi.stubGlobal('fetch', async () => {
      call += 1;
      return call === 1
        ? ({
            ok: false,
            status: 400,
            json: async () => ({
              error: {
                code: 'BAD_REQUEST_ERROR',
                description: 'This payment has already been captured',
              },
            }),
          } as Response)
        : ({ ok: false, status: 500, json: async () => ({}) } as Response);
    });

    const client = new RazorpayTestClient(config);
    const outcome = await client.capturePayment({
      paymentId: 'pay_X',
      amount: money('INR', 100),
    });
    expect(outcome.kind).toBe('ALREADY_CAPTURED');
    if (outcome.kind === 'ALREADY_CAPTURED') expect(outcome.payment).toBeNull();
  });
});

describe('successful capture', () => {
  it('maps a 200 to CAPTURED and preserves provider identifiers and amount', async () => {
    stubFetch({
      status: 200,
      body: {
        id: 'pay_LIVE1',
        order_id: 'order_LIVE1',
        amount: 494_900,
        currency: 'INR',
        status: 'captured',
      },
    });

    const client = new RazorpayTestClient(config);
    const outcome = await client.capturePayment({
      paymentId: 'pay_LIVE1',
      amount: money('INR', 494_900),
    });

    expect(outcome.kind).toBe('CAPTURED');
    if (outcome.kind === 'CAPTURED') {
      expect(outcome.payment.paymentId).toBe('pay_LIVE1');
      expect(outcome.payment.orderId).toBe('order_LIVE1');
      expect(outcome.payment.amount.amountMinor).toBe(494_900);
      expect(outcome.payment.status).toBe('captured');
    }
  });

  it('treats an unparseable success body as indeterminate rather than captured', async () => {
    // A 200 whose body we cannot map tells us nothing reliable. Claiming
    // CAPTURED from it would be inventing a fact.
    stubFetch({ status: 200, body: { id: 'pay_X', amount: 'not-a-number', currency: 'INR' } });
    const client = new RazorpayTestClient(config);
    const outcome = await client.capturePayment({
      paymentId: 'pay_X',
      amount: money('INR', 100),
    });
    expect(outcome.kind).toBe('INDETERMINATE');
  });

  it('treats an unsupported currency as indeterminate rather than guessing', async () => {
    stubFetch({
      status: 200,
      body: { id: 'pay_X', order_id: null, amount: 100, currency: 'XYZ', status: 'captured' },
    });
    const client = new RazorpayTestClient(config);
    const outcome = await client.capturePayment({
      paymentId: 'pay_X',
      amount: money('INR', 100),
    });
    expect(outcome.kind).toBe('INDETERMINATE');
  });
});

describe('transport failures never become definitive answers', () => {
  it('maps a timeout to INDETERMINATE', async () => {
    vi.stubGlobal('fetch', async () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    });
    const client = new RazorpayTestClient(config);
    const outcome = await client.capturePayment({
      paymentId: 'pay_X',
      amount: money('INR', 100),
    });
    expect(outcome).toEqual({ kind: 'INDETERMINATE', cause: 'TIMEOUT' });
  });

  it('maps a network error to INDETERMINATE', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNRESET');
    });
    const client = new RazorpayTestClient(config);
    const outcome = await client.capturePayment({
      paymentId: 'pay_X',
      amount: money('INR', 100),
    });
    expect(outcome).toEqual({ kind: 'INDETERMINATE', cause: 'NETWORK' });
  });

  it('maps a 5xx to INDETERMINATE, because the request may have been applied', async () => {
    stubFetch({ status: 502, body: { message: 'bad gateway' } });
    const client = new RazorpayTestClient(config);
    const outcome = await client.capturePayment({
      paymentId: 'pay_X',
      amount: money('INR', 100),
    });
    expect(outcome).toEqual({ kind: 'INDETERMINATE', cause: 'UNKNOWN_5XX' });
  });

  it('never returns CAPTURED or REJECTED for any transport failure', async () => {
    for (const failure of ['TimeoutError', 'NetworkError'] as const) {
      vi.stubGlobal('fetch', async () => {
        const error = new Error('boom');
        error.name = failure;
        throw error;
      });
      const client = new RazorpayTestClient(config);
      const outcome = await client.capturePayment({
        paymentId: 'pay_X',
        amount: money('INR', 100),
      });
      expect(['CAPTURED', 'REJECTED']).not.toContain(outcome.kind);
    }
  });
});

describe('payment lookup', () => {
  it('returns the payment on success', async () => {
    stubFetch({
      status: 200,
      body: {
        id: 'pay_A',
        order_id: 'order_A',
        amount: 100,
        currency: 'INR',
        status: 'authorized',
      },
    });
    const client = new RazorpayTestClient(config);
    expect(await client.getPayment('pay_A')).toMatchObject({
      paymentId: 'pay_A',
      status: 'authorized',
    });
  });

  it('returns null for the observed not-found response', async () => {
    // OBSERVED: HTTP 400, not 404, with a proper error envelope.
    stubFetch({
      status: 400,
      body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } },
    });
    const client = new RazorpayTestClient(config);
    expect(await client.getPayment('pay_missing')).toBeNull();
  });

  it('maps an unrecognised payment status to created, never to captured', async () => {
    // Guessing upward would be the dangerous direction: it would let
    // reconciliation conclude money moved when it does not know that.
    stubFetch({
      status: 200,
      body: { id: 'pay_A', order_id: null, amount: 100, currency: 'INR', status: 'something_new' },
    });
    const client = new RazorpayTestClient(config);
    expect((await client.getPayment('pay_A'))?.status).toBe('created');
  });
});
