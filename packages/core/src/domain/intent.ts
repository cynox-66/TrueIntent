/**
 * Authorized intent: what the user actually agreed to.
 *
 * This is the single most important correction to the Phase 0 contract. The
 * original `IntentSnapshot` was a free-text prompt plus a budget number, and it
 * arrived inside the verification request — meaning a compromised agent could
 * rewrite the user's own budget on the way to spending it.
 *
 * The model here splits the two cleanly:
 *
 * - `rawText` is the user's original words. It is carried into evidence so a
 *   dispute reviewer can read what was asked for, and it is NEVER read by any
 *   deterministic check. Free text cannot be verified; treating it as if it
 *   could is how "under 5,000" becomes an unbounded charge.
 * - `constraints` is a structured, machine-evaluable statement of the same
 *   thing, frozen at authorization time and content-addressed. Every
 *   deterministic decision reads only this.
 *
 * Turning the first into the second is *normalization*, and it happens once,
 * before any money is at stake, behind an interface that may be backed by an
 * LLM, a template, or a form. See ADR-004.
 */

import { z } from 'zod';
import { AttributePredicateSchema, type AttributePredicate } from './attributes.js';
import { CurrencyCodeSchema, MoneySchema, type CurrencyCode, type Money } from '../money.js';
import { TimestampSchema, type Timestamp } from '../time.js';
import { MerchantIdSchema, type MerchantId, type UserId } from '../ids.js';

/** How the structured constraints were produced from the user's words. */
export const IntentNormalizationMethodSchema = z.enum(['MANUAL', 'TEMPLATE', 'LLM_ASSISTED']);
export type IntentNormalizationMethod = z.infer<typeof IntentNormalizationMethodSchema>;

export const MerchantConstraintSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('ANY') }).strict(),
  z
    .object({
      mode: z.literal('ALLOWLIST'),
      merchantIds: z.array(MerchantIdSchema).min(1).max(64),
    })
    .strict(),
]);
export type MerchantConstraint = z.infer<typeof MerchantConstraintSchema>;

export const RecurrenceConstraintSchema = z.enum(['ONE_TIME_ONLY', 'RECURRING_ALLOWED']);
export type RecurrenceConstraint = z.infer<typeof RecurrenceConstraintSchema>;

export const GeographyConstraintSchema = z
  .object({
    /** ISO-3166-1 alpha-2, uppercase. */
    allowedCountries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .min(1)
      .max(64),
    /** Optional finer-grained region allowlist; null means "any region in an allowed country". */
    allowedRegions: z.array(z.string().min(1).max(64)).max(64).nullable(),
  })
  .strict();
export type GeographyConstraint = z.infer<typeof GeographyConstraintSchema>;

export const FeeConstraintsSchema = z
  .object({
    maxShipping: MoneySchema.nullable(),
    maxTax: MoneySchema.nullable(),
    maxTip: MoneySchema.nullable(),
    maxConvenienceFee: MoneySchema.nullable(),
    /**
     * Ceiling on all non-discount adjustments combined.
     *
     * This closes the "each fee is individually fine but together they blow the
     * budget" gap, which is the shape of the hidden-shipping-fee attack.
     */
    maxTotalFees: MoneySchema.nullable(),
  })
  .strict();
export type FeeConstraints = z.infer<typeof FeeConstraintsSchema>;

export const QuantityBandSchema = z
  .object({
    min: z.number().int().min(1).max(10_000),
    max: z.number().int().min(1).max(10_000),
  })
  .strict()
  .refine(band => band.min <= band.max, 'Quantity band minimum must not exceed its maximum');
export type QuantityBand = z.infer<typeof QuantityBandSchema>;

/**
 * The normalized, machine-evaluable statement of user intent.
 *
 * Every field is a hard constraint. There is no "preference" tier here on
 * purpose: a soft preference that cannot refuse a transaction has no business
 * in the money path, and belongs in the advisory layer instead.
 */
export const IntentConstraintsSchema = z
  .object({
    currency: CurrencyCodeSchema,
    /** Ceiling on the entire transaction including every fee and tax. */
    maxTotal: MoneySchema,
    /** Optional ceiling on any single unit price. */
    maxUnitPrice: MoneySchema.nullable(),
    quantity: QuantityBandSchema,
    /** Categories the purchase may fall in. Empty means "unconstrained by category". */
    allowedCategories: z.array(z.string().min(1).max(64)).max(64),
    forbiddenCategories: z.array(z.string().min(1).max(64)).max(64),
    /** Attributes the live item MUST carry, e.g. colour=black. */
    requiredAttributes: z.array(AttributePredicateSchema).max(32),
    /** Attributes that disqualify an item, e.g. colour=white. */
    forbiddenAttributes: z.array(AttributePredicateSchema).max(32),
    merchants: MerchantConstraintSchema,
    fees: FeeConstraintsSchema,
    recurrence: RecurrenceConstraintSchema,
    geography: GeographyConstraintSchema.nullable(),
    /** Maximum age of a verified snapshot at the moment of execution. */
    maxSnapshotAgeSeconds: z.number().int().min(1).max(86_400),
    notBefore: TimestampSchema,
    notAfter: TimestampSchema,
  })
  .strict()
  .refine(
    c => c.maxTotal.currency === c.currency,
    'maxTotal currency must match the intent currency',
  )
  .refine(
    c => c.maxUnitPrice === null || c.maxUnitPrice.currency === c.currency,
    'maxUnitPrice currency must match the intent currency',
  )
  .refine(c => c.notBefore < c.notAfter, 'notBefore must precede notAfter');

