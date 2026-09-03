/**
 * Deterministic policy evaluation.
 *
 * Properties this module guarantees, each of which is tested:
 *
 *  - **Pure.** No clock, no I/O, no randomness. The same document and subject
 *    always produce byte-identical output, which is what makes a decision
 *    replayable from evidence.
 *  - **Fail closed.** A rule this build cannot parse, or cannot meaningfully
 *    apply, becomes a DENY violation. It is never skipped. Skipping is how a
 *    policy silently stops protecting anything.
 *  - **Total order.** Violations are sorted by an explicit comparator so the
 *    output does not depend on rule order or sort stability.
 *  - **Exhaustive.** The compiler rejects a new rule kind that no evaluator
 *    handles, via `assertNever`.
 */

import {
  applyBasisPoints,
  assertNever,
  isGreaterThan,
  satisfiesPredicate,
  zero,
  type FindingDetail,
  type AdjustmentType,
  type Money,
  type ReasonCode,
  type Severity,
} from '@capturelock/core';
import { PolicyRuleSchema, type PolicyRule } from './rules.js';
import type { PolicySubject, PolicySubjectLine } from './subject.js';
import { computePolicyHash, type PolicyDocument } from './document.js';

export interface PolicyViolation {
  readonly code: ReasonCode;
  readonly ruleId: string;
  readonly ruleKind: string;
  readonly severity: Severity;
  readonly message: string;
  readonly detail: FindingDetail;
}

export interface PolicyEvaluation {
  readonly policyId: string;
  readonly version: string;
  readonly policyHash: string;
  readonly violations: readonly PolicyViolation[];
  readonly rulesEvaluated: number;
  /** Rules this build could not parse. Each produced a DENY violation. */
  readonly rulesUnparseable: number;
}

function violation(
  rule: { ruleId: string; kind: string; severity: Severity },
  code: ReasonCode,
  message: string,
  detail: FindingDetail = {},
): PolicyViolation {
  return Object.freeze({
    code,
    ruleId: rule.ruleId,
    ruleKind: rule.kind,
    severity: rule.severity,
    message,
    detail: Object.freeze({ ...detail }),
  });
}

/**
 * A rule that cannot be applied to this subject.
 *
 * Always DENY regardless of the rule's declared severity: the author intended
 * *some* constraint, and we cannot know that downgrading it to a pause is what
 * they would have wanted.
 */
function inapplicable(
  rule: { ruleId: string; kind: string },
  reason: string,
  detail: FindingDetail = {},
): PolicyViolation {
  return Object.freeze({
    code: 'POLICY_RULE_INAPPLICABLE' as const,
    ruleId: rule.ruleId,
    ruleKind: rule.kind,
    severity: 'DENY' as const,
    message: `Rule ${rule.ruleId} cannot be evaluated: ${reason}`,
    detail: Object.freeze({ ...detail, reason }),
  });
}

function feeOf(subject: PolicySubject, type: AdjustmentType): Money {
  return subject.feeByType.get(type) ?? zero(subject.currency);
}

