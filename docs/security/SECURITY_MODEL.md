# CaptureLock security model

## 1. The invariants

1. **The agent never has final authority over money.** Every decision is made by
   a deterministic function operating on server-resolved data.
2. **The agent cannot state a security-relevant value.** No price, no total, no
   intent, no policy version, no timestamp. The request schemas are `.strict()`,
   so an attempt is a validation failure rather than something ignored.
3. **Default deny.** ALLOW requires a completed run of every mandatory stage with
   no findings. Anything else refuses.
4. **No exception path can approve.** A stage that throws becomes a recorded
   `ERRORED` outcome plus a DENY finding.
5. **At most once, honestly scoped.** At-most-once money movement enforced by
   database constraints; eventually-consistent knowledge of settlement. Not
   end-to-end exactly-once — see §5.
6. **Every decision is reproducible.** The kernel is pure, so an auditor can
   re-run it from stored evidence and compare hashes.
7. **Probabilistic components may only restrict.** The advisory layer can lower a
   verdict and never raise one.

## 2. Layers

```
6  Evidence          Ed25519-signed hash chain, replayable, append-only by trigger
5  Exactly-once      partial unique index, CAS, webhook inbox, write-ahead states
4  Freshness         live merchant re-read at both gates; unreachable ⇒ refuse
3  Policy            operator rules; unknown or inapplicable rule ⇒ refuse
2  Intent            user constraints, checked against LIVE state not agent claims
1  Authority         authorization validity, ownership, session, hash integrity
0  Structural        schema validation, recomputed arithmetic, currency consistency
────────────────────────────────────────────────────────────────────────────────
   Advisory          OUTSIDE the kernel; may only restrict, never grant
   Session           ABOVE the kernel; aggregate budget and delegated scope.
                     Refuses before a mandate exists, so it can only ever
                     subtract from what the kernel would have allowed.
```

## 3. Where each attack stops

**A compromised agent tries to overspend.** It cannot say what its budget is —
there is no field. The constraints are loaded by id and `intentHash` is
re-verified, so editing the database row is detected. The cart total is
recomputed from server-priced line items, and the intent stage compares it against
the authorized ceiling. `INTENT_TOTAL_EXCEEDED`, DENY, before any provider call.

**A compromised agent overspends one purchase at a time.** Each transaction is
individually within its ceiling, and together they exceed what the user
delegated — the failure a per-transaction check structurally cannot see. The
session's aggregate budget refuses it twice over: an atomic reservation whose
`WHERE` clause carries the whole predicate, backed by the
`commerce_sessions_budget_bounded` CHECK constraint, and the derived mandate's
own ceiling of `min(maxPerPurchase, remainingBudget)`, which puts the same
refusal inside the pure kernel as `INTENT_TOTAL_EXCEEDED`. Neither rests on the
other being right.

**A prompt-injected model is told to capture a payment.** There is no tool for
it. The demand fails schema validation like any other malformed output, the run
ends without a purchase, and the wasted step is recorded. Asserted end to end
with a product whose name carries the instruction.

**An agent invents a SKU, or a price for one.** A draft cart line has two fields,
`sku` and `quantity`. There is no price for it to state. An invented SKU is
refused on grounding by the runtime, and again by the live merchant read at quote
time.

**An attacker raises a session budget in the database.** The bounds hash was
recorded at delegation and is recomputed on every purchase.
`SESSION_BOUNDS_HASH_MISMATCH`, refused before a mandate exists.

**A merchant raises the price a second before capture.** The capture gate reads
live state fresh and compares the live unit price against the price about to be
charged. `LIVE_PRICE_DIVERGED`, DENY. The comparison is proposed-versus-live, not
remembered-hash-versus-live, so a malicious agent cannot fabricate freshness.

**Two requests arrive simultaneously.** `releases_one_active_per_authorization`
rejects the second insert; a compare-and-set decides the winner of any state
transition. The guarantee is a database constraint, not application logic.

**The provider times out after receiving a capture.** The release is in
`CAPTURE_IN_FLIGHT`, committed before the call. There is no edge back into an
in-flight state, so no retry is expressible. Reconciliation calls `getPayment`
and adopts the provider's answer.

**Someone edits an evidence record.** The recomputed chain hash no longer matches,
and if they fix the hash too, the Ed25519 signature fails. The Postgres triggers
reject the `UPDATE` outright.

**A prompt-injected reviewer says "approve".** It cannot. The advisory layer's
severity floor means its judgement can only ever lower the verdict.

**The provider captures before our capture gate runs.** It cannot, because every
order is created with `payment_capture: 0`. Razorpay's default comes from an
account-level setting, and if that setting is auto-capture the payment goes
`created → captured` at checkout, never passing through `authorized` — the
capture gate would have nothing left to gate. Asserting manual capture per order
keeps the authorize→capture split a property of the request rather than of a
dashboard toggle. Found by live measurement in Phase 3; see
[ADR-016](../decisions/ADR-016-live-capture-verification.md).

## 4. Separation of authority

The kernel faithfully enforces whatever mandate it is given. Nothing it does
prevents an agent from _writing its own mandate_ — that has to be prevented at
the boundary, and in Phase 1 it was not.

