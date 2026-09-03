/**
 * Policy rules as a typed discriminated union.
 *
 * Deliberately not a DSL. A policy language would need its own parser,
 * evaluator, and — worst of all — its own security model, and every one of
 * those is a place for a bypass to hide. A closed union of about a dozen rule
 * shapes covers every constraint the threat model actually calls for, is
 * exhaustively checkable by the compiler, and can be extended by adding a
 * variant rather than by writing an interpreter. See ADR-003.
 */

import { z } from 'zod';
import {
  AdjustmentTypeSchema,
  AttributePredicateSchema,
  CurrencyCodeSchema,
  MerchantIdSchema,
  MoneySchema,
  type AdjustmentType,
  type AttributePredicate,
  type CurrencyCode,
  type MerchantId,
  type Money,
  type Severity,
} from '@capturelock/core';

/**
 * Severity a rule author may choose.
 *
 * Only DENY and PAUSE: a rule that cannot at least pause a transaction is not a
 * policy, it is a comment. INFO findings are produced by the kernel, not by
 * policy.
 */
export const RuleSeveritySchema = z.enum(['DENY', 'PAUSE']);
export type RuleSeverity = z.infer<typeof RuleSeveritySchema>;

const base = {
  ruleId: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/, 'Rule id must be lower_snake_case'),
  description: z.string().min(1).max(256),
  severity: RuleSeveritySchema,
};

export const PolicyRuleSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('MAX_TOTAL'), max: MoneySchema }).strict(),
  z.object({ ...base, kind: z.literal('MAX_UNIT_PRICE'), max: MoneySchema }).strict(),
  z
    .object({
      ...base,
      kind: z.literal('MAX_QUANTITY_PER_ITEM'),
      max: z.number().int().min(1).max(10_000),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('MAX_LINE_ITEMS'),
      max: z.number().int().min(1).max(50),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('ALLOWED_CURRENCIES'),
      currencies: z.array(CurrencyCodeSchema).min(1).max(16),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('MERCHANT_ALLOWLIST'),
      merchantIds: z.array(MerchantIdSchema).min(1).max(256),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('MERCHANT_DENYLIST'),
      merchantIds: z.array(MerchantIdSchema).min(1).max(256),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('MAX_FEE'),
      adjustmentType: AdjustmentTypeSchema,
      max: MoneySchema,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('MAX_FEE_RATIO_BPS'),
      adjustmentType: AdjustmentTypeSchema,
      /** Ratio of the item subtotal, in integer basis points. */
      basisPoints: z.number().int().min(0).max(10_000),
    })
    .strict(),
  z.object({ ...base, kind: z.literal('MAX_TOTAL_FEES'), max: MoneySchema }).strict(),
  z
    .object({
      ...base,
      kind: z.literal('PROHIBITED_CATEGORIES'),
      categories: z.array(z.string().min(1).max(64)).min(1).max(128),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('ALLOWED_CATEGORIES'),
      categories: z.array(z.string().min(1).max(64)).min(1).max(128),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('REQUIRE_ATTRIBUTES'),
      predicates: z.array(AttributePredicateSchema).min(1).max(32),
    })
    .strict(),
  z.object({ ...base, kind: z.literal('FORBID_SUBSCRIPTION') }).strict(),
  z
    .object({
      ...base,
      kind: z.literal('MAX_SNAPSHOT_AGE_SECONDS'),
      seconds: z.number().int().min(1).max(86_400),
    })
    .strict(),
]);

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type PolicyRuleKind = PolicyRule['kind'];

export const POLICY_RULE_KINDS = [
  'MAX_TOTAL',
  'MAX_UNIT_PRICE',
  'MAX_QUANTITY_PER_ITEM',
  'MAX_LINE_ITEMS',
  'ALLOWED_CURRENCIES',
  'MERCHANT_ALLOWLIST',
  'MERCHANT_DENYLIST',
  'MAX_FEE',
  'MAX_FEE_RATIO_BPS',
  'MAX_TOTAL_FEES',
  'PROHIBITED_CATEGORIES',
  'ALLOWED_CATEGORIES',
  'REQUIRE_ATTRIBUTES',
  'FORBID_SUBSCRIPTION',
  'MAX_SNAPSHOT_AGE_SECONDS',
] as const satisfies readonly PolicyRuleKind[];

export type { AdjustmentType, AttributePredicate, CurrencyCode, MerchantId, Money, Severity };
