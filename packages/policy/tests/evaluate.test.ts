import { describe, it, expect } from 'vitest';
import { evaluatePolicy } from '../src/evaluate.js';
import { computePolicyHash } from '../src/document.js';
import { adjustment, attr, buildSubject, inr, policy } from './helpers.js';

const codes = (result: { violations: readonly { code: string }[] }): string[] =>
  result.violations.map(v => v.code);

describe('MAX_TOTAL', () => {
  const rule = {
    ruleId: 'max_total',
    kind: 'MAX_TOTAL',
    description: 'Spend ceiling',
    severity: 'DENY',
    max: inr(500_000),
  };

  it('allows a cart exactly at the ceiling', () => {
    const subject = buildSubject({ lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 500_000 }] });
    expect(evaluatePolicy(policy([rule]), subject).violations).toHaveLength(0);
  });

  it('denies one minor unit over the ceiling', () => {
    const subject = buildSubject({ lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 500_001 }] });
    const result = evaluatePolicy(policy([rule]), subject);
    expect(codes(result)).toEqual(['TOTAL_EXCEEDS_LIMIT']);
    expect(result.violations[0]?.detail).toMatchObject({
      actualMinor: 500_001,
      limitMinor: 500_000,
    });
  });

  it('counts fees toward the total, catching the hidden-shipping-fee case', () => {
    // 4,500 item + 900 shipping = 5,400 against a 5,000 ceiling.
    const subject = buildSubject({
      lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 450_000 }],
      adjustments: [adjustment('SHIPPING', 90_000)],
    });
    expect(codes(evaluatePolicy(policy([rule]), subject))).toEqual(['TOTAL_EXCEEDS_LIMIT']);
  });

  it('subtracts discounts from the total', () => {
    const subject = buildSubject({
      lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 550_000 }],
      adjustments: [adjustment('DISCOUNT', 60_000)],
    });
    expect(evaluatePolicy(policy([rule]), subject).violations).toHaveLength(0);
  });

  it('refuses rather than ignoring a rule denominated in another currency', () => {
    const usdRule = { ...rule, max: { currency: 'USD' as const, amountMinor: 100 } };
    const subject = buildSubject({ lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100 }] });
    const result = evaluatePolicy(policy([usdRule]), subject);
    expect(codes(result)).toEqual(['POLICY_RULE_INAPPLICABLE']);
    expect(result.violations[0]?.severity).toBe('DENY');
  });
});

