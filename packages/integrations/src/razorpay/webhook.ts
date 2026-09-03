/**
 * Razorpay webhook signature verification.
 *
 * Two details that are easy to get wrong and expensive to get wrong:
 *
 *  - The HMAC covers the **raw request bytes**. Verifying a re-serialized
 *    parsed body will fail for any payload whose key order or number formatting
 *    differs from the wire form. The interface therefore takes a Buffer, and
 *    the HTTP layer must install a raw-body parser on this route.
 *  - The comparison is constant-time. A `===` on hex digests leaks, through
 *    timing, how many leading characters an attacker guessed correctly.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookVerificationResult, WebhookVerifier } from '@capturelock/core';

export const RAZORPAY_SIGNATURE_HEADER = 'x-razorpay-signature';
export const RAZORPAY_EVENT_ID_HEADER = 'x-razorpay-event-id';

export class RazorpayWebhookVerifier implements WebhookVerifier {
  constructor(private readonly webhookSecret: string) {
    if (webhookSecret.length === 0) {
      throw new Error('Webhook secret must not be empty');
    }
  }

  verify(
    rawBody: Buffer,
    signature: string,
    headers: Readonly<Record<string, string>>,
  ): WebhookVerificationResult {
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');

    if (!constantTimeEquals(expected, signature)) {
      // Nothing about the payload is reported for an unverified request: an
      // attacker must not learn whether their forged body would have parsed.
      return { valid: false, eventId: null, eventType: null };
    }

    // Razorpay supplies a per-delivery event id in a header, which is the
    // deduplication key. Falling back to a payload-derived id would let a
    // sender choose it, so an absent header is reported as absent.
    const eventId = headers[RAZORPAY_EVENT_ID_HEADER] ?? null;
    const eventType = readEventType(rawBody);

    return { valid: true, eventId, eventType };
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself be a timing
  // signal; compare lengths first and still run the comparison on equal-length
  // buffers so the fast path is not obviously different.
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function readEventType(rawBody: Buffer): string | null {
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const event = (parsed as Record<string, unknown>)['event'];
    return typeof event === 'string' ? event : null;
  } catch {
    return null;
  }
}
