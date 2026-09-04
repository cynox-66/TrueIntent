/**
 * Demo seed.
 *
 * Inserts the policy the demo authorizations bind to. Deliberately does not
 * create an authorization or pre-approve anything: every demo flow goes through
 * the same endpoints an agent would use, so nothing in the walkthrough is
 * reachable only because a seed script arranged it.
 */

import { asTimestamp } from '@capturelock/core';
import type { PolicyDocument } from '@capturelock/policy';
import type { Application } from './composition.js';

export const DEMO_POLICY: PolicyDocument = {
  policyId: 'household_default',
  version: '1.0.0',
  name: 'Household default policy',
  createdAt: asTimestamp('2026-09-01T00:00:00.000Z'),
  rules: [
    {
      ruleId: 'max_total',
      kind: 'MAX_TOTAL',
      description: 'Operator spend ceiling',
      severity: 'DENY',
      max: { currency: 'INR', amountMinor: 500_000 },
    },
    {
      ruleId: 'merchant_allowlist',
      kind: 'MERCHANT_ALLOWLIST',
      description: 'Approved merchants only',
      severity: 'DENY',
      merchantIds: ['merchant_alpha'],
    },
    {
      ruleId: 'max_qty',
      kind: 'MAX_QUANTITY_PER_ITEM',
      description: 'At most two of any item',
      severity: 'DENY',
      max: 2,
    },
    {
      ruleId: 'max_shipping',
      kind: 'MAX_FEE',
      description: 'Shipping ceiling',
      severity: 'DENY',
      adjustmentType: 'SHIPPING',
      max: { currency: 'INR', amountMinor: 20_000 },
    },
    {
      ruleId: 'no_subscriptions',
      kind: 'FORBID_SUBSCRIPTION',
      description: 'One-time purchases only',
      severity: 'DENY',
    },
  ],
};

/**
 * A second policy whose spend ceiling pauses rather than denies.
 *
 * Every rule in `DEMO_POLICY` is a DENY, so a release bound to it can only ever
 * be allowed or refused outright — the PAUSE path, and therefore the review
 * queue and the whole operator flow, is unreachable with it. This policy makes
 * that path reachable without weakening anything: PAUSE severity is the one
 * thing a policy author is allowed to choose, precisely because the policy is
 * server-side and bound at issuance, so an agent cannot select it.
 *
 * Seeded alongside the default rather than replacing it, so the existing demo
 * behaviour is unchanged.
 */
export const DEMO_REVIEW_POLICY: PolicyDocument = {
  policyId: 'household_review',
  version: '1.0.0',
  name: 'Household policy requiring review above a low ceiling',
  createdAt: asTimestamp('2026-09-01T00:00:00.000Z'),
  rules: [
    {
      ruleId: 'review_above_ceiling',
      kind: 'MAX_TOTAL',
      description: 'Spend above this ceiling needs a human',
      severity: 'PAUSE',
      max: { currency: 'INR', amountMinor: 100_000 },
    },
    {
      ruleId: 'merchant_allowlist',
      kind: 'MERCHANT_ALLOWLIST',
      description: 'Approved merchants only',
      severity: 'DENY',
      merchantIds: ['merchant_alpha'],
    },
  ],
};

export async function seedDemoData(
  app: Application,
): Promise<{ policyId: string; version: string; reviewPolicyId: string }> {
  await app.deps.policies.insert(DEMO_POLICY);
  await app.deps.policies.insert(DEMO_REVIEW_POLICY);
  return {
    policyId: DEMO_POLICY.policyId,
    version: DEMO_POLICY.version,
    reviewPolicyId: DEMO_REVIEW_POLICY.policyId,
  };
}
