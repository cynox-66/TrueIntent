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

export async function seedDemoData(
  app: Application,
): Promise<{ policyId: string; version: string }> {
  await app.deps.policies.insert(DEMO_POLICY);
  return { policyId: DEMO_POLICY.policyId, version: DEMO_POLICY.version };
}