describe('fee ceilings', () => {
  it('flags an absolute shipping ceiling breach', () => {
    const result = evaluatePolicy(
      policy([
        {
          ruleId: 'max_shipping',
          kind: 'MAX_FEE',
          description: 'Shipping ceiling',
          severity: 'DENY',
          adjustmentType: 'SHIPPING',
          max: inr(20_000),
        },
      ]),
      buildSubject({
        lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 450_000 }],
        adjustments: [adjustment('SHIPPING', 90_000)],
      }),
    );
    expect(codes(result)).toEqual(['FEE_EXCEEDS_LIMIT']);
  });

  it('uses a distinct code for tips so an operator can tell them apart', () => {
    const result = evaluatePolicy(
      policy([
        {
          ruleId: 'max_tip',
          kind: 'MAX_FEE',
          description: 'Tip ceiling',
          severity: 'DENY',
          adjustmentType: 'TIP',
          max: inr(10_000),
        },
      ]),
      buildSubject({
        lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100_000 }],
        adjustments: [adjustment('TIP', 15_000)],
      }),
    );
    expect(codes(result)).toEqual(['TIP_EXCEEDS_LIMIT']);
  });

  it('sums multiple adjustments of the same type before comparing', () => {
    const result = evaluatePolicy(
      policy([
        {
          ruleId: 'max_shipping',
          kind: 'MAX_FEE',
          description: 'Shipping ceiling',
          severity: 'DENY',
          adjustmentType: 'SHIPPING',
          max: inr(20_000),
        },
      ]),
      buildSubject({
        lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100_000 }],
        adjustments: [
          adjustment('SHIPPING', 12_000, 'base'),
          adjustment('SHIPPING', 12_000, 'remote area'),
        ],
      }),
    );
    // Two 120.00 charges individually under the 200.00 cap, 240.00 together.
    expect(codes(result)).toEqual(['FEE_EXCEEDS_LIMIT']);
  });

  it('enforces a ratio ceiling in integer basis points', () => {
    const rule = {
      ruleId: 'shipping_ratio',
      kind: 'MAX_FEE_RATIO_BPS',
      description: 'Shipping at most 10% of items',
      severity: 'DENY',
      adjustmentType: 'SHIPPING',
      basisPoints: 1_000,
    };
    const atCap = buildSubject({
      lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100_000 }],
      adjustments: [adjustment('SHIPPING', 10_000)],
    });
    expect(evaluatePolicy(policy([rule]), atCap).violations).toHaveLength(0);

    const overCap = buildSubject({
      lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100_000 }],
      adjustments: [adjustment('SHIPPING', 10_001)],
    });
    expect(codes(evaluatePolicy(policy([rule]), overCap))).toEqual(['FEE_RATIO_EXCEEDS_LIMIT']);
  });

  it('catches fees that are individually fine but collectively excessive', () => {
    const result = evaluatePolicy(
      policy([
        {
          ruleId: 'max_all_fees',
          kind: 'MAX_TOTAL_FEES',
          description: 'Combined fee ceiling',
          severity: 'DENY',
          max: inr(20_000),
        },
      ]),
      buildSubject({
        lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100_000 }],
        adjustments: [
          adjustment('SHIPPING', 9_000),
          adjustment('CONVENIENCE_FEE', 9_000),
          adjustment('TIP', 9_000),
        ],
      }),
    );
    expect(codes(result)).toEqual(['FEE_EXCEEDS_LIMIT']);
    expect(result.violations[0]?.detail).toMatchObject({ scope: 'ALL_FEES', actualMinor: 27_000 });
  });
});

