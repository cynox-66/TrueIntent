# ADR-021: Bounded agent authority, and why it is not an execution grant

- **Status**: Accepted
- **Date**: 2026-09-04
- **Extends**: [ADR-004](ADR-004-authorized-intent-and-untrusted-input.md), which established what an agent may say
- **Builds on**: [ADR-012](ADR-012-grant-as-enforced-capability.md), whose grant remains the only path to money

## Context

TrueIntent's verification kernel was complete and its only consumer was an HTTP
client. Nothing above it demonstrated an autonomous buyer agent, and the gap was
not cosmetic: an `AuthorizedIntent` bounds **one** purchase and is consumed by
the release that spends it (`ACTIVE → CONSUMED`, one active release per
authorization, enforced by `releases_one_active_per_authorization`).

That is the right shape for a single mandate and the wrong shape for an agent
that makes several purchases against one delegation. An agent holding an
800-per-purchase mandate could spend 800 an unbounded number of times, and
**every individual transaction would pass every check we had** — because the
check it needed to fail did not exist.

Three further things were missing. There was no catalogue _discovery_ surface at
all, so an agent had no way to find a SKU before proposing one. There was no
record connecting the user's words to the cart a decision was made about, so
evidence could say what was decided and not why anyone thought the user wanted
it. And there was no runtime: no place where a model's output became a validated
action rather than an instruction.

## Decisions

### 1. SessionAuthority sits above the authorization, not beside it

```
SessionAuthority  (aggregate budget, purpose, expiry, scope)
    │
    ├── AuthorizedIntent #1 ── release ── payment
    └── AuthorizedIntent #2 ── release ── payment
```

`SessionBounds` is a deliberate **subset** of `IntentConstraints` and reuses its
own types for merchants, quantity and recurrence, so deriving a per-purchase
mandate from a session is a mechanical projection rather than a translation
layer that can drift.

Three things it is not, stated because each was a tempting alternative:

- **Not a payment credential.** It carries no provider reference, no key, no
  token. Holding one lets an agent _ask_; it does not let it charge.
- **Not an `ExecutionGrant`.** A grant is minted by the kernel for one verified
  cart and consumed milliseconds later, and its brand is a module-private
  `unique symbol` precisely so nothing else can produce one. A session is a
  long-lived statement of scope that every purchase is checked _against_.
- **Not a second state machine over money.** Release state remains authoritative
  for execution. The session record tracks scope and budget only, which is why
  budget exhaustion is derived arithmetic rather than a state: two ways to say
  "no funds left" is one way to disagree with itself.

The delegation's id **is** the principal's `sessionId`. That is the load-bearing
reuse of this phase: `AuthorizationRecord` already carried a `sessionId` and the
authority stage already refused a mismatch with `SESSION_MISMATCH`, so every
mandate derived from a session is bound to it by a check that already existed and
was already tested. There is no new binding mechanism to get wrong.

### 2. The aggregate budget is enforced twice, independently

Once by an **atomic reservation**: one statement whose `WHERE` clause carries the
entire predicate — active, unexpired, and `reserved + spent + amount <=
total_budget`. Two concurrent requests cannot both be told yes, because the row
lock serializes the updates and the loser re-evaluates against the winner's
write. Behind it sits `commerce_sessions_budget_bounded`, a CHECK constraint that
refuses an overspend even against a direct `UPDATE`. Both are asserted:
exactly two of ten concurrent 700-paise reserves succeed against a 2,000 budget,
and a direct write past the ceiling is rejected by name.

And once by the **kernel**, because the derived mandate's ceiling is
`min(maxPerPurchase, remainingBudget)`. The existing `INTENT_TOTAL_EXCEEDED`
check therefore enforces the aggregate at both gates, inside the pure evaluator,
replayable from evidence. A test bypasses the reservation entirely and leaves the
kernel as the only thing standing.

Neither mechanism relies on the other being correct.

### 3. The hold comes before the release, so the money path needed no change

A reservation is taken _before_ any release exists and resolved only once the
release is terminal. The consequence that matters: a crash anywhere in between
leaves budget **withheld**. The failure mode is a session with less money
available than it should have — recoverable by a sweep — rather than a budget
that can be spent twice.

Because safety comes from the hold rather than from the settlement, settlement
can be lazy and idempotent. That is what allows this phase to add **no line** to
`ReleaseService`, the kernel, the gates, `mintGrant`, or the provider boundary.
`sweepUnsettledPurchases` resolves stranded holds by reading the release they
belong to and adopting its answer; it calls no provider, decides nothing itself,
and leaves a live release alone rather than guessing.

### 4. The service holds issuer authority; the agent never does

