# ADR-008: Freshness is proposed-versus-live, not remembered-hash-versus-live

- **Status**: Accepted
- **Date**: 2026-09-03
- **Supersedes**: the row-hash freshness design in `docs/research/CAPTURE_TIME_VERIFICATION_AND_TOCTOU.md`

## Context

Phase 0 described the TOCTOU defence like this: the merchant publishes a
`row_hash` per catalogue row; the agent includes the `sourceRowHash` values it
observed in its `CartSnapshot`; at capture CaptureLock re-reads the live rows and
refuses if any hash differs.

That defends against an _honest_ agent holding stale data. It does not defend
against a dishonest one, and the reason is one sentence: **the agent supplies the
hash it is compared against.** A malicious agent reads the current hash and
sends that. The comparison passes. Worse, the check _looks_ like it worked.

There was a second issue in the same area. `THREAT_MODEL.md` placed the
"Merchant Core Inventory Database" inside the trusted realm. The merchant is the
party that changes the price.

## Decision

### 1. The merchant is authoritative but adversarial

Authoritative for what it will charge; untrusted to stay inside the user's
authorization. Encoded in `packages/core/src/domain/live-state.ts` and enforced
by reading live state fresh at every gate.

### 2. The security check compares terms, not memories

At each gate the kernel reads live merchant state **now** and compares it against
**the terms about to be charged**:

- live unit price vs the price being paid — **any** difference refuses, in either
  direction. Higher means the order is underfunded; lower means the user is being
  overcharged relative to what the merchant is currently selling for. Neither is
  something to wave through, and the finding records which it was.
- live availability and stock vs the quantity
- live currency vs the transaction currency
- the merchant's current **fee quote** vs the fees being charged
- live category and attributes vs the authorized constraints

Row hashes still exist, computed by us over the merchant's values rather than
accepted from the merchant. Their job is _drift attribution_ in the evidence —
showing an operator what changed — never gating.

### 3. CaptureLock issues the snapshot, not the agent

The agent proposes SKUs, quantities and a destination. The server reads live
state, prices every line from that read, takes the merchant's own fee quote,
computes the total itself, and returns an opaque snapshot id. At release the
agent can only point at that id. **The agent never states an amount it will be
charged.**

### 4. Two gates, two live reads

The kernel runs at order creation and again at capture, each time against a fresh
read. That second read is where the product earns its name: an order approved a
minute ago is refused now if the world moved.

### 5. An unreadable merchant refuses

`LiveStateResult` is a discriminated union, so "the merchant was unreachable"
cannot be coerced into "nothing changed". The freshness, intent and policy stages
all report themselves blocked, and the combiner denies. A quote is likewise never
issued from a merchant we could not read.

## Consequences

**Positive.** A compromised agent cannot fabricate freshness, because it supplies
nothing the check reads. Fee drift becomes detectable as divergence from the
merchant's own earlier quote, not merely as a policy-ceiling breach.

**Negative.** Every gate costs a live merchant read, which is a latency and
availability cost. An unreachable merchant means no captures — availability
traded for correctness, deliberately.

**Honest limitation.** Freshness is only as good as the live read. Our
`MerchantStateProvider` is backed by a deterministic fake; a real integration
would read a merchant's authoritative store or call a signed probe endpoint, and
would have to reason about _its own_ staleness. Nothing here proves a real
merchant feed is fresh — it proves that when the feed reports a change,
CaptureLock refuses.
