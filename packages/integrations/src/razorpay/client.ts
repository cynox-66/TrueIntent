/**
 * Razorpay TEST MODE HTTP adapter.
 *
 * Shaped around the documented API, not around what would be convenient:
 *
 *  - `POST /v1/orders` with `receipt` as the idempotency token, which Razorpay
 *    rejects on duplicate rather than returning the existing order. The
 *    `DUPLICATE_RECEIPT` outcome exists so a caller must handle that explicitly
 *    and recover via `GET /v1/orders?receipt=`.
 *  - `POST /v1/payments/:id/capture`, which is not idempotent: re-capturing
 *    returns 400. That 400 is mapped to `ALREADY_CAPTURED`, because it means
 *    the money moved — reporting it as a generic failure is how a system
 *    records a loss that did not happen, or retries one that did.
 *
 * Every network fault becomes `INDETERMINATE` rather than a rejection. "We do
 * not know" and "it did not happen" are different facts and the release machine
 * treats them differently.
 *
 * No automated test in this repository exercises this class over the network.
 * The suite runs against `FakePaymentProvider`, which reproduces these
 * semantics deterministically; `scripts/smoke-razorpay.ts` is the opt-in path
 * for checking this adapter against real test mode.
 */

import { CURRENCY_EXPONENTS, money } from '@capturelock/core';
import type {
  CaptureOutcome,
  CapturePaymentRequest,
  CreateOrderOutcome,
  CreateOrderRequest,
  CurrencyCode,
  Money,
  PaymentProvider,
  ProviderOrder,
  ProviderPayment,
  ProviderPaymentStatus,
  Receipt,
  Timestamp,
} from '@capturelock/core';
import { assertTestMode, type RazorpayConfig } from './config.js';

interface RazorpayError {
  readonly code?: string;
  readonly description?: string;
  readonly reason?: string;
}

interface RazorpayOrderPayload {
  readonly id: string;
  readonly receipt: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly status: string;
  readonly created_at: number;
}

interface RazorpayPaymentPayload {
  readonly id: string;
  readonly order_id: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly status: string;
}

/**
 * Substrings Razorpay uses for the two states we must not misread.
 *
 * Matching on prose is unpleasant, and it is called out here rather than buried:
 * Razorpay returns `BAD_REQUEST_ERROR` for both a duplicate receipt and an
 * already-captured payment, so the code alone cannot distinguish them. If a
 * future API version adds a distinguishing machine code, this should move to it.
 */
const DUPLICATE_RECEIPT_MARKERS = ['already been created', 'duplicate'];
const ALREADY_CAPTURED_MARKERS = [
  'already been captured',
  'already been either captured or voided',
  'already paid',
];

export class RazorpayTestClient implements PaymentProvider {
  public readonly name = 'razorpay-test';
  private readonly authorization: string;

