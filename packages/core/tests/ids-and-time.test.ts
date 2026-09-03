import { describe, it, expect } from 'vitest';
import {
  MAX_RECEIPT_LENGTH,
  asAuthorizationId,
  asReleaseId,
  deriveReceipt,
  newAuthorizationId,
  newReleaseId,
  IdempotencyKeySchema,
  MerchantIdSchema,
  SkuSchema,
} from '../src/ids.js';
import { asSha256Hex, hash } from '../src/canonical.js';
import {
  FixedClock,
  addSeconds,
  asTimestamp,
  isTimestamp,
  millisBetween,
  timestampFromDate,
} from '../src/time.js';

describe('identifiers', () => {
  it('mints prefixed ids that round-trip through their parser', () => {
    const id = newAuthorizationId();
    expect(id).toMatch(/^auth_[0-9a-f]{32}$/);
    expect(asAuthorizationId(id)).toBe(id);
  });

  it('rejects an identifier of the wrong kind, catching a mis-wired call site', () => {
    const releaseId = newReleaseId();
    expect(() => asAuthorizationId(releaseId)).toThrow(/authorization/);
    expect(() => asReleaseId(newAuthorizationId())).toThrow(/release/);
  });

  it('restricts externally supplied identifiers to a conservative charset', () => {
    expect(MerchantIdSchema.parse('merchant_test-1')).toBe('merchant_test-1');
    expect(SkuSchema.parse('SKU-BLK-RUN-42')).toBe('SKU-BLK-RUN-42');
    // A homoglyph merchant id must not be accepted: it would look identical to
    // an allowlisted one in a console while comparing unequal in code.
    expect(() => MerchantIdSchema.parse('merchant_tеst')).toThrow();
    expect(() => MerchantIdSchema.parse('-leading-dash')).toThrow();
    expect(() => MerchantIdSchema.parse('has space')).toThrow();
    expect(() => SkuSchema.parse('')).toThrow();
  });

  it('requires idempotency keys long enough to be unguessable', () => {
    expect(() => IdempotencyKeySchema.parse('short')).toThrow();
    expect(IdempotencyKeySchema.parse('idem-0123456789abcdef')).toBe('idem-0123456789abcdef');
  });
});

describe('deriveReceipt', () => {
  const authA = asAuthorizationId('auth_' + 'a'.repeat(32));
  const authB = asAuthorizationId('auth_' + 'b'.repeat(32));
  const snapA = asSha256Hex('1'.repeat(64));
  const snapB = asSha256Hex('2'.repeat(64));

  it('fits inside the provider receipt limit', () => {
    const receipt = deriveReceipt(authA, snapA);
    expect(receipt.length).toBeLessThanOrEqual(MAX_RECEIPT_LENGTH);
    expect(receipt.length).toBe(35);
  });

  it('is deterministic, so a retry after a timeout recomputes the same value', () => {
    expect(deriveReceipt(authA, snapA)).toBe(deriveReceipt(authA, snapA));
  });

  it('separates authorization from snapshot, so neither can be varied silently', () => {
    expect(deriveReceipt(authA, snapA)).not.toBe(deriveReceipt(authB, snapA));
    expect(deriveReceipt(authA, snapA)).not.toBe(deriveReceipt(authA, snapB));
  });

  it('uses only characters the provider accepts in a receipt', () => {
    for (let i = 0; i < 200; i += 1) {
      const receipt = deriveReceipt(newAuthorizationId(), hash('capturelock.v1.snapshot', { i }));
      expect(receipt).toMatch(/^cl_[A-Za-z0-9_-]{32}$/);
      expect(receipt.length).toBeLessThanOrEqual(MAX_RECEIPT_LENGTH);
    }
  });
});

describe('timestamps', () => {
  it('accepts only the canonical ISO-8601 UTC form', () => {
    expect(isTimestamp('2026-09-03T10:00:00.000Z')).toBe(true);
    // Other valid ISO-8601 spellings of the same instant are rejected, because
    // two spellings would hash differently.
    expect(isTimestamp('2026-09-03T10:00:00Z')).toBe(false);
    expect(isTimestamp('2026-09-03T10:00:00.000+00:00')).toBe(false);
    expect(isTimestamp('2026-09-03T15:30:00.000+05:30')).toBe(false);
    expect(isTimestamp('2026-09-03')).toBe(false);
  });

  it('rejects well-shaped but impossible instants', () => {
    expect(isTimestamp('2026-02-30T00:00:00.000Z')).toBe(false);
    expect(isTimestamp('2026-13-01T00:00:00.000Z')).toBe(false);
    expect(() => asTimestamp('2026-02-30T00:00:00.000Z')).toThrow();
  });

  it('round-trips through Date', () => {
    const date = new Date('2026-09-03T10:00:00.000Z');
    expect(timestampFromDate(date)).toBe('2026-09-03T10:00:00.000Z');
  });

  it('measures signed differences', () => {
    const t0 = asTimestamp('2026-09-03T10:00:00.000Z');
    const t1 = addSeconds(t0, 45);
    expect(t1).toBe('2026-09-03T10:00:45.000Z');
    expect(millisBetween(t0, t1)).toBe(45_000);
    expect(millisBetween(t1, t0)).toBe(-45_000);
  });
});

describe('FixedClock', () => {
  it('does not advance on its own, so tests are deterministic', () => {
    const clock = new FixedClock(asTimestamp('2026-09-03T10:00:00.000Z'));
    expect(clock.now()).toBe('2026-09-03T10:00:00.000Z');
    expect(clock.now()).toBe('2026-09-03T10:00:00.000Z');
    clock.advanceBySeconds(31);
    expect(clock.now()).toBe('2026-09-03T10:00:31.000Z');
  });
});
