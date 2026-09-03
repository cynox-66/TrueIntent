/**
 * The advisory layer's one security property: it can only ever restrict.
 *
 * These tests are the reason the Phase 0 "spirit check" open question — fail
 * open or fail closed on a model timeout? — no longer needs an answer. A layer
 * that cannot grant anything has no fail-open mode to design around.
 */

import { describe, it, expect } from 'vitest';
import type { VerificationDecision, Verdict } from '@capturelock/core';
import { LexicalOverlapReviewer, applyAdvisory } from '../src/advisory.js';
import { evaluate } from '../src/kernel.js';
import { buildContext } from './fixtures.js';
import { Harness, SKU } from './harness.js';

function decisionWith(verdict: Verdict): VerificationDecision {
  return Object.freeze({
    verdict,
    gate: 'CAPTURE' as const,
    evaluatedAt: '2026-09-03T10:00:00.000Z' as never,
    findings: [],
    reasonCodes: [],
    stages: [],
  });
}

describe('applyAdvisory can only restrict', () => {
  const verdicts: Verdict[] = ['ALLOW', 'PAUSE', 'DENY'];
  const judgements = ['ALIGNED', 'MARGINAL', 'DIVERGED'] as const;

  it.each(verdicts.flatMap(v => judgements.map(j => [v, j] as const)))(
    'never makes a %s verdict less severe under a %s judgement',
    (verdict, judgement) => {
      const rank = { ALLOW: 0, PAUSE: 1, DENY: 2 };
      const result = applyAdvisory(decisionWith(verdict), 'test', judgement);
      expect(rank[result.decision.verdict]).toBeGreaterThanOrEqual(rank[verdict]);
    },
  );

  it('cannot turn a DENY into an ALLOW, whatever it says', () => {
    for (const judgement of judgements) {
      expect(applyAdvisory(decisionWith('DENY'), 'test', judgement).decision.verdict).toBe('DENY');
    }
  });

  it('cannot turn a PAUSE into an ALLOW', () => {
    for (const judgement of judgements) {
      expect(applyAdvisory(decisionWith('PAUSE'), 'test', judgement).decision.verdict).not.toBe(
        'ALLOW',
      );
    }
  });

  it('downgrades ALLOW to PAUSE on MARGINAL', () => {
    const result = applyAdvisory(decisionWith('ALLOW'), 'test', 'MARGINAL');
    expect(result.decision.verdict).toBe('PAUSE');
    expect(result.decision.reasonCodes).toContain('ADVISORY_INTENT_MARGINAL');
    expect(result.outcome.restricted).toBe(true);
  });

  it('downgrades ALLOW to DENY on DIVERGED', () => {
    const result = applyAdvisory(decisionWith('ALLOW'), 'test', 'DIVERGED');
    expect(result.decision.verdict).toBe('DENY');
    expect(result.decision.reasonCodes).toContain('ADVISORY_INTENT_DIVERGED');
  });

  it('leaves everything alone on ALIGNED', () => {
    const result = applyAdvisory(decisionWith('ALLOW'), 'test', 'ALIGNED');
    expect(result.decision.verdict).toBe('ALLOW');
    expect(result.outcome.restricted).toBe(false);
  });
});

describe('an unavailable reviewer', () => {
  it('applies no restriction and cannot fail open, because it never grants', () => {
    const result = applyAdvisory(decisionWith('ALLOW'), 'test', null);
    expect(result.decision.verdict).toBe('ALLOW');
    expect(result.decision.reasonCodes).toContain('ADVISORY_UNAVAILABLE');
    expect(result.outcome.restricted).toBe(false);
  });

  it('records its absence rather than passing silently', () => {
    const result = applyAdvisory(decisionWith('DENY'), 'test', null);
    expect(result.decision.findings.some(f => f.code === 'ADVISORY_UNAVAILABLE')).toBe(true);
  });

  it('preserves the deterministic verdict exactly', () => {
    for (const verdict of ['ALLOW', 'PAUSE', 'DENY'] as Verdict[]) {
      expect(applyAdvisory(decisionWith(verdict), 'test', null).decision.verdict).toBe(verdict);
    }
  });
});

describe('the deterministic kernel is unaffected by the advisory layer', () => {
  it('produces the same verdict with or without a reviewer configured', () => {
    const context = buildContext();
    const deterministic = evaluate(context);
    expect(deterministic.verdict).toBe('ALLOW');
    // Applying an ALIGNED judgement leaves the decision byte-identical.
    expect(applyAdvisory(deterministic, 'test', 'ALIGNED').decision).toBe(deterministic);
  });
});