  constructor(private readonly config: RazorpayConfig) {
    // Second of three independent live-mode refusals. See config.ts.
    assertTestMode(config.keyId);
    this.authorization = `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`, 'utf8').toString('base64')}`;
  }

  async createOrder(request: CreateOrderRequest): Promise<CreateOrderOutcome> {
    const response = await this.request('POST', '/v1/orders', {
      amount: request.amount.amountMinor,
      currency: request.amount.currency,
      receipt: request.receipt,
      notes: request.notes,
      // Manual capture, stated explicitly rather than inherited.
      //
      // Razorpay's `payment_capture` defaults to an ACCOUNT-LEVEL setting. If
      // that setting is auto-capture — which is the common default — a payment
      // goes straight from `created` to `captured` when the payer completes
      // checkout, never passing through `authorized`.
      //
      // For CaptureLock that is not a tuning detail, it is an architectural
      // bypass: the capture gate would have nothing left to gate, because the
      // provider already moved the money before our second verification ran.
      // The entire two-gate design depends on the authorize→capture split, so
      // it must be asserted per order and never left to a dashboard toggle
      // someone might flip. Verified against the live test API: the Orders API
      // rejects unknown fields with `extra_field_sent`, and accepts this one,
      // so the parameter is genuinely recognised. See ADR-016.
      payment_capture: 0,
    });

    if (response.kind === 'INDETERMINATE') {
      return { kind: 'INDETERMINATE', cause: response.cause };
    }

    if (response.kind === 'ERROR') {
      const description = (response.error.description ?? '').toLowerCase();
      if (DUPLICATE_RECEIPT_MARKERS.some(marker => description.includes(marker))) {
        return { kind: 'DUPLICATE_RECEIPT', receipt: request.receipt };
      }
      return {
        kind: 'REJECTED',
        code: response.error.code ?? 'UNKNOWN',
        description: response.error.description ?? 'Razorpay rejected the order',
      };
    }

    const order = this.toOrder(response.body as unknown as RazorpayOrderPayload);
    return order === null
      ? { kind: 'INDETERMINATE', cause: 'UNKNOWN_5XX' }
      : { kind: 'CREATED', order };
  }

  async findOrderByReceipt(receipt: Receipt): Promise<ProviderOrder | null> {
    const response = await this.request(
      'GET',
      `/v1/orders?receipt=${encodeURIComponent(receipt)}&count=10`,
    );
    if (response.kind !== 'OK') return null;

    const body = response.body as { items?: RazorpayOrderPayload[] };
    const match = (body.items ?? []).find(item => item.receipt === receipt);
    return match === undefined ? null : this.toOrder(match);
  }

  async capturePayment(request: CapturePaymentRequest): Promise<CaptureOutcome> {
    const response = await this.request(
      'POST',
      `/v1/payments/${encodeURIComponent(request.paymentId)}/capture`,
      { amount: request.amount.amountMinor, currency: request.amount.currency },
    );

    if (response.kind === 'INDETERMINATE') {
      return { kind: 'INDETERMINATE', cause: response.cause };
    }

    if (response.kind === 'ERROR') {
      const description = (response.error.description ?? '').toLowerCase();
      if (ALREADY_CAPTURED_MARKERS.some(marker => description.includes(marker))) {
        // Not a failure. The provider is telling us the money already moved,
        // and the caller must record that rather than retrying.
        const payment = await this.getPayment(request.paymentId);
        return { kind: 'ALREADY_CAPTURED', payment };
      }
      return {
        kind: 'REJECTED',
        code: response.error.code ?? 'UNKNOWN',
        description: response.error.description ?? 'Razorpay rejected the capture',
      };
    }

    const payment = this.toPayment(response.body as unknown as RazorpayPaymentPayload);
    return payment === null
      ? { kind: 'INDETERMINATE', cause: 'UNKNOWN_5XX' }
      : { kind: 'CAPTURED', payment };
  }

  async getPayment(paymentId: string): Promise<ProviderPayment | null> {
    const response = await this.request('GET', `/v1/payments/${encodeURIComponent(paymentId)}`);
    if (response.kind !== 'OK') return null;
    return this.toPayment(response.body as unknown as RazorpayPaymentPayload);
  }

  // ---- transport ----------------------------------------------------------

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<
    | { kind: 'OK'; body: unknown }
    | { kind: 'ERROR'; status: number; error: RazorpayError }
    | { kind: 'INDETERMINATE'; cause: 'TIMEOUT' | 'NETWORK' | 'UNKNOWN_5XX' }
  > {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          authorization: this.authorization,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      // A transport failure says nothing about whether the request was applied.
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      return { kind: 'INDETERMINATE', cause: isTimeout ? 'TIMEOUT' : 'NETWORK' };
    }

    // 5xx is likewise unknown: the request may have been processed before the
    // failure. Only a 4xx is a definite refusal.
    if (response.status >= 500) {
      return { kind: 'INDETERMINATE', cause: 'UNKNOWN_5XX' };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { kind: 'INDETERMINATE', cause: 'UNKNOWN_5XX' };
    }

    if (!response.ok) {
      const envelope = parsed as { error?: RazorpayError };

      // A 4xx WITHOUT Razorpay's `error` envelope did not come from Razorpay's
      // business logic — it is the API gateway declining to route. Measured
      // live: capturing a non-existent payment returns
      //   HTTP 404 {"message":"no Route matched with those values"}
      // with no `error` object at all.
      //
      // The same response would appear if the route were renamed, if the path
      // were built wrongly, or if the gateway were misconfigured — in which
      // case the payments service never saw the request, and equally may have.
      // We cannot tell from the response, and `CAPTURE_REJECTED` is terminal.
      // Treating an unroutable request as a definitive refusal would terminally
      // reject releases whose payments are fine. Uncertainty stays uncertainty.
      // See ADR-016.
      if (envelope.error === undefined) {
        return { kind: 'INDETERMINATE', cause: 'UNKNOWN_5XX' };
      }

      return { kind: 'ERROR', status: response.status, error: envelope.error };
    }

    return { kind: 'OK', body: parsed };
  }

  // ---- mapping ------------------------------------------------------------

  private toOrder(payload: RazorpayOrderPayload): ProviderOrder | null {
    const amount = this.toMoney(payload.amount, payload.currency);
    if (amount === null || payload.receipt === null) return null;
    return {
      orderId: payload.id,
      receipt: payload.receipt as Receipt,
      amount,
      status:
        payload.status === 'paid' || payload.status === 'attempted' ? payload.status : 'created',
      createdAt: new Date(payload.created_at * 1000).toISOString() as Timestamp,
    };
  }

  private toPayment(payload: RazorpayPaymentPayload): ProviderPayment | null {
    const amount = this.toMoney(payload.amount, payload.currency);
    if (amount === null) return null;
    return {
      paymentId: payload.id,
      orderId: payload.order_id,
      amount,
      status: toPaymentStatus(payload.status),
    };
  }

  private toMoney(amountMinor: number, currency: string): Money | null {
    if (!Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, currency)) return null;
    if (!Number.isSafeInteger(amountMinor)) return null;
    return money(currency as CurrencyCode, amountMinor);
  }
}

function toPaymentStatus(status: string): ProviderPaymentStatus {
  switch (status) {
    case 'created':
    case 'authorized':
    case 'captured':
    case 'refunded':
    case 'failed':
      return status;
    default:
      // An unrecognised status is treated as `created`: not capturable, and
      // never mistaken for captured.
      return 'created';
  }
}
