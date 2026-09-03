/**
 * Request schemas.
 *
 * Note what these do *not* accept. There is no field for a price, a total, an
 * intent, a policy version, or a timestamp. Every one of those is
 * security-relevant, and every one is loaded or computed server-side. The agent
 * supplies identifiers, quantities and its own idempotency key; nothing else it
 * sends can influence what it is charged.
 */

import { z } from 'zod';
import {
  AuthorizationIdSchema,
  IdempotencyKeySchema,
  MerchantIdSchema,
  ReleaseIdSchema,
  ReviewIdSchema,
  SkuSchema,
  AttributePredicateSchema,
  CurrencyCodeSchema,
  MoneySchema,
  TimestampSchema,
} from '@capturelock/core';

/**
 * Note what is absent: `userId` and `sessionId`.
 *
 * Identity is taken from the authenticated principal. A body-supplied user id
 * would let whoever holds the issuer key mint a mandate for anybody.
 */
export const CreateAuthorizationBody = z
  .object({
    rawIntent: z.string().min(1).max(4_000),
    policyId: z.string().min(3).max(64),
    policyVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    constraints: z
      .object({
        currency: CurrencyCodeSchema,
        maxTotal: MoneySchema,
        maxUnitPrice: MoneySchema.nullable().default(null),
        quantity: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).strict(),
        allowedCategories: z.array(z.string().min(1).max(64)).max(64).default([]),
        forbiddenCategories: z.array(z.string().min(1).max(64)).max(64).default([]),
        requiredAttributes: z.array(AttributePredicateSchema).max(32).default([]),
        forbiddenAttributes: z.array(AttributePredicateSchema).max(32).default([]),
        merchants: z.discriminatedUnion('mode', [
          z.object({ mode: z.literal('ANY') }).strict(),
          z
            .object({ mode: z.literal('ALLOWLIST'), merchantIds: z.array(MerchantIdSchema).min(1) })
            .strict(),
        ]),
        fees: z
          .object({
            maxShipping: MoneySchema.nullable().default(null),
            maxTax: MoneySchema.nullable().default(null),
            maxTip: MoneySchema.nullable().default(null),
            maxConvenienceFee: MoneySchema.nullable().default(null),
            maxTotalFees: MoneySchema.nullable().default(null),
          })
          .strict(),
        recurrence: z.enum(['ONE_TIME_ONLY', 'RECURRING_ALLOWED']),
        geography: z
          .object({
            allowedCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
            allowedRegions: z.array(z.string().min(1).max(64)).nullable().default(null),
          })
          .strict()
          .nullable()
          .default(null),
        maxSnapshotAgeSeconds: z.number().int().min(1).max(86_400),
        notBefore: TimestampSchema,
        notAfter: TimestampSchema,
      })
      .strict(),
    normalization: z
      .object({
        method: z.enum(['MANUAL', 'TEMPLATE', 'LLM_ASSISTED']),
        modelId: z.string().min(1).max(128).nullable().default(null),
        confirmedByUser: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const CreateQuoteBody = z
  .object({
    merchantId: MerchantIdSchema,
    lines: z
      .array(z.object({ sku: SkuSchema, quantity: z.number().int().min(1).max(10_000) }).strict())
      .min(1)
      .max(50),
    shipTo: z
      .object({
        country: z.string().regex(/^[A-Z]{2}$/),
        region: z.string().min(1).max(64).nullable().default(null),
      })
      .strict()
      .nullable()
      .default(null),
    recurring: z.boolean().default(false),
  })
  .strict();

export const CreateReleaseBody = z
  .object({
    authorizationId: AuthorizationIdSchema,
    snapshotId: z.string().regex(/^snap_[0-9a-f]{32}$/),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();

export const CaptureBody = z.object({ idempotencyKey: IdempotencyKeySchema }).strict();

/**
 * `resolvedBy` is deliberately absent: attribution comes from the authenticated
 * operator header. A self-declared approver name is not attribution.
 */
export const ResolveReviewBody = z
  .object({ resolution: z.enum(['APPROVED', 'REJECTED']) })
  .strict();

export const ReleaseIdParam = z.object({ id: ReleaseIdSchema }).strict();
export const ReviewIdParam = z.object({ id: ReviewIdSchema }).strict();
export const AuthorizationIdParam = z.object({ id: AuthorizationIdSchema }).strict();
