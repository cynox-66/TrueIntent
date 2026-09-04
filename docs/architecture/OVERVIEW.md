# CaptureLock architecture

## 1. What this is

CaptureLock is a deterministic verification boundary between an autonomous agent
and payment execution. It answers one question, at the moment money moves:

> Does this transaction still match the user's authorized intent, the operator's
> policy, and live commercial reality — right now?

The property everything else serves:

> **The agent never has final authority to move money.** The final decision is
> made by deterministic code operating on server-resolved data.

## 2. Shape of the system

```
USER ──── goal ──────► SessionAuthority (bounded budget, scope, expiry)
                                │
                                │  derives, server-side, per purchase
                                ▼
          normalization ────► AuthorizedIntent (hashed, frozen)
                                                    │
AGENT ─── proposes SKUs + quantities ───────────────┤
                                                    ▼
                                      ┌──────────────────────────┐
                                      │   CaptureLock            │
                                      │                          │
  live merchant read ────────────────►│  resolveContext()        │  all I/O here
                                      │        │                 │
                                      │        ▼                 │
                                      │  evaluate(ctx)  ◄── pure │  no I/O, no clock
                                      │    STRUCTURAL            │
                                      │    AUTHORITY             │
                                      │    SNAPSHOT              │
                                      │    INTENT                │
                                      │    POLICY                │
                                      │    FRESHNESS             │
                                      │    EXECUTION             │
                                      │        │                 │
                                      │        ▼                 │
                                      │  combine() → ALLOW       │
                                      │              PAUSE       │
                                      │              DENY        │
                                      │        │                 │
                                      │        ▼                 │
                                      │  evidence (signed chain) │
                                      │  mintGrant() ── ALLOW only
                                      └──────────┬───────────────┘
                                                 ▼
                                      PAYMENT PROVIDER (test mode)
```

## 3. The two properties that make it work

### The kernel is a pure function

`evaluate(context) → decision` performs no I/O, reads no clock, consumes no
randomness. Everything it needs is in the context it is handed. All reads happen
before it, in `resolveContext`, which deep-freezes the result.

Three things follow:

- **Replay is exact.** The evidence envelope stores the whole context; an auditor
  re-runs `evaluate` and compares decision hashes. That is the difference between
  an audit log and a proof.
- **No TOCTOU inside the pipeline.** No stage can observe a world that changed
  while an earlier stage was running.
- **The clock is data.** Freshness checks are reproducible.

Enforced by an ESLint rule scoped to the stage files, an architecture test, and
determinism tests that fake `Date.now` and `Math.random` and assert the hash is
unchanged.

### Stages cannot approve anything

A stage's entire vocabulary is "here is what I found wrong, and whether I was
able to look at all". One combiner decides:

```
any DENY finding                    → DENY
else any PAUSE finding              → PAUSE
else every mandatory stage COMPLETED → ALLOW
else                                → DENY (STAGE_DID_NOT_COMPLETE)
```

ALLOW is not the absence of a problem; it is the presence of a completed run of
every mandatory stage with nothing found. A stage that throws becomes an
`ERRORED` outcome plus a DENY finding — **there is no code path from an exception
to ALLOW**, and the tests inject a faulting stage into every position to prove it.

## 3a. The agentic layer

An `AuthorizedIntent` bounds one purchase and is consumed by the release that
spends it. That is the wrong shape for an autonomous agent making several
purchases against one delegation: an agent with an 800-per-purchase mandate
could spend 800 repeatedly, and every transaction would pass every check, because
the check it needed to fail did not exist.

`SessionAuthority` is that check. It sits above the authorization, carries an
aggregate budget, and every purchase derives its mandate from it server-side —
so the agent never mints one. The derived ceiling is
`min(maxPerPurchase, remainingBudget)`, which makes the aggregate enforced twice
and independently: by an atomic reservation backed by a CHECK constraint, and by
the kernel's own `INTENT_TOTAL_EXCEEDED` inside the pure evaluator.

The budget hold is taken before any release exists, so a crash withholds budget
rather than freeing it for a second spend. That is what let this layer be added
without changing a line of `ReleaseService`, the gates, `mintGrant`, or the
provider boundary. See [ADR-021](../decisions/ADR-021-bounded-agent-authority.md).

The agent's tool vocabulary has no word for moving money. A model that
hallucinates `capture_payment` emits an action that fails schema validation like
any other malformed output.

## 3b. The surfaces

Two, with different audiences and different authority.

| surface  | route         | holds                     | shows                                                                          |
| -------- | ------------- | ------------------------- | ------------------------------------------------------------------------------ |
| buyer    | `/#/agent`    | a principal, nothing else | the delegation, what the agent chose, both gate decisions, whether money moved |
| operator | `/#/operator` | an operator key           | the queue, release detail, agentic context, the evidence chain                 |

The buyer surface is deliberately **not** behind the operator sign-in: it is the
screen a person delegating a budget stands in front of, and putting it behind an
operator credential would have said something false about who it is for.

It never holds an issuer key either. Delegating a budget is issuer authority, so
the browser asks a dev-only route to perform the delegation server-side and
receives back only a principal — which confers nothing an unauthenticated caller
could not claim. A demo that shipped an issuer key to a page in order to be
convenient would have undermined the thing it was demonstrating.

`GET /v1/sessions/:id/timeline` assembles the story server-side: the delegation,
and for each purchase the release, both gates with their findings, the provider
state and the evidence chain. The ordering of the narrative lives on the server,
where it cannot drift from what happened.

## 4. Two gates

| Gate             | Endpoint                        | Moves money?                                        |
| ---------------- | ------------------------------- | --------------------------------------------------- |
| `ORDER_CREATION` | `POST /v1/releases`             | No — binds the terms the payer will be asked to pay |
| `CAPTURE`        | `POST /v1/releases/:id/capture` | **Yes**                                             |