function evaluateRule(rule: PolicyRule, subject: PolicySubject): PolicyViolation[] {
  const out: PolicyViolation[] = [];

  switch (rule.kind) {
    case 'MAX_TOTAL': {
      if (rule.max.currency !== subject.currency) {
        return [
          inapplicable(rule, 'rule currency does not match transaction currency', {
            ruleCurrency: rule.max.currency,
            transactionCurrency: subject.currency,
          }),
        ];
      }
      if (isGreaterThan(subject.totals.computedTotal, rule.max)) {
        out.push(
          violation(rule, 'TOTAL_EXCEEDS_LIMIT', 'Cart total exceeds the policy ceiling.', {
            actualMinor: subject.totals.computedTotal.amountMinor,
            limitMinor: rule.max.amountMinor,
            currency: subject.currency,
          }),
        );
      }
      return out;
    }

    case 'MAX_UNIT_PRICE': {
      if (rule.max.currency !== subject.currency) {
        return [inapplicable(rule, 'rule currency does not match transaction currency')];
      }
      for (const line of subject.lines) {
        if (isGreaterThan(line.unitPrice, rule.max)) {
          out.push(
            violation(
              rule,
              'UNIT_PRICE_EXCEEDS_LIMIT',
              'A unit price exceeds the policy ceiling.',
              {
                sku: line.sku,
                actualMinor: line.unitPrice.amountMinor,
                limitMinor: rule.max.amountMinor,
              },
            ),
          );
        }
      }
      return out;
    }

    case 'MAX_QUANTITY_PER_ITEM': {
      for (const line of subject.lines) {
        if (line.quantity > rule.max) {
          out.push(
            violation(
              rule,
              'QUANTITY_EXCEEDS_LIMIT',
              'A line quantity exceeds the policy ceiling.',
              {
                sku: line.sku,
                actual: line.quantity,
                limit: rule.max,
              },
            ),
          );
        }
      }
      return out;
    }

    case 'MAX_LINE_ITEMS': {
      if (subject.lines.length > rule.max) {
        out.push(
          violation(
            rule,
            'LINE_ITEM_COUNT_EXCEEDS_LIMIT',
            'The cart has more distinct line items than policy allows.',
            { actual: subject.lines.length, limit: rule.max },
          ),
        );
      }
      return out;
    }

    case 'ALLOWED_CURRENCIES': {
      if (!rule.currencies.includes(subject.currency)) {
        out.push(
          violation(rule, 'CURRENCY_NOT_ALLOWED', 'The transaction currency is not permitted.', {
            actual: subject.currency,
            allowed: [...rule.currencies].sort().join(','),
          }),
        );
      }
      return out;
    }

    case 'MERCHANT_ALLOWLIST': {
      if (!rule.merchantIds.includes(subject.merchantId)) {
        out.push(
          violation(
            rule,
            'MERCHANT_NOT_IN_ALLOWLIST',
            'The merchant is not on the policy allowlist.',
            {
              merchantId: subject.merchantId,
            },
          ),
        );
      }
      return out;
    }

    case 'MERCHANT_DENYLIST': {
      if (rule.merchantIds.includes(subject.merchantId)) {
        out.push(
          violation(rule, 'MERCHANT_IN_DENYLIST', 'The merchant is on the policy denylist.', {
            merchantId: subject.merchantId,
          }),
        );
      }
      return out;
    }

    case 'MAX_FEE': {
      if (rule.max.currency !== subject.currency) {
        return [inapplicable(rule, 'rule currency does not match transaction currency')];
      }
      const actual = feeOf(subject, rule.adjustmentType);
      if (isGreaterThan(actual, rule.max)) {
        const code: ReasonCode =
          rule.adjustmentType === 'TIP' ? 'TIP_EXCEEDS_LIMIT' : 'FEE_EXCEEDS_LIMIT';
        out.push(
          violation(rule, code, `${rule.adjustmentType} exceeds the policy ceiling.`, {
            adjustmentType: rule.adjustmentType,
            actualMinor: actual.amountMinor,
            limitMinor: rule.max.amountMinor,
          }),
        );
      }
      return out;
    }

    case 'MAX_FEE_RATIO_BPS': {
      const actual = feeOf(subject, rule.adjustmentType);
      const cap = applyBasisPoints(subject.totals.itemSubtotal, rule.basisPoints);
      if (isGreaterThan(actual, cap)) {
        out.push(
          violation(
            rule,
            'FEE_RATIO_EXCEEDS_LIMIT',
            `${rule.adjustmentType} exceeds its permitted ratio of the item subtotal.`,
            {
              adjustmentType: rule.adjustmentType,
              actualMinor: actual.amountMinor,
              capMinor: cap.amountMinor,
              basisPoints: rule.basisPoints,
              itemSubtotalMinor: subject.totals.itemSubtotal.amountMinor,
            },
          ),
        );
      }
      return out;
    }

    case 'MAX_TOTAL_FEES': {
      if (rule.max.currency !== subject.currency) {
        return [inapplicable(rule, 'rule currency does not match transaction currency')];
      }
      if (isGreaterThan(subject.totals.feeTotal, rule.max)) {
        out.push(
          violation(rule, 'FEE_EXCEEDS_LIMIT', 'Combined fees exceed the policy ceiling.', {
            actualMinor: subject.totals.feeTotal.amountMinor,
            limitMinor: rule.max.amountMinor,
            scope: 'ALL_FEES',
          }),
        );
      }
      return out;
    }

    case 'PROHIBITED_CATEGORIES': {
      for (const line of subject.lines) {
        if (rule.categories.includes(line.category)) {
          out.push(
            violation(rule, 'CATEGORY_PROHIBITED', 'The cart contains a prohibited category.', {
              sku: line.sku,
              category: line.category,
            }),
          );
        }
      }
      return out;
    }

    case 'ALLOWED_CATEGORIES': {
      for (const line of subject.lines) {
        if (!rule.categories.includes(line.category)) {
          out.push(
            violation(
              rule,
              'CATEGORY_NOT_ALLOWED',
              'A line item is in a category policy does not permit.',
              {
                sku: line.sku,
                category: line.category,
              },
            ),
          );
        }
      }
      return out;
    }

    case 'REQUIRE_ATTRIBUTES': {
      for (const line of subject.lines) {
        for (const predicate of rule.predicates) {
          if (!satisfiesPredicate(line.attributes, predicate)) {
            out.push(
              violation(
                rule,
                'ATTRIBUTE_REQUIREMENT_UNMET',
                'A line item lacks an attribute policy requires.',
                {
                  sku: line.sku,
                  attribute: predicate.name,
                  expectedAnyOf: [...predicate.anyOf].sort().join(','),
                  actual: describeAttribute(line, predicate.name),
                },
              ),
            );
          }
        }
      }
      return out;
    }

    case 'FORBID_SUBSCRIPTION': {
      if (subject.recurring) {
        out.push(
          violation(rule, 'SUBSCRIPTION_PROHIBITED', 'Policy forbids recurring charges.', {
            recurring: true,
          }),
        );
      }
      return out;
    }

    case 'MAX_SNAPSHOT_AGE_SECONDS': {
      if (subject.snapshotAgeSeconds > rule.seconds) {
        out.push(
          violation(
            rule,
            'SNAPSHOT_AGE_EXCEEDS_POLICY',
            'The snapshot is older than the policy freshness window.',
            { actualSeconds: subject.snapshotAgeSeconds, limitSeconds: rule.seconds },
          ),
        );
      }
      return out;
    }

    default:
      // Unreachable while the union and this switch agree. If a variant is
      // added without an evaluator, the compiler rejects this line.
      return assertNever(rule, 'evaluateRule');
  }
}

