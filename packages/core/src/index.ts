/**
 * @capturelock/core
 *
 * Core Domain Contracts and Types for CaptureLock.
 *
 * NOTE: Phase 0 environment bootstrap only.
 * No product verification logic is implemented here.
 */

import { z } from 'zod';

/**
 * CaptureLock verification verdict outcomes.
 *
 * ALLOW: All deterministic policies, live state, and intent checks passed. Money movement may proceed.
 * PAUSE: Marginal divergence, ambiguous policy, or trajectory risk detected. Requires human review.
 * DENY:  Explicit violation (stale state, budget exceeded, unauthorized merchant/category, intent divergence).
 */
export const VerificationVerdictSchema = z.enum(['ALLOW', 'PAUSE', 'DENY']);
export type VerificationVerdict = z.infer<typeof VerificationVerdictSchema>;

/**
 * Reason codes identifying why a decision was reached.
 */
export const ReasonCodeSchema = z.enum([
  'VERIFIED_MATCH',
  'STALE_PRICE',
  'STALE_INVENTORY',
  'BUDGET_EXCEEDED',
  'UNAUTHORIZED_MERCHANT',
  'UNAUTHORIZED_CATEGORY',
  'POLICY_VIOLATION',
  'INTENT_DIVERGED',
  'INTENT_MARGINAL',
  'TRAJECTORY_RATE_LIMIT_EXCEEDED',
  'TRAJECTORY_RETRY_STORM',
  'IDEMPOTENCY_CONFLICT',
  'UPSTREAM_STATE_MISMATCH',
]);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

/**
 * Snapshot of user-authorized intent at session initialization.
 */
export const IntentSnapshotSchema = z.object({
  rawIntent: z.string().min(1),
  maxBudgetMinor: z.number().int().positive(),
  currency: z.string().length(3).default('INR'),
  authorizedAt: z.string().datetime(),
  userId: z.string().min(1),
  mandateReference: z.string().optional(),
});
export type IntentSnapshot = z.infer<typeof IntentSnapshotSchema>;

/**
 * Individual item within a captured cart snapshot.
 */
export const CartItemSnapshotSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceMinor: z.number().int().nonnegative(),
  category: z.string().optional(),
  sourceRowHash: z.string().min(1),
  observedAt: z.string().datetime(),
});
export type CartItemSnapshot = z.infer<typeof CartItemSnapshotSchema>;

/**
 * Snapshot of the agent's proposed cart before capture.
 */
export const CartSnapshotSchema = z.object({
  merchantId: z.string().min(1),
  items: z.array(CartItemSnapshotSchema).min(1),
  totalAmountMinor: z.number().int().positive(),
  currency: z.string().length(3).default('INR'),
  snapshotHash: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type CartSnapshot = z.infer<typeof CartSnapshotSchema>;

/**
 * Capture-time verification request input.
 */
export const CaptureVerificationRequestSchema = z.object({
  sessionId: z.string().uuid(),
  idempotencyKey: z.string().min(8),
  intent: IntentSnapshotSchema,
  cart: CartSnapshotSchema,
  policyVersion: z.string().min(1),
  requestTimestamp: z.string().datetime(),
});
export type CaptureVerificationRequest = z.infer<typeof CaptureVerificationRequestSchema>;

/**
 * Structured response from the CaptureLock verification pipeline.
 */
export const CaptureVerificationResultSchema = z.object({
  verdict: VerificationVerdictSchema,
  reasons: z.array(ReasonCodeSchema),
  envelopeId: z.string().uuid().optional(),
  evaluatedAt: z.string().datetime(),
  executionAllowed: z.boolean(),
  idempotencyKey: z.string(),
  failureDetails: z.array(z.string()).optional(),
});
export type CaptureVerificationResult = z.infer<typeof CaptureVerificationResultSchema>;
