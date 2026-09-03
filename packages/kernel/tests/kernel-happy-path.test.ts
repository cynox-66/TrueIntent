import { describe, it, expect } from 'vitest';
import { computeDecisionHash } from '@capturelock/core';
import { evaluate, evaluateWithHashes } from '../src/kernel.js';
import { deserializeContext, serializeContext } from '../src/serialize.js';
import { buildContext, buildScenario } from './fixtures.js';

describe('the happy path', () => {
  it('allows a transaction that satisfies intent, policy and live state', () => {
    const decision = evaluate(buildContext());
    if (decision.verdict !== 'ALLOW') {
      throw new Error(
        `Expected ALLOW, got ${decision.verdict}: ${JSON.stringify(decision.findings, null, 2)}`,
      );
    }
    expect(decision.reasonCodes).toContain('VERIFIED_MATCH');
  });

  it('runs every mandatory stage to completion', () => {
    const decision = evaluate(buildContext());
    expect(decision.stages).toHaveLength(7);
    expect(decision.stages.every(s => s.status === 'COMPLETED')).toBe(true);
  });

  it('allows at both gates', () => {
    expect(evaluate(buildContext({ gate: 'ORDER_CREATION' })).verdict).toBe('ALLOW');
    expect(evaluate(buildContext({ gate: 'CAPTURE' })).verdict).toBe('ALLOW');
  });

  it('allows a total exactly at the authorized ceiling', () => {
    // 5,000.00 exactly: 4,850.00 item + 150.00 shipping.
    const decision = evaluate(
      buildContext({
        liveItems: items =>
          items.map(i => ({ ...i, unitPrice: { currency: 'INR', amountMinor: 485_000 } })),
      }),
    );
    expect(decision.verdict).toBe('ALLOW');
  });
});

describe('determinism', () => {
  it('produces a byte-identical decision on repeated evaluation', () => {
    const context = buildContext();
    const first = computeDecisionHash(evaluate(context));
    for (let i = 0; i < 200; i += 1) {
      expect(computeDecisionHash(evaluate(context))).toBe(first);
    }
  });

  it('produces identical decisions for two independently built identical worlds', () => {
    // Ids differ between builds, so compare the findings rather than the hash.
    const a = evaluate(buildContext());
    const b = evaluate(buildContext());
    expect(a.verdict).toBe(b.verdict);
    expect(a.reasonCodes).toEqual(b.reasonCodes);
  });

  it('does not depend on the ambient clock', () => {
    const context = buildContext();
    const before = computeDecisionHash(evaluate(context));
    const realNow = Date.now;
    try {
      // A stage reading the wall clock would change its answer here.
      Date.now = () => 4_102_444_800_000;
      expect(computeDecisionHash(evaluate(context))).toBe(before);
    } finally {
      Date.now = realNow;
    }
  });

  it('does not depend on randomness', () => {
    const context = buildContext();
    const before = computeDecisionHash(evaluate(context));
    const realRandom = Math.random;
    try {
      Math.random = () => 0.123456789;
      expect(computeDecisionHash(evaluate(context))).toBe(before);
    } finally {
      Math.random = realRandom;
    }
  });
});

describe('replay from a serialized context', () => {
  it('reproduces the identical decision hash after a round trip', () => {
    for (const scenario of [
      buildContext(),
      buildContext({ cart: c => ({ ...c, merchantId: 'merchant_omega' as typeof c.merchantId }) }),
      buildContext({ liveUnavailable: 'merchant timeout' }),
      buildContext({ omitAuthorization: true }),
    ]) {
      const original = evaluateWithHashes(scenario);
      const replayed = evaluateWithHashes(deserializeContext(serializeContext(scenario)));
      expect(replayed.decisionHash).toBe(original.decisionHash);
      expect(replayed.contextHash).toBe(original.contextHash);
      expect(replayed.decision.verdict).toBe(original.decision.verdict);
    }
  });

  it('produces a different context hash when any input changes', () => {
    const base = evaluateWithHashes(buildContext()).contextHash;
    const changed = evaluateWithHashes(
      buildContext({
        liveItems: items =>
          items.map(i => ({ ...i, unitPrice: { currency: 'INR', amountMinor: 1 } })),
      }),
    ).contextHash;
    expect(changed).not.toBe(base);
  });

  it('serializes to a canonicalizable structure', () => {
    // If this throws, the envelope could not be hashed and the decision could
    // not be recorded — which must fail loudly rather than silently.
    const scenario = buildScenario();
    expect(() => serializeContext(scenario.context)).not.toThrow();
  });
});

describe('immutability', () => {
  it('deep-freezes the context so a stage cannot mutate what it just verified', () => {
    const context = buildContext();
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.proposal)).toBe(true);
    expect(Object.isFrozen(context.proposal.lines)).toBe(true);
    expect(Object.isFrozen(context.proposal.lines[0])).toBe(true);
    expect(() => {
      (context.proposal.lines[0] as { quantity: number }).quantity = 99;
    }).toThrow(TypeError);
  });

  it('freezes the decision it returns', () => {
    const decision = evaluate(buildContext());
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.findings)).toBe(true);
  });
});