The kernel runs at both, each time against a **fresh live merchant read**. An
order approved a minute ago is refused now if the price moved. That second run is
where the product earns its name.

## 5. Packages

```
core          domain model, money, canonical hashing, ports.   No I/O.
policy        deterministic rule evaluation.                   Pure.
agent         bounded buyer runtime, tool vocabulary, model port. Core + zod only.
kernel        pipeline, stages, combiner, FSM, services.       Pure core + orchestration.
evidence      signed hash chain, replay verification.
integrations  Razorpay adapter, deterministic fakes.
persistence   Drizzle-free SQL schema, Postgres + in-memory repositories.
apps/api      thin HTTP layer.
apps/eval     baseline-versus-CaptureLock harness, agentic scenarios.
```

`agent` sits deliberately outside the money path: it imports `core` and `zod`
and nothing else, so it holds no repository and no provider. The strongest thing
it can produce is a request for verification — asserted by an architecture test,
not merely intended.

The dependency graph is acyclic and `kernel` imports no framework, no driver, and
no provider — asserted by an architecture test, not just intended.

## 6. Nothing can bypass the kernel

Three independent mechanisms:

1. **Type level.** `ExecutionGrant` carries a module-private `unique symbol`
   brand. `mintGrant` is its only producer and returns `null` for any verdict
   other than ALLOW. A caller who has not been through the kernel cannot express
   the provider call.
2. **Structural.** `CoreDependencies` has no payment provider field at all. Only
   `PaymentDependencies` does, and only the release and reconciliation services
   receive it. The quote, webhook and review services _cannot_ call a provider —
   they hold no reference to one.
3. **Wiring.** The composition root is the only module that constructs a
   provider. An architecture test asserts this and that no route module imports
   one.

## 8. Persistence

Postgres is the backend; in-memory repositories remain as test doubles, selected
by `PERSISTENCE`. Production refuses to start on in-memory, because a restart
would silently lose every authorization, release and evidence record.

Migrations are numbered SQL files applied in order, each inside its own
transaction and recorded in `schema_migrations`. `pnpm db:migrate`,
`pnpm db:reset`.

## 9. Decisions that were open and are now closed

| Question                         | Resolution                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Canonical JSON scheme            | Restricted RFC 8785 subset — [ADR-002](../decisions/ADR-002-canonicalization-and-hashing.md)                         |
| Policy representation            | Typed union, fail closed on unknown rules — [ADR-003](../decisions/ADR-003-policy-representation.md)                 |
| Evidence signing primitive       | Ed25519 + hash chain — [ADR-007](../decisions/ADR-007-evidence-model.md)                                             |
| Spirit-check fallback on timeout | Dissolved: the advisory layer can only restrict — [ADR-009](../decisions/ADR-009-advisory-layer-restriction-only.md) |
| Merchant live-state ingestion    | Port with a deterministic fake — [ADR-008](../decisions/ADR-008-freshness-proposed-versus-live.md)                   |
| Idempotency key scope            | Two layers; the guarantee is a DB constraint — [ADR-006](../decisions/ADR-006-idempotency-model.md)                  |
| Session expiration horizon       | Per-authorization `notBefore`/`notAfter` plus a snapshot freshness window                                            |
| Human approval channel for PAUSE | `POST /v1/reviews/:id/resolve`, separate principal, re-verifies on approval                                          |

| Question                           | Resolution                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Bounding an agent across purchases | `SessionAuthority`, enforced twice — [ADR-021](../decisions/ADR-021-bounded-agent-authority.md)          |
| Why an agent may spend at all      | It may not. It requests; the kernel decides — [ADR-021](../decisions/ADR-021-bounded-agent-authority.md) |

| Question                        | Resolution                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Transaction boundaries          | Unit of work; three commits around the provider call — [ADR-011](../decisions/ADR-011-unit-of-work-and-stranded-releases.md)               |
| Enforcing the grant             | Grant-gated executor, split ports, separated HTTP authority — [ADR-012](../decisions/ADR-012-grant-as-enforced-capability.md)              |
| Request-level idempotency       | A third, request-scoped layer — [ADR-013](../decisions/ADR-013-request-scoped-idempotency.md)                                              |
| Driving a payment to authorized | A genuinely signed webhook through the real route — [ADR-014](../decisions/ADR-014-simulated-payer-authorization.md)                       |
| What Razorpay actually does     | Measured; two documented behaviours are wrong — [ADR-015](../decisions/ADR-015-razorpay-reality.md)                                        |
| Live capture, end to end        | `payment_capture: 0`, the capture gate, and duplicate capture, all observed — [ADR-016](../decisions/ADR-016-live-capture-verification.md) |

## 10. What remains open

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
- **Evidence key management.** A local environment key. An attacker holding it
  can forge history; production needs an HSM or KMS plus external anchoring.
- **A real merchant integration.** Both the live-state provider and the
  catalogue browse surface are one deterministic fake. A real one must reason
  about its own staleness.
- **Semantic intent drift is caught by category, not by understanding.** Twelve
  energy drinks are refused because `beverages` is not a delegated category, not
  because anything understood that they are not a Thai dinner. The advisory
  layer remains the right home for a judgement, and remains a lexical heuristic.
- **The shipped buyer model is a small deterministic planner**, unless an
  Anthropic key is configured. The architecture is what is demonstrated; the
  planner is chosen so the demonstration is reproducible.
- **Multi-instance deployment.** Concurrency is tested against real database
  contention, but from one process. Partitions and failover are untested.
- **Grant single-use is per-process.** Two API instances do not share a
  consumed-nonce set. Double capture is still prevented by the state machine and
  the database, but not by that mechanism.
