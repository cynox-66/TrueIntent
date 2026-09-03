import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  LiveModeRefusedError,
  RazorpayConfigSchema,
  assertTestMode,
} from '../src/razorpay/config.js';
import { RazorpayTestClient } from '../src/razorpay/client.js';
import { RAZORPAY_EVENT_ID_HEADER, RazorpayWebhookVerifier } from '../src/razorpay/webhook.js';

describe('live-mode refusal', () => {
  const base = { keySecret: 's', webhookSecret: 'w' };

  it('accepts a test key', () => {
    expect(RazorpayConfigSchema.parse({ ...base, keyId: 'rzp_test_abc123' }).keyId).toBe(
      'rzp_test_abc123',
    );
  });

  it('rejects a live key at the schema', () => {
    const result = RazorpayConfigSchema.safeParse({ ...base, keyId: 'rzp_live_abc123' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('test mode only');
  });

  it('rejects an unrecognised key prefix', () => {
    expect(RazorpayConfigSchema.safeParse({ ...base, keyId: 'sk_live_abc' }).success).toBe(false);
  });

  it('refuses again at the client constructor, independent of the schema', () => {
    // Defence in depth: a caller who bypassed the schema still cannot build a
    // client pointed at real money.
    expect(
      () =>
        new RazorpayTestClient({
          keyId: 'rzp_live_abc123',
          keySecret: 's',
          webhookSecret: 'w',
          baseUrl: 'https://api.razorpay.com',
          timeoutMs: 1000,
        }),
    ).toThrow(LiveModeRefusedError);
  });

  it('constructs for a test key', () => {
    expect(
      () =>
        new RazorpayTestClient({
          keyId: 'rzp_test_abc123',
          keySecret: 's',
          webhookSecret: 'w',
          baseUrl: 'https://api.razorpay.com',
          timeoutMs: 1000,
        }),
    ).not.toThrow();
  });

  it('exposes a standalone assertion for use at boot', () => {
    expect(() => assertTestMode('rzp_live_x')).toThrow(LiveModeRefusedError);
    expect(() => assertTestMode('rzp_test_x')).not.toThrow();
  });
});

describe('webhook signature verification', () => {
  const secret = 'webhook_secret_value';
  const verifier = new RazorpayWebhookVerifier(secret);
  const body = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: {} }), 'utf8');
  const goodSignature = createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a correct signature over the raw bytes', () => {
    const result = verifier.verify(body, goodSignature, {
      [RAZORPAY_EVENT_ID_HEADER]: 'evt_123',
    });
    expect(result).toEqual({ valid: true, eventId: 'evt_123', eventType: 'payment.captured' });
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { x: 1 } }));
    expect(verifier.verify(tampered, goodSignature, {}).valid).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const forged = createHmac('sha256', 'wrong').update(body).digest('hex');
    expect(verifier.verify(body, forged, {}).valid).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    expect(verifier.verify(body, 'abc', {}).valid).toBe(false);
    expect(verifier.verify(body, '', {}).valid).toBe(false);
  });

  it('reveals nothing about the payload when the signature is invalid', () => {
    const result = verifier.verify(body, 'deadbeef', {
      [RAZORPAY_EVENT_ID_HEADER]: 'evt_123',
    });
    expect(result).toEqual({ valid: false, eventId: null, eventType: null });
  });

  it('is sensitive to whitespace, since the HMAC covers exact bytes', () => {
    // Re-serializing a parsed body would produce these bytes and fail, which is
    // why the interface takes a Buffer.
    const reserialized = Buffer.from(
      JSON.stringify({ event: 'payment.captured', payload: {} }, null, 2),
    );
    expect(verifier.verify(reserialized, goodSignature, {}).valid).toBe(false);
  });

  it('reports a missing event id rather than inventing one from the payload', () => {
    // The dedup key must come from a header the sender does not control freely.
    const result = verifier.verify(body, goodSignature, {});
    expect(result.valid).toBe(true);
    expect(result.eventId).toBeNull();
  });

  it('handles a body that is not valid JSON', () => {
    const raw = Buffer.from('not json at all');
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    const result = verifier.verify(raw, signature, { [RAZORPAY_EVENT_ID_HEADER]: 'evt_9' });
    expect(result.valid).toBe(true);
    expect(result.eventType).toBeNull();
  });

  it('refuses to construct with an empty secret', () => {
    expect(() => new RazorpayWebhookVerifier('')).toThrow();
  });
});
