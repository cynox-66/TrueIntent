import { describe, it, expect } from 'vitest';
import {
  VerificationVerdictSchema,
  ReasonCodeSchema,
  IntentSnapshotSchema,
  CartSnapshotSchema,
} from '@capturelock/core';
import { PolicyRuleTypeSchema } from '@capturelock/policy';
import { EvidenceEnvelopeSchema } from '@capturelock/evidence';
import { RazorpayConfigSchema } from '@capturelock/integrations';

describe('Monorepo Workspace Package Contracts', () => {
  it('validates @capturelock/core schemas correctly', () => {
    expect(VerificationVerdictSchema.parse('ALLOW')).toBe('ALLOW');
    expect(VerificationVerdictSchema.parse('DENY')).toBe('DENY');
    expect(VerificationVerdictSchema.parse('PAUSE')).toBe('PAUSE');
    expect(() => VerificationVerdictSchema.parse('INVALID')).toThrow();

    expect(ReasonCodeSchema.parse('VERIFIED_MATCH')).toBe('VERIFIED_MATCH');
    expect(ReasonCodeSchema.parse('STALE_PRICE')).toBe('STALE_PRICE');

    const sampleIntent = {
      rawIntent: 'Thai curry ingredients for 4 people under ₹800',
      maxBudgetMinor: 80000,
      currency: 'INR',
      authorizedAt: new Date().toISOString(),
      userId: 'usr_buyer_123',
    };
    expect(IntentSnapshotSchema.parse(sampleIntent)).toMatchObject({
      maxBudgetMinor: 80000,
      currency: 'INR',
    });

    const sampleCart = {
      merchantId: 'merch_test_1',
      items: [
        {
          sku: 'SKU-001',
          name: 'Item 1',
          quantity: 1,
          unitPriceMinor: 50000,
          category: 'general',
          sourceRowHash: 'row_hash_1',
          observedAt: new Date().toISOString(),
        },
      ],
      totalAmountMinor: 50000,
      currency: 'INR',
      snapshotHash: 'cart_hash_1',
      createdAt: new Date().toISOString(),
    };
    expect(CartSnapshotSchema.parse(sampleCart)).toBeDefined();
  });

  it('validates @capturelock/policy schemas correctly', () => {
    expect(PolicyRuleTypeSchema.parse('BUDGET_CAP')).toBe('BUDGET_CAP');
    expect(PolicyRuleTypeSchema.parse('MAX_DISCOUNT_PERCENTAGE')).toBe('MAX_DISCOUNT_PERCENTAGE');
  });

  it('validates @capturelock/evidence schemas correctly', () => {
    const sampleEnvelope = {
      envelopeId: '00000000-0000-0000-0000-000000000001',
      sessionId: '00000000-0000-0000-0000-000000000002',
      sequenceNumber: 1,
      previousEnvelopeHash: 'genesis_block_hash',
      currentEnvelopeHash: 'hash_of_envelope_1',
      timestamp: new Date().toISOString(),
      intentSnapshot: {
        rawIntent: 'Test intent',
        maxBudgetMinor: 50000,
        currency: 'INR',
        authorizedAt: new Date().toISOString(),
        userId: 'usr_test_1',
      },
      cartSnapshot: {
        merchantId: 'merch_test_1',
        items: [
          {
            sku: 'SKU-001',
            name: 'Item 1',
            quantity: 1,
            unitPriceMinor: 50000,
            category: 'general',
            sourceRowHash: 'row_hash_1',
            observedAt: new Date().toISOString(),
          },
        ],
        totalAmountMinor: 50000,
        currency: 'INR',
        snapshotHash: 'cart_hash_1',
        createdAt: new Date().toISOString(),
      },
      policyVersion: '1.0.0',
      liveStateDigest: 'digest_1',
      verdict: 'ALLOW' as const,
      reasonCodes: ['VERIFIED_MATCH' as const],
      idempotencyKey: 'idemp_key_12345678',
    };

    expect(EvidenceEnvelopeSchema.parse(sampleEnvelope)).toBeDefined();
  });

  it('enforces rzp_test_ prefix on @capturelock/integrations Razorpay config', () => {
    const validConfig = {
      keyId: 'rzp_test_validKey123',
      keySecret: 'secret123',
      webhookSecret: 'webhookSecret123',
    };
    expect(RazorpayConfigSchema.parse(validConfig)).toBeDefined();

    const invalidLiveConfig = {
      keyId: 'rzp_live_forbiddenKey123',
      keySecret: 'secret123',
      webhookSecret: 'webhookSecret123',
    };
    expect(() => RazorpayConfigSchema.parse(invalidLiveConfig)).toThrow(
      'Razorpay Key ID MUST begin with rzp_test_',
    );
  });
});
