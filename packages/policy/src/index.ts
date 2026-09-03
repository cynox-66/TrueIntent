/**
 * @capturelock/policy
 *
 * Policy Contracts, Schemas, and Predicate Types for CaptureLock.
 *
 * NOTE: Phase 0 environment bootstrap only.
 * No compilation or rule evaluation logic is implemented here.
 */

import { z } from 'zod';
import type { CartSnapshot, IntentSnapshot } from '@capturelock/core';

export const PolicyRuleTypeSchema = z.enum([
  'BUDGET_CAP',
  'ALLOWED_MERCHANTS',
  'ALLOWED_CATEGORIES',
  'PROHIBITED_CATEGORIES',
  'MAX_DISCOUNT_PERCENTAGE',
  'MAX_QUANTITY_PER_ITEM',
  'VELOCITY_LIMIT',
]);
export type PolicyRuleType = z.infer<typeof PolicyRuleTypeSchema>;

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: PolicyRuleTypeSchema,
  enabled: z.boolean().default(true),
  parameters: z.record(z.unknown()),
  failureAction: z.enum(['DENY', 'PAUSE']).default('DENY'),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  rules: z.array(PolicyRuleSchema),
  createdAt: z.string().datetime(),
});
export type PolicyDefinition = z.infer<typeof PolicyDefinitionSchema>;

export interface PolicyRuleEvaluation {
  ruleId: string;
  ruleName: string;
  passed: boolean;
  reason?: string;
}

export interface PolicyEvaluationResult {
  policyVersion: string;
  allPassed: boolean;
  ruleResults: PolicyRuleEvaluation[];
  evaluatedAt: string;
}

/**
 * Interface contract for future policy compilers.
 */
export interface IPolicyCompiler {
  compile(definition: PolicyDefinition): Promise<CompiledPolicy>;
}

export interface CompiledPolicy {
  version: string;
  hash: string;
  evaluate(intent: IntentSnapshot, cart: CartSnapshot): Promise<PolicyEvaluationResult>;
}