| authority | header                            | may do                                                                |
| --------- | --------------------------------- | --------------------------------------------------------------------- |
| principal | `x-capturelock-user` / `-session` | quote, shop, request a release, request a capture                     |
| issuer    | `x-capturelock-issuer-key`        | create an authorization, **delegate or revoke a commerce session**    |
| operator  | `x-capturelock-operator-key`      | resolve a paused review, force reconciliation, **read agent context** |

Delegating a commerce session is issuer authority for the same reason creating an
authorization is: it writes a budget, and a party that can write its own budget
has not been constrained by anyone. The session id an agent presents in its
principal must be the session it is spending, so every mandate derived from a
delegation is bound to it by the authority stage's existing `SESSION_MISMATCH`
check rather than by a new mechanism.

An agent holds only the first. Without the split, an agent could mint a mandate
with its own budget, or clear its own PAUSE — either of which makes every
downstream check ceremonial. Identity is always taken from the authenticated
principal, never from a request body; comparison is constant-time; production
refuses to start without real keys.

### The demonstration surface

The buyer-facing screens are held to the same separation as everything else, and
two details are worth stating because the easy version of each would have been
wrong.

**The browser never holds an issuer key.** Delegating a budget is issuer
authority. A page that called `POST /v1/sessions` itself would need that key,
which is the exact key the architecture exists to keep away from the agent side.
Instead a dev-only route performs the delegation server-side and returns a
principal. It is guarded like the rest of `routes/dev.ts` — fake provider,
non-production, re-checked in the handler — and it creates a session with fixed
bounds it does not take from the request.

**A simulated payment is never presented as a real one.** The provider badge
reads from `/health` on the running API rather than from build configuration,
and the fake gets the louder treatment. The result banner repeats it: a captured
payment says `simulated provider, no real payment` unless Razorpay test mode is
actually wired.

## 5. Test-mode enforcement

Three independent refusals of a live Razorpay key: the Zod schema in
`packages/integrations`, the `RazorpayTestClient` constructor, and the API's
configuration loader at boot. One check is one thing to accidentally delete.

The default payment adapter is the deterministic fake, so a fresh checkout cannot
reach a real API without being explicitly configured to.

## 6. What is NOT guaranteed

Stated plainly, because a verification system that overstates itself is worse
than one that does not exist.

- **Not exactly-once end to end.** After an indeterminate capture, whether the
  money moved is unknown to us until reconciliation succeeds. If the provider
  stays unreachable the release stays stuck, which is correct and is a human's
  problem to resolve.
- **Signing-key compromise forges history.** In this prototype the key is a local
  environment variable.
- **A head witness only helps if the client kept it.** Truncation of the whole
  chain is undetectable without an independently held head.
- **Freshness is only as good as the live read.** The provider is a deterministic
  fake; a real feed could itself be stale, and CaptureLock would verify against
  the stale value faithfully.
- **Normalization error is not detectable.** Constraints that do not match what
  the user meant will be enforced correctly and wrongly.
- **`RETRY_VELOCITY_EXCEEDED` counts attempts, not a rate.** `attemptCount` is a
  lifetime counter on the release; no per-attempt timestamps are persisted, so
  `VELOCITY_WINDOW_SECONDS` reaches the finding as context and bounds nothing. A
  release that legitimately takes several attempts over an hour is treated the
  same as one that took them in a second.
- **Concurrency is proven for one process against one database.** Network
  partitions, failover and multi-region are untested.
- **The shipped advisory reviewer is a lexical heuristic**, not an intent
  classifier.
- **Semantic intent drift is caught by category, not by understanding.** Twelve
  energy drinks are refused because `beverages` is not a delegated category, not
  because anything understood that they are not a Thai dinner. An agent that
  drifted _within_ the delegated categories would not be caught by this.
- **The buyer model that ships is a small deterministic planner.** An LLM-backed
  adapter exists and implements the same interface, but is off unless configured;
  the guarantees do not depend on which is used, and that is the point of the
  interface.
- **A crash mid-purchase withholds session budget until a sweep runs.** The safe
  direction — budget unavailable rather than double-spendable — but a real
  failure mode that did not exist before the aggregate did.
- **Capture semantics were measured against the live API** and are no longer the
  open question they were. A full authorize → capture lifecycle was run in test
  mode: `payment_capture: 0` genuinely holds a payment at `authorized`, the
  capture gate ran before the provider call, and a re-capture returned
  `"This payment has already been captured"` — the exact wording the adapter
  maps to `ALREADY_CAPTURED`, pinned as a fixture. See
  [ADR-016](../decisions/ADR-016-live-capture-verification.md). What remains
  unmeasured is the _lost-response_ path itself: `CAPTURE_INDETERMINATE` is
  reached by injecting a timeout into a fake, because a real one cannot be
  induced on demand.
- **Grant single-use is per-process.** Two API instances do not share a
  consumed-nonce set. Double capture is still prevented by the state machine and
  the database constraints, but not by that mechanism.
- **A release stranded mid-provider-call stays unresolved for up to a minute**,
  by design: an empty order lookup is not proof of absence, because the
  provider's search index lags its writes.
- **This is a prototype.** It has not been through an external security review,
  a penetration test, or any compliance assessment.
