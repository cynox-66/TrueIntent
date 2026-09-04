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
```

## 3. Where each attack stops

**A compromised agent tries to overspend.** It cannot say what its budget is —
there is no field. The constraints are loaded by id and `intentHash` is
re-verified, so editing the database row is detected. The cart total is
recomputed from server-priced line items, and the intent stage compares it against
the authorized ceiling. `INTENT_TOTAL_EXCEEDED`, DENY, before any provider call.

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

| authority | header                            | may do                                        |
| --------- | --------------------------------- | --------------------------------------------- |
| principal | `x-capturelock-user` / `-session` | quote, request a release, request a capture   |
| issuer    | `x-capturelock-issuer-key`        | create an authorization                       |
| operator  | `x-capturelock-operator-key`      | resolve a paused review, force reconciliation |

An agent holds only the first. Without the split, an agent could mint a mandate
with its own budget, or clear its own PAUSE — either of which makes every
downstream check ceremonial. Identity is always taken from the authenticated
principal, never from a request body; comparison is constant-time; production
refuses to start without real keys.

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
- **Concurrency is proven for one process against one database.** Network
  partitions, failover and multi-region are untested.
- **The shipped advisory reviewer is a lexical heuristic**, not an intent
  classifier.
- **Capture semantics are unverified against the live API.** The smoke test
  never captures, so the non-idempotent-capture behaviour underpinning
  `CAPTURE_INDETERMINATE` rests on documentation alone. Order semantics _were_
  measured, and two documented behaviours turned out to be wrong
  ([ADR-015](../decisions/ADR-015-razorpay-reality.md)) — which is reason to
  treat the unmeasured half with the same suspicion.
- **Grant single-use is per-process.** Two API instances do not share a
  consumed-nonce set. Double capture is still prevented by the state machine and
  the database constraints, but not by that mechanism.
- **A release stranded mid-provider-call stays unresolved for up to a minute**,
  by design: an empty order lookup is not proof of absence, because the
  provider's search index lags its writes.
- **This is a prototype.** It has not been through an external security review,
  a penetration test, or any compliance assessment.
