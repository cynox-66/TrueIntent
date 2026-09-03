# ADR-003: Policy as a typed discriminated union, not a DSL

- **Status**: Accepted
- **Date**: 2026-09-03

## Context

Operator policy has to express things like "at most ₹5,000", "only these
merchants", "shipping at most 10% of the item subtotal", "no recurring charges".
The tempting move is a small expression language, because it looks flexible.

A policy language needs a parser, an evaluator, and — the part that gets
forgotten — its own security model. Every one of those is a place for a bypass
to hide: an expression that throws, an operator that coerces types
unexpectedly, a rule that silently evaluates to true.

## Decision

A closed, typed discriminated union of about fifteen rule shapes, validated by
Zod, evaluated by a pure function per variant with `assertNever` in the default
branch. Implemented in `packages/policy`.

Three properties are load-bearing:

1. **Fail closed on anything unreadable.** `PolicyDocument.rules` is typed
   `unknown[]`, and each rule is parsed _individually at evaluation time_. A rule
   this build cannot parse becomes a `POLICY_RULE_UNKNOWN` violation at DENY
   severity. It is never skipped.

   This matters because a policy is durable data that outlives the binary
   reading it. A document written by a newer deployment may contain a rule kind
   this build has never seen. If the whole document were rejected, an operator
   under pressure would delete the offending rule to make things work — failing
   open through the human. Refusing the _transaction_ while still reporting the
   rules that were understood puts the pressure in the right place.

2. **Schemas are `.strict()`.** A rule carrying `maxx` instead of `max` fails to
   parse and denies, rather than evaluating as unconstrained. A typo in a
   spending limit should not silently remove the limit.

3. **A rule that cannot be applied also denies.** A `MAX_TOTAL` denominated in
   USD against an INR transaction yields `POLICY_RULE_INAPPLICABLE` at DENY
   severity — regardless of the rule's declared severity, since the author
   intended _some_ constraint and we cannot know that a pause is what they
   meant.

Rule authors may choose `DENY` or `PAUSE` per rule. That freedom is confined to
the policy stage: structural, authority, snapshot, freshness and execution
findings keep fixed severities, so no configuration can weaken them. It is safe
in policy specifically because the policy is server-side and bound to the
authorization at issuance — the agent cannot choose it.

## Alternatives rejected

- **An expression DSL (CEL, JSONLogic, a custom grammar).** More expressive, and
  every added expression is another thing that can throw, coerce, or quietly
  evaluate to true. The threat model does not call for arbitrary expressions.
- **Policy as executable code.** Maximum flexibility, no auditability, and an
  obvious injection surface.
- **Validating the whole document up front.** Reads as safer and fails open
  through the operator, as above.

## Consequences

**Positive.** The compiler rejects a new rule kind with no evaluator. Violations
are structured (`code`, `ruleId`, `actual`, `limit`) rather than prose, so an
API response can explain a refusal precisely. Evaluation is pure, so a policy
decision replays exactly.

**Negative.** A genuinely new constraint requires a code change and a deploy,
not a configuration edit. Given that these constraints gate money, that is the
right trade.