describe('merchant, currency, quantity and category rules', () => {
  it('denies a merchant outside the allowlist', () => {
    const result = evaluatePolicy(
      policy([
        {
          ruleId: 'merchants',
          kind: 'MERCHANT_ALLOWLIST',
          description: 'Approved merchants',
          severity: 'DENY',
          merchantIds: ['merchant_alpha'],
        },
      ]),
      buildSubject({
        merchantId: 'merchant_omega',
        lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100 }],
      }),
    );
    expect(codes(result)).toEqual(['MERCHANT_NOT_IN_ALLOWLIST']);
  });

  it('denies a currency outside the allowed set', () => {
    const result = evaluatePolicy(
      policy([
        {
          ruleId: 'currencies',
          kind: 'ALLOWED_CURRENCIES',
          description: 'INR only',
          severity: 'DENY',
          currencies: ['INR'],
        },
      ]),
      buildSubject({ currency: 'USD', lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100 }] }),
    );
    expect(codes(result)).toEqual(['CURRENCY_NOT_ALLOWED']);
  });

  it('reports every offending line, not just the first', () => {
    const result = evaluatePolicy(
      policy([
        {
          ruleId: 'max_qty',
          kind: 'MAX_QUANTITY_PER_ITEM',
          description: 'At most 2 per item',
          severity: 'DENY',
          max: 2,
        },
      ]),
      buildSubject({
        lines: [
          { sku: 'A', quantity: 3, unitPriceMinor: 100 },
          { sku: 'B', quantity: 1, unitPriceMinor: 100 },
          { sku: 'C', quantity: 9, unitPriceMinor: 100 },
        ],
      }),
    );
    expect(codes(result)).toEqual(['QUANTITY_EXCEEDS_LIMIT', 'QUANTITY_EXCEEDS_LIMIT']);
    expect(result.violations.map(v => v.detail['sku'])).toEqual(['A', 'C']);
  });

  it('denies a prohibited category', () => {
    const result = evaluatePolicy(
      policy([
        {
          ruleId: 'no_alcohol',
          kind: 'PROHIBITED_CATEGORIES',
          description: 'No alcohol',
          severity: 'DENY',
          categories: ['alcohol'],
        },
      ]),
      buildSubject({
        lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100, category: 'alcohol' }],
      }),
    );
    expect(codes(result)).toEqual(['CATEGORY_PROHIBITED']);
  });

  it('denies a line outside the allowed categories', () => {
    const result = evaluatePolicy(
      policy([
        {
          ruleId: 'only_footwear',
          kind: 'ALLOWED_CATEGORIES',
          description: 'Footwear only',
          severity: 'DENY',
          categories: ['footwear'],
        },
      ]),
      buildSubject({
        lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100, category: 'electronics' }],
      }),
    );
    expect(codes(result)).toEqual(['CATEGORY_NOT_ALLOWED']);
  });

  it('denies a recurring charge when subscriptions are forbidden', () => {
    const result = evaluatePolicy(
      policy([
        {
          ruleId: 'no_subs',
          kind: 'FORBID_SUBSCRIPTION',
          description: 'One-time only',
          severity: 'DENY',
        },
      ]),
      buildSubject({ lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100 }], recurring: true }),
    );
    expect(codes(result)).toEqual(['SUBSCRIPTION_PROHIBITED']);
  });

  it('checks required attributes against the live record', () => {
    const rule = {
      ruleId: 'must_be_black',
      kind: 'REQUIRE_ATTRIBUTES',
      description: 'Black only',
      severity: 'DENY',
      predicates: [{ name: 'colour', anyOf: ['black'] }],
    };
    const black = buildSubject({
      lines: [
        { sku: 'A', quantity: 1, unitPriceMinor: 100, attributes: [attr('colour', 'black')] },
      ],
    });
    expect(evaluatePolicy(policy([rule]), black).violations).toHaveLength(0);

    const white = buildSubject({
      lines: [
        { sku: 'A', quantity: 1, unitPriceMinor: 100, attributes: [attr('colour', 'white')] },
      ],
    });
    const result = evaluatePolicy(policy([rule]), white);
    expect(codes(result)).toEqual(['ATTRIBUTE_REQUIREMENT_UNMET']);
    expect(result.violations[0]?.detail).toMatchObject({ actual: 'white', expectedAnyOf: 'black' });
  });

  it('reports an absent attribute distinctly from a wrong one', () => {
    const result = evaluatePolicy(
      policy([
        {
          ruleId: 'must_be_black',
          kind: 'REQUIRE_ATTRIBUTES',
          description: 'Black only',
          severity: 'DENY',
          predicates: [{ name: 'colour', anyOf: ['black'] }],
        },
      ]),
      buildSubject({ lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100, attributes: [] }] }),
    );
    expect(result.violations[0]?.detail['actual']).toBe('<absent>');
  });
});

describe('fail-closed behaviour', () => {
  it('denies on a rule kind this build does not recognise', () => {
    const result = evaluatePolicy(
      policy([
        {
          ruleId: 'from_the_future',
          kind: 'MAX_CARBON_FOOTPRINT',
          description: 'Written by a newer deployment',
          severity: 'DENY',
          grams: 100,
        },
      ]),
      buildSubject({ lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100 }] }),
    );
    expect(codes(result)).toEqual(['POLICY_RULE_UNKNOWN']);
    expect(result.violations[0]?.severity).toBe('DENY');
    expect(result.rulesUnparseable).toBe(1);
    expect(result.rulesEvaluated).toBe(0);
  });

  it('denies on a rule that is well-known but malformed', () => {
    const result = evaluatePolicy(
      policy([{ ruleId: 'max_total', kind: 'MAX_TOTAL', description: 'Broken', severity: 'DENY' }]),
      buildSubject({ lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100 }] }),
    );
    expect(codes(result)).toEqual(['POLICY_RULE_UNKNOWN']);
  });

  it('rejects unknown extra fields rather than silently ignoring them', () => {
    // A rule carrying `maxx` instead of `max` must not evaluate as unconstrained.
    const result = evaluatePolicy(
      policy([
        {
          ruleId: 'typo_rule',
          kind: 'MAX_QUANTITY_PER_ITEM',
          description: 'Typo',
          severity: 'DENY',
          max: 2,
          maxx: 9999,
        },
      ]),
      buildSubject({ lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 100 }] }),
    );
    expect(codes(result)).toEqual(['POLICY_RULE_UNKNOWN']);
  });

  it('still evaluates the rules it does understand alongside one it does not', () => {
    const result = evaluatePolicy(
      policy([
        { ruleId: 'unknown_rule', kind: 'FROM_THE_FUTURE', description: 'x', severity: 'DENY' },
        {
          ruleId: 'max_total',
          kind: 'MAX_TOTAL',
          description: 'Spend ceiling',
          severity: 'DENY',
          max: inr(100),
        },
      ]),
      buildSubject({ lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 999_999 }] }),
    );
    expect(codes(result).sort()).toEqual(['POLICY_RULE_UNKNOWN', 'TOTAL_EXCEEDS_LIMIT']);
    expect(result.rulesEvaluated).toBe(1);
    expect(result.rulesUnparseable).toBe(1);
  });

  it('never treats an empty rule list as an approval signal', () => {
    // No violations is not the same as "verified"; the kernel, not the policy
    // engine, decides the verdict.
    const result = evaluatePolicy(
      policy([]),
      buildSubject({ lines: [{ sku: 'A', quantity: 1, unitPriceMinor: 999_999_999 }] }),
    );
    expect(result.violations).toHaveLength(0);
    expect(result.rulesEvaluated).toBe(0);
  });
});

