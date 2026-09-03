/**
 * @capturelock/policy
 *
 * Deterministic evaluation of operator-authored constraints. Pure functions
 * only: no clock, no I/O, no randomness.
 */

export {
  POLICY_RULE_KINDS,
  PolicyRuleSchema,
  RuleSeveritySchema,
  type PolicyRule,
  type PolicyRuleKind,
  type RuleSeverity,
} from './rules.js';

export type { PolicySubject, PolicySubjectLine } from './subject.js';

export {
  PolicyDocumentSchema,
  computePolicyHash,
  type PolicyDocument,
  type PolicyRepository,
} from './document.js';

export { evaluatePolicy, type PolicyEvaluation, type PolicyViolation } from './evaluate.js';