Creating an authorization means writing a budget, and a party that can write its
own budget has not been constrained by anyone (AGENTS.md #27). So the agent never
mints a mandate. It presents a session id, some SKUs, quantities and an
idempotency key; `CommerceSessionService`, running server-side, derives the
mandate from bounds a human delegated earlier through a separate,
issuer-authenticated call.

`PurchaseRequest` has no field for an amount, a currency, a total, a unit price,
a verdict, a user identity or a policy. Every request schema is `.strict()`, so
an attempt to add one is a 400 rather than a value quietly ignored — and eight
such attempts are asserted at the HTTP layer. The difference between "the agent
cannot state it" and "we happen not to read it today" is the whole claim.

### 5. The tool vocabulary is the boundary, and what it lacks is the point

There is no `charge_card`, no `capture_payment`, no `call_provider`, no
`set_price`, no `resolve_review`. Not "present but guarded" — **absent**. A model
that hallucinates `CAPTURE_PAYMENT` produces an action that fails schema
validation like any other malformed output, and the run ends without a purchase.

The draft cart the runtime hands on has two fields per line, `sku` and
`quantity`, and neither is money. "The agent lied about the price" is
unrepresentable here rather than merely detected.

The runtime imports `@capturelock/core` and `zod` and nothing else, asserted by
an architecture test. It holds no repository and no provider, so the strongest
thing it can produce is a request. Running out of steps is a refusal, never tacit
approval.

### 6. Browse is grounding; the live read is authority

`MerchantCatalogProvider` is a separate port from `MerchantStateProvider` because
the two have different trust properties. A browse result tells the agent what the
merchant claims to offer, so it reasons over merchant-stated facts instead of
inventing them — and nothing in it prices anything. Every charged price comes
from the live read at quote time and is re-read at both gates.
`CatalogProductView` is a distinct type from `LiveItemState`, so a browse result
cannot reach the kernel by accident, and the wire format calls it
`indicativeUnitPriceMinor` so a reader is not invited to believe otherwise.

The fake implements both interfaces over **one mutable map**. That is deliberate:
the agent browses at one moment, the world moves, and the gate re-reads a
genuinely different world. Drift is a property of the fixture rather than
something a test stages by hand.

### 7. The ContextCapsule is evidence, not a transcript

Appended as an `AGENT_CONTEXT` envelope on the authorization's own chain, before
the order gate, so a chain reads in causal order: what the agent was trying to
buy and why, and only then what TrueIntent decided about it.

What it excludes is as considered as what it holds. **No conversation** — a model
transcript in an append-only ledger is a privacy liability that grows without
bound and proves nothing a hash cannot, so what is kept is the agent's one-line
justification plus step and refusal counts. **No credential**, since envelopes
are served over an unauthenticated read endpoint. **Nothing the agent asserted as
fact**: every price and total comes from the priced snapshot, so the capsule
records what the agent _chose_, never what it claimed things cost.

Lines are sorted by SKU, money is integer minor units, and every optional field
is an explicit null, so two logically identical capsules cannot hash differently
and report tampering where there was none.

### 8. A real model changes none of the guarantees

`BuyerModel` is a two-method port. The default is a deterministic planner — no
network, no dependency, and predictable enough that a scenario using it is
evidence about TrueIntent rather than about a model. An opt-in Anthropic adapter
implements the same interface in under a hundred lines of `fetch` with no SDK.

Its output goes through the same `parseAgentAction`, and every action it proposes
is validated against the session authority by the same runtime. A model that is
prompt-injected by a malicious product name can, at worst, propose a cart that
gets refused — asserted end to end, with a product whose name instructs the model
to capture a payment.

Every failure mode of the real adapter — timeout, non-200, unparseable body,
prose instead of JSON — is reported as unavailability, so an unreachable model
ends the run rather than licensing a guess.

## What is deterministic and what is model-driven

|                                                   | decided by                                             |
| ------------------------------------------------- | ------------------------------------------------------ |
| what to search for, which SKU to add, when to ask | the model                                              |
| whether an action is permitted by the delegation  | deterministic code, server-side                        |
| the price of anything                             | live merchant read, server-side                        |
| whether the purchase may proceed                  | the kernel, unchanged                                  |
| whether money moves                               | the kernel's grant and the guarded executor, unchanged |

The model chooses; it decides nothing.

## Consequences

**Positive.** An agent can be wrong — confused, retried, prompt-injected, or
absent — and the worst it achieves is a failed request, a PAUSE, a DENY or an
expired session. Twenty-one evaluation scenarios exercise exactly that, with zero
unauthorized charges, zero duplicate releases or captures under retry and
concurrency, and every evidence chain verifying. The existing security model is
unchanged: no gate, grant, review or FSM guarantee was modified.

**Negative.** There is more surface. A commerce session is another aggregate to
persist, another set of constraints to keep faithful between the two stores, and
another authority to reason about. The reservation adds a failure mode — budget
withheld after a crash — that did not previously exist, mitigated by a sweep
rather than eliminated.

**Honest limitations.**

- **The merchant is still a deterministic fake.** A real connector would have to
  reason about its own staleness, and the drift demonstrations depend on a world
  we control.
- **The shipped buyer model is a small planner, not an LLM**, unless configured
  otherwise. The architecture is what is being demonstrated; the planner is
  chosen so the demonstration is reproducible.
- **Intent drift is caught by category, not by understanding.** Twelve energy
  drinks are refused because `beverages` is not a delegated category, not because
  anything understood that they are not a Thai dinner. The advisory layer
  (ADR-009) remains the correct home for a semantic judgement, and it remains a
  lexical heuristic.
- **The stranded-hold sweep is single-process**, like every other sweep here.
- **Concurrency is proven for one process against one database.** The aggregate
  budget claim rests on real row contention in Postgres, which is stronger than
  the in-memory suite can offer and still weaker than a multi-instance
  deployment would require.
