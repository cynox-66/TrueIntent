# ADR-004: Authorized intent, and what the agent is allowed to say

- **Status**: Accepted
- **Date**: 2026-09-03
- **Supersedes**: `IntentSnapshot` and `CaptureVerificationRequest` as defined in Phase 0

## Context

The Phase 0 contract had this shape:

```ts
CaptureVerificationRequestSchema = z.object({
  sessionId,
  idempotencyKey,
  intent: IntentSnapshotSchema, // includes maxBudgetMinor
  cart: CartSnapshotSchema, // includes totalAmountMinor and snapshotHash
  policyVersion: z.string(),
  requestTimestamp: z.string().datetime(),
});
```

Read it as an attacker. The agent supplies:

- **its own budget** (`intent.maxBudgetMinor`) — so a compromised agent raises
  the ceiling on the way to exceeding it;
- **which policy applies** (`policyVersion`) — so it selects the most permissive
  version on the account;
- **what time it is** (`requestTimestamp`) — so it backdates to defeat any
  freshness window;
- **the cart total** (`totalAmountMinor`) — nothing recomputed it;
- **the hash of the cart** (`snapshotHash`) — the agent provided both sides of
  the comparison, so the check could only ever succeed.

Every one of those is security-relevant and every one was attacker-controlled.
The verification layer was checking the agent's claims against the agent's other
claims.

There is a second problem underneath. `IntentSnapshot` modelled intent as a free-text
prompt plus a budget number. Free text cannot be verified deterministically.
Treating a sentence as if it were a constraint is how "black running shoes under
₹5,000" becomes an unbounded charge for whatever the agent decided counted.

## Decision

**Split intent in two, and shrink what the agent may say to almost nothing.**

### 1. `rawText` versus `constraints`

`AuthorizedIntent` carries both:

- `rawText` — the user's original words, carried into evidence so a dispute
  reviewer can read what was asked for. **No deterministic check ever reads it.**
  The only component that does is the advisory layer (ADR-009), which can only
  restrict.
- `constraints` — a structured, machine-evaluable `IntentConstraints`: currency,
  total ceiling, per-unit ceiling, quantity band, allowed and forbidden
  categories, required and forbidden attributes, merchant constraint, per-fee and
  combined-fee ceilings, recurrence, geography, freshness window, validity
  window. Every deterministic decision reads only this.

Turning the first into the second is _normalization_. It happens once, at
authorization time, before any money is at stake, behind an interface that may
be backed by an LLM, a template, or a form. The method and whether a human
confirmed it are recorded, and the whole thing is hashed.

### 2. The agent supplies identifiers, not values

Requesting a release now takes exactly:

```ts
{
  (authorizationId, snapshotId, idempotencyKey);
}
```

There is no field for a price, a total, an intent, a policy version, or a
timestamp — the API schemas are `.strict()`, so supplying one is a validation
failure rather than something quietly ignored. Everything authoritative is
loaded server-side by id; everything derivable is recomputed.

### 3. Everything that pins a decision is content-addressed

- `intentHash` over the constraints, checked at every evaluation. Editing the
  stored constraints — raising a budget in the database — invalidates it, and
  the authority stage refuses rather than enforcing the new terms.
- `policyHash` bound at issuance, checked when the policy is loaded. Substituting
  a permissive document under the same id and version is detected.
- `snapshotHash` over a server-issued quote (ADR-008).

## Consequences

**Positive.** A compromised agent's entire influence over a decision is: which
authorization, which quote, which idempotency key, and what to put in a cart it
does not price. None of those can widen what it is allowed to spend.

**Negative.** Structured constraints must exist before an authorization can be
created, which pushes real work upstream into normalization. That is the correct
place for it: an ambiguous intent should be resolved while a human is present,
not while a payment is in flight.

**Honest limitation.** TrueIntent verifies against the constraints it was given.
If normalization produces constraints that do not match what the user meant — an
LLM inferring "under 5,000" as a per-item rather than a per-cart ceiling — the
kernel will faithfully enforce the wrong thing. `normalization.confirmedByUser`
records whether a human checked; enforcing that it is true for high-value
authorizations is left to operator policy and is not currently required.