export type IntentConstraints = z.infer<typeof IntentConstraintsSchema>;

export const IntentNormalizationSchema = z
  .object({
    method: IntentNormalizationMethodSchema,
    /** Model identifier when an LLM assisted; null otherwise. Recorded for audit, never trusted. */
    modelId: z.string().min(1).max(128).nullable(),
    /**
     * Whether a human confirmed the structured constraints.
     *
     * An LLM-derived constraint set that nobody confirmed is a guess about what
     * the user wanted. Recording this lets an operator require confirmation for
     * high-value authorizations without the kernel having to reason about it.
     */
    confirmedByUser: z.boolean(),
  })
  .strict();
export type IntentNormalization = z.infer<typeof IntentNormalizationSchema>;

export const AuthorizedIntentSchema = z
  .object({
    /** The user's original words. Evidence only; never read by a deterministic check. */
    rawText: z.string().min(1).max(4_000),
    constraints: IntentConstraintsSchema,
    normalization: IntentNormalizationSchema,
  })
  .strict();
export type AuthorizedIntent = z.infer<typeof AuthorizedIntentSchema>;

export const AuthorizationStateSchema = z.enum(['ACTIVE', 'CONSUMED', 'REVOKED', 'EXPIRED']);
export type AuthorizationState = z.infer<typeof AuthorizationStateSchema>;

export interface AuthorizationRecord {
  readonly authorizationId: string;
  readonly userId: UserId;
  readonly sessionId: string;
  readonly intent: AuthorizedIntent;
  readonly intentHash: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly state: AuthorizationState;
  readonly createdAt: Timestamp;
  readonly revokedAt: Timestamp | null;
  readonly consumedByReleaseId: string | null;
}

/**
 * Projects the constraints into the exact shape that gets hashed.
 *
 * Money is flattened to `{currency, amountMinor}` pairs, which the canonical
 * serializer accepts, and every optional field is present as an explicit null
 * so an absent constraint can never hash the same as an unset one.
 */
export function intentHashInput(intent: AuthorizedIntent): Record<string, unknown> {
  const c = intent.constraints;
  return {
    rawText: intent.rawText,
    normalizationMethod: intent.normalization.method,
    normalizationModelId: intent.normalization.modelId,
    normalizationConfirmedByUser: intent.normalization.confirmedByUser,
    currency: c.currency,
    maxTotal: moneyForHash(c.maxTotal),
    maxUnitPrice: c.maxUnitPrice === null ? null : moneyForHash(c.maxUnitPrice),
    quantityMin: c.quantity.min,
    quantityMax: c.quantity.max,
    allowedCategories: [...c.allowedCategories].sort(),
    forbiddenCategories: [...c.forbiddenCategories].sort(),
    requiredAttributes: predicatesForHash(c.requiredAttributes),
    forbiddenAttributes: predicatesForHash(c.forbiddenAttributes),
    merchants:
      c.merchants.mode === 'ANY'
        ? { mode: 'ANY', merchantIds: null }
        : { mode: 'ALLOWLIST', merchantIds: [...c.merchants.merchantIds].sort() },
    fees: {
      maxShipping: c.fees.maxShipping === null ? null : moneyForHash(c.fees.maxShipping),
      maxTax: c.fees.maxTax === null ? null : moneyForHash(c.fees.maxTax),
      maxTip: c.fees.maxTip === null ? null : moneyForHash(c.fees.maxTip),
      maxConvenienceFee:
        c.fees.maxConvenienceFee === null ? null : moneyForHash(c.fees.maxConvenienceFee),
      maxTotalFees: c.fees.maxTotalFees === null ? null : moneyForHash(c.fees.maxTotalFees),
    },
    recurrence: c.recurrence,
    geography:
      c.geography === null
        ? null
        : {
            allowedCountries: [...c.geography.allowedCountries].sort(),
            allowedRegions:
              c.geography.allowedRegions === null ? null : [...c.geography.allowedRegions].sort(),
          },
    maxSnapshotAgeSeconds: c.maxSnapshotAgeSeconds,
    notBefore: c.notBefore,
    notAfter: c.notAfter,
  };
}

function moneyForHash(amount: Money): Record<string, unknown> {
  return { currency: amount.currency, amountMinor: amount.amountMinor };
}

function predicatesForHash(predicates: readonly AttributePredicate[]): Record<string, unknown>[] {
  return [...predicates]
    .map(p => ({ name: p.name, anyOf: [...p.anyOf].sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export type { CurrencyCode, MerchantId };