describe('determinism', () => {
  const rules = [
    { ruleId: 'max_total', kind: 'MAX_TOTAL', description: 'a', severity: 'DENY', max: inr(100) },
    {
      ruleId: 'max_qty',
      kind: 'MAX_QUANTITY_PER_ITEM',
      description: 'b',
      severity: 'DENY',
      max: 1,
    },
    {
      ruleId: 'currencies',
      kind: 'ALLOWED_CURRENCIES',
      description: 'c',
      severity: 'DENY',
      currencies: ['USD'],
    },
  ];

  const subject = buildSubject({
    lines: [
      { sku: 'B', quantity: 5, unitPriceMinor: 900 },
      { sku: 'A', quantity: 5, unitPriceMinor: 900 },
    ],
  });

  it('produces the same output on repeated evaluation', () => {
    const first = JSON.stringify(evaluatePolicy(policy(rules), subject));
    for (let i = 0; i < 50; i += 1) {
      expect(JSON.stringify(evaluatePolicy(policy(rules), subject))).toBe(first);
    }
  });

  it('orders violations independently of rule declaration order', () => {
    const forwards = evaluatePolicy(policy(rules), subject).violations.map(
      v => `${v.ruleId}:${v.code}`,
    );
    const backwards = evaluatePolicy(policy([...rules].reverse()), subject).violations.map(
      v => `${v.ruleId}:${v.code}`,
    );
    expect(backwards).toEqual(forwards);
  });
});

describe('computePolicyHash', () => {
  it('is stable across key ordering within a rule', () => {
    const a = policy([
      { ruleId: 'max_total', kind: 'MAX_TOTAL', description: 'a', severity: 'DENY', max: inr(100) },
    ]);
    const b = policy([
      { max: inr(100), severity: 'DENY', description: 'a', kind: 'MAX_TOTAL', ruleId: 'max_total' },
    ]);
    expect(computePolicyHash(a)).toBe(computePolicyHash(b));
  });

  it('changes when any rule value changes', () => {
    const base = policy([
      { ruleId: 'max_total', kind: 'MAX_TOTAL', description: 'a', severity: 'DENY', max: inr(100) },
    ]);
    const tampered = policy([
      { ruleId: 'max_total', kind: 'MAX_TOTAL', description: 'a', severity: 'DENY', max: inr(999) },
    ]);
    expect(computePolicyHash(base)).not.toBe(computePolicyHash(tampered));
  });

  it('changes when rule order changes, since order is part of the document', () => {
    const ruleA = {
      ruleId: 'a_rule',
      kind: 'FORBID_SUBSCRIPTION',
      description: 'a',
      severity: 'DENY',
    };
    const ruleB = {
      ruleId: 'b_rule',
      kind: 'FORBID_SUBSCRIPTION',
      description: 'b',
      severity: 'DENY',
    };
    expect(computePolicyHash(policy([ruleA, ruleB]))).not.toBe(
      computePolicyHash(policy([ruleB, ruleA])),
    );
  });
});