function describeAttribute(line: PolicySubjectLine, name: string): string {
  const values = line.attributes.filter(a => a.name === name).map(a => a.value);
  return values.length === 0 ? '<absent>' : [...values].sort().join(',');
}

function compareViolations(a: PolicyViolation, b: PolicyViolation): number {
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  const da = stableDetail(a.detail);
  const db = stableDetail(b.detail);
  if (da !== db) return da < db ? -1 : 1;
  return 0;
}

function stableDetail(detail: FindingDetail): string {
  return Object.keys(detail)
    .sort()
    .map(key => `${key}=${String(detail[key])}`)
    .join('&');
}

/**
 * Evaluates every rule in a document against a subject.
 *
 * Rules are parsed one at a time rather than as a batch so that one
 * unrecognised rule denies the transaction without hiding the results of the
 * rules that *are* understood — an operator needs to see both.
 */
export function evaluatePolicy(document: PolicyDocument, subject: PolicySubject): PolicyEvaluation {
  const violations: PolicyViolation[] = [];
  let unparseable = 0;

  document.rules.forEach((raw, index) => {
    const parsed = PolicyRuleSchema.safeParse(raw);
    if (!parsed.success) {
      unparseable += 1;
      const ruleId = readRuleId(raw) ?? `rule_at_index_${index}`;
      const ruleKind = readRuleKind(raw) ?? 'UNKNOWN';
      violations.push(
        Object.freeze({
          code: 'POLICY_RULE_UNKNOWN' as const,
          ruleId,
          ruleKind,
          severity: 'DENY' as const,
          message:
            'This build cannot interpret a rule in the bound policy; refusing rather than skipping it.',
          detail: Object.freeze({ ruleIndex: index, ruleKind }),
        }),
      );
      return;
    }
    violations.push(...evaluateRule(parsed.data, subject));
  });

  return Object.freeze({
    policyId: document.policyId,
    version: document.version,
    policyHash: computePolicyHash(document),
    violations: Object.freeze([...violations].sort(compareViolations)),
    rulesEvaluated: document.rules.length - unparseable,
    rulesUnparseable: unparseable,
  });
}

function readRuleId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = (raw as Record<string, unknown>)['ruleId'];
  return typeof value === 'string' && /^[a-z][a-z0-9_]{2,63}$/.test(value) ? value : null;
}

function readRuleKind(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = (raw as Record<string, unknown>)['kind'];
  return typeof value === 'string' && /^[A-Z_]{1,64}$/.test(value) ? value : null;
}