describe('the lexical reviewer', () => {
  const reviewer = new LexicalOverlapReviewer();

  it('accepts an item that matches the words the user used', async () => {
    const judgement = await reviewer.review({
      rawIntent: 'Find me the cheapest pair of black running shoes under 5,000 rupees.',
      cart: buildContext().proposal,
      liveItems: [
        {
          sku: 'SKU-1' as never,
          merchantId: 'm' as never,
          name: 'Trailblaze Running Shoes',
          category: 'footwear',
          attributes: [{ name: 'colour', value: 'black' }],
          unitPrice: { currency: 'INR', amountMinor: 100 },
          available: true,
          availableStock: 1,
          subscriptionOnly: false,
          updatedAt: '2026-09-03T10:00:00.000Z' as never,
        },
      ],
    });
    expect(judgement).toBe('ALIGNED');
  });

  it('flags the canonical drift case: dinner ingredients answered with energy drinks', async () => {
    const judgement = await reviewer.review({
      rawIntent: 'Vegetarian Thai curry ingredients for dinner for four people.',
      cart: buildContext().proposal,
      liveItems: [
        {
          sku: 'SKU-2' as never,
          merchantId: 'm' as never,
          name: 'Voltage Energy Drink 250ml',
          category: 'beverages',
          attributes: [{ name: 'flavour', value: 'citrus' }],
          unitPrice: { currency: 'INR', amountMinor: 100 },
          available: true,
          availableStock: 12,
          subscriptionOnly: false,
          updatedAt: '2026-09-03T10:00:00.000Z' as never,
        },
      ],
    });
    expect(judgement).toBe('MARGINAL');
  });
});

describe('the advisory layer wired into a real release', () => {
  it('pauses a transaction the deterministic kernel would have allowed', async () => {
    const h = new Harness();
    // A reviewer that always judges divergence, standing in for a model that
    // spots something the structured constraints could not express.
    (h.deps as { advisory?: unknown }).advisory = {
      name: 'always-diverged',
      review: async () => 'DIVERGED' as const,
    };

    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('advisory'),
      principal: h.principal(),
    });

    expect(outcome.verdict).toBe('DENY');
    expect(outcome.reasonCodes).toContain('ADVISORY_INTENT_DIVERGED');
    expect(h.provider.calls).toHaveLength(0);
  });

  it('cannot rescue a transaction the deterministic kernel refused', async () => {
    const h = new Harness({
      items: [
        {
          sku: SKU,
          name: 'Trailblaze Runner',
          category: 'footwear',
          attributes: [{ name: 'colour', value: 'white' }],
          unitPriceMinor: 479_900,
          availableStock: 12,
        },
      ],
    });
    (h.deps as { advisory?: unknown }).advisory = {
      name: 'always-aligned',
      review: async () => 'ALIGNED' as const,
    };

    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('rescue'),
      principal: h.principal(),
    });

    // The reviewer approved; the kernel did not. The kernel wins.
    expect(outcome.verdict).toBe('DENY');
    expect(h.provider.calls).toHaveLength(0);
  });

  it('treats a throwing reviewer as unavailable rather than failing the request', async () => {
    const h = new Harness();
    (h.deps as { advisory?: unknown }).advisory = {
      name: 'broken',
      review: async () => {
        throw new Error('model unreachable');
      },
    };

    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('broken'),
      principal: h.principal(),
    });

    expect(outcome.verdict).toBe('ALLOW');
    expect(outcome.reasonCodes).toContain('ADVISORY_UNAVAILABLE');
  });

  it('records the advisory outcome separately from the deterministic decision', async () => {
    const h = new Harness();
    (h.deps as { advisory?: unknown }).advisory = {
      name: 'marginal-reviewer',
      review: async () => 'MARGINAL' as const,
    };

    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('record'),
      principal: h.principal(),
    });

    const envelope = await h.evidence.findById(outcome.evidenceEnvelopeId!);
    const body = envelope!.body as {
      verdict: string;
      advisory: { judgement: string; deterministicVerdict: string; effectiveVerdict: string };
    };

    // The deterministic verdict is preserved in the record even though the
    // effective outcome differs, so replay reproduces the computation exactly.
    expect(body.advisory.judgement).toBe('MARGINAL');
    expect(body.advisory.deterministicVerdict).toBe('ALLOW');
    expect(body.advisory.effectiveVerdict).toBe('PAUSE');
    expect(outcome.verdict).toBe('PAUSE');
  });
});
