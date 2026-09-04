/**
 * The context capsule.
 *
 * Determinism is the whole property. A capsule sits in an append-only,
 * hash-chained ledger, so if two logically identical capsules could hash
 * differently, a verifier would report tampering where there was none — and if
 * two *different* capsules could hash the same, the chain would attest to a
 * purchase that did not happen.
 *
 * The second describe block is the one that catches real bugs: the capsule must
 * survive a `jsonb` round trip. A field the canonicalizer accepts but
 * `JSON.stringify` drops hashes fine in memory and comes back as
 * `PAYLOAD_MODIFIED` on read, which is a confusing way to learn that a schema
 * carried an `undefined`.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTEXT_CAPSULE_VERSION,
  MAX_SELECTION_RATIONALE,
  asSha256Hex,
  asTimestamp,
  canonicalize,
  capsuleHashInput,
  computeCapsuleHash,
  verifyCapsuleIntegrity,
  type ContextCapsule,
  type MerchantId,
  type SessionId,
  type Sha256Hex,
  type Sku,
  type UserId,
} from '../src/index.js';

const HASH = (seed: string): Sha256Hex =>
  asSha256Hex(
    seed
      .padEnd(64, '0')
      .slice(0, 64)
      .replace(/[^0-9a-f]/g, '0'),
  );

function capsule(overrides: Partial<ContextCapsule> = {}): ContextCapsule {
  return {
    capsuleVersion: CONTEXT_CAPSULE_VERSION,
    sessionId: 'sess_00000000000000000000000000000001' as SessionId,
    userId: 'user_priya' as UserId,
    intentText: 'Thai curry dinner for 4, vegetarian, under 800 rupees',
    boundsHash: HASH('bbbb'),
    merchantId: 'merchant_alpha' as MerchantId,
    catalogVersion: 'cat_0123456789abcdef',
    lines: [
      {
        sku: 'SKU-THAI-CURRY-KIT' as Sku,
        quantity: 1,
        unitPriceMinor: 28_000,
        name: 'Thai Green Curry Kit',
        category: 'thai-meal-kit',
      },
      {
        sku: 'SKU-THAI-RICE-1KG' as Sku,
        quantity: 1,
        unitPriceMinor: 18_000,
        name: 'Jasmine Rice 1kg',
        category: 'groceries',
      },
    ],
    agentDecision: {
      model: 'deterministic-planner',
      steps: 4,
      refusedSteps: 0,
      rationale: 'Closest catalogue match to a vegetarian Thai dinner for four.',
    },
    authorizationId: 'auth_00000000000000000000000000000001',
    intentHash: HASH('cccc'),
    snapshotId: 'snap_00000000000000000000000000000001',
    snapshotHash: HASH('dddd'),
    currency: 'INR',
    totalMinor: 61_000,
    policyId: 'household',
    policyVersion: '1.0.0',
    policyHash: HASH('eeee'),
    observedAt: asTimestamp('2026-09-04T10:00:00.000Z'),
    ...overrides,
  };
}

describe('the capsule hash', () => {
  it('is deterministic across independently constructed but equal capsules', () => {
    expect(computeCapsuleHash(capsule())).toBe(computeCapsuleHash(capsule()));
  });

  it('does not depend on the order the agent added lines', () => {
    // Adding rice then curry built the same cart as curry then rice. A hash
    // that disagreed would report tampering on a difference that is not one.
    const forwards = capsule();
    const backwards = capsule({ lines: [...capsule().lines].reverse() });
    expect(computeCapsuleHash(backwards)).toBe(computeCapsuleHash(forwards));
  });

  it('changes when the total changes', () => {
    expect(computeCapsuleHash(capsule({ totalMinor: 61_001 }))).not.toBe(
      computeCapsuleHash(capsule()),
    );
  });

  it('changes when a line quantity changes', () => {
    const lines = capsule().lines.map((line, index) =>
      index === 0 ? { ...line, quantity: 2 } : line,
    );
    expect(computeCapsuleHash(capsule({ lines }))).not.toBe(computeCapsuleHash(capsule()));
  });

  it('changes when the user intent changes', () => {
    // The user's words are inside the hash, so evidence cannot be re-pointed at
    // a different stated purpose after the fact.
    expect(computeCapsuleHash(capsule({ intentText: 'buy me anything' }))).not.toBe(
      computeCapsuleHash(capsule()),
    );
  });

  it('changes when the catalogue version changes', () => {
    // Which version of reality the agent was looking at is part of the record.
    expect(computeCapsuleHash(capsule({ catalogVersion: 'cat_ffffffffffffffff' }))).not.toBe(
      computeCapsuleHash(capsule()),
    );
  });

  it('changes when the bound policy changes', () => {
    expect(computeCapsuleHash(capsule({ policyHash: HASH('ffff') }))).not.toBe(
      computeCapsuleHash(capsule()),
    );
  });

  it('detects an edited capsule', () => {
    const original = capsule();
    const expected = computeCapsuleHash(original);
    const edited = capsule({ totalMinor: 1 });

    expect(verifyCapsuleIntegrity(original, expected).valid).toBe(true);
    expect(verifyCapsuleIntegrity(edited, expected).valid).toBe(false);
  });
});

describe('canonicalizability', () => {
  it('canonicalizes, so it can be sealed into an envelope', () => {
    // The canonicalizer rejects undefined, floats, -0, Date, Map and
    // non-identifier keys. If the capsule schema ever grows one of those, this
    // fails here rather than at append time in production.
    expect(() => canonicalize(capsuleHashInput(capsule()))).not.toThrow();
  });

  it('survives a JSON round trip unchanged', () => {
    // Stands in for the jsonb round trip. A field JSON.stringify drops would
    // hash fine in memory and come back as a broken payload on read.
    const original = capsule();
    const roundTripped = JSON.parse(JSON.stringify(capsuleHashInput(original))) as Record<
      string,
      unknown
    >;
    expect(canonicalize(roundTripped)).toBe(canonicalize(capsuleHashInput(original)));
  });

  it('holds only integer minor units, never floating-point money', () => {
    const input = capsuleHashInput(capsule());
    const lines = input['lines'] as { unitPriceMinor: number }[];
    for (const line of lines) expect(Number.isSafeInteger(line.unitPriceMinor)).toBe(true);
    expect(Number.isSafeInteger(input['totalMinor'])).toBe(true);
  });
});

describe('what the capsule refuses to carry', () => {
  it('has no field for a conversation transcript', () => {
    // A transcript in an append-only ledger is a privacy liability that grows
    // without bound and proves nothing a hash cannot. The agent gets one line.
    const keys = Object.keys(capsuleHashInput(capsule()));
    for (const forbidden of ['transcript', 'messages', 'conversation', 'prompt']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('serializes without anything that looks like a credential', () => {
    const serialized = canonicalize(capsuleHashInput(capsule()));
    for (const forbidden of ['apiKey', 'secret', 'privateKey', 'token', 'password']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('bounds the agent rationale so free text cannot grow without limit', () => {
    expect(MAX_SELECTION_RATIONALE).toBeLessThanOrEqual(1_000);
  });
});
