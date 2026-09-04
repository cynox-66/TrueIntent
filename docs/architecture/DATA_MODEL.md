# TrueIntent data model

The authoritative artefact is
`packages/persistence/src/postgres/migrations/0001_init.sql`. This document
explains why the schema looks the way it does.

## 1. The constraints are the design

The columns are unremarkable. The security-relevant content of this schema is its
constraints, because application code can be rewritten by anyone and a unique
index cannot be talked out of its job by a race.

| Constraint                                                     | What it prevents                                   |
| -------------------------------------------------------------- | -------------------------------------------------- |
| `releases_one_active_per_authorization` (partial unique index) | one authorization funding two concurrent purchases |
| `releases.client_idempotency_key UNIQUE`                       | two answers for one client request                 |
| `releases.receipt UNIQUE`                                      | one cart paid for twice                            |
| `releases.provider_payment_id UNIQUE`                          | two releases claiming one payment                  |
| `webhook_inbox.provider_event_id PRIMARY KEY`                  | reprocessing a redelivered webhook                 |
| `evidence_envelopes UNIQUE (chain_id, sequence)`               | the evidence chain forking                         |
| append-only triggers on `evidence_envelopes`, `evaluations`    | an operator editing the audit trail                |

The partial index deserves its full text, since it is the single most important
line in the schema:

```sql
CREATE UNIQUE INDEX releases_one_active_per_authorization
  ON releases (authorization_id)
  WHERE state NOT IN ('SETTLED','DENIED','CAPTURE_REJECTED','FAILED','ABORTED');
```

Ten concurrent requests to spend one mandate all issue the insert. Postgres lets
exactly one through and rejects nine. Proven in `postgres.db.test.ts`.

## 2. Entities

```
policies ──┐
           │ (policy_id, version)
authorizations ──┬── verified_snapshots ──┬── releases ──┬── webhook_inbox
                 │                        │              └── review_requests
                 └── evaluations ─────────┘

evidence_envelopes  — chained per authorization, independent of the above
```

### `policies`

Versioned, content-addressed rule documents. `rules` is `JSONB` because a rule
kind may postdate the binary reading it; each rule is parsed individually at
evaluation time and an unreadable one denies ([ADR-003](../decisions/ADR-003-policy-representation.md)).

### `authorizations`

The user-granted mandate. Carries `raw_intent_text` (audit only, never read by a
deterministic check) _and_ `constraints` (structured, machine-evaluable). Both
`intent_hash` and `policy_hash` are re-verified at every evaluation, so editing
the stored rows — raising a budget in the database — is detected rather than
enforced ([ADR-004](../decisions/ADR-004-authorized-intent-and-untrusted-input.md)).

### `verified_snapshots`

A **server-issued** priced quote. The cart, every unit price, the fee quote and
the total are computed by TrueIntent from a live merchant read. The agent
proposes SKUs and quantities and receives an opaque id; it never states an amount
it will be charged. `snapshot_hash` is `UNIQUE`, and `redeemed_by_release_id`
means a quote can be paid for once
([ADR-008](../decisions/ADR-008-freshness-proposed-versus-live.md)).

### `releases`

One attempt to move money, and the state machine's home. Both idempotency layers
live here: the agent-chosen `client_idempotency_key` with its
`request_fingerprint`, and the server-derived `receipt`. `in_flight_since` is set
before a provider call and cleared after — a non-null value on a stuck row is how
the reconciliation sweep finds work.

### `evaluations`

One immutable row per kernel decision, with `context_hash` and `decision_hash`.
Append-only by trigger.

### `webhook_inbox`

The provider's event id **is** the primary key, so deduplication is a constraint
violation rather than a prior `SELECT` that could race. Unverified events are
never stored, so a forged event cannot occupy an id a genuine delivery may need.

### `evidence_envelopes`

One chain per authorization: a natural audit unit, so a reviewer can verify one
purchase without reading the whole ledger. Appends take a per-chain advisory lock
inside the transaction; `UNIQUE (chain_id, sequence)` is the backstop
([ADR-007](../decisions/ADR-007-evidence-model.md)).

### `idempotency_records`

Request-scoped idempotency, added in Phase 2 and distinct from the
release-scoped key on `releases`. The provider's own key is the primary key, so
two concurrent requests race on the constraint rather than on a prior `SELECT`.
The `IN_FLIGHT` row commits _before_ the work begins, which is what lets a
crash mid-request be told apart from a first attempt
([ADR-013](../decisions/ADR-013-request-scoped-idempotency.md)).

### `review_requests`

A paused release awaiting a human. `snapshot_hash` binds the review to one exact
cart — re-quoting produces a different hash and needs a new review, so an
approval cannot be reused for a cart the reviewer never saw. A partial unique
index allows one open review per release.

## 3. Money in the database

`BIGINT` minor units plus a `CHAR(3)` currency. No `NUMERIC`, no `FLOAT`.

`pg` returns `BIGINT` as a string, and the mapping layer parses it and asserts
`Number.isSafeInteger` rather than coercing — a value large enough to lose
precision throws instead of quietly rounding. Verified by a round-trip test at
₹99,999,999,999.99.

## 4. What is deliberately absent

- **No secrets.** The evidence signing key lives in the environment; Razorpay
  credentials are never persisted.
- **No agent-supplied prices.** There is no column for one.
- **No mutable audit rows.** Enforced by trigger, not convention.
- **No partitioning.** Phase 0 listed this as open. A prototype's evidence table
  does not need it, and partitioning an append-only table is a routine later
  change.

## 5. Migrations

Hand-written SQL rather than generated. The security-relevant parts — a `WHERE`
clause on a unique index, a `plpgsql` trigger — are exactly the things a
generator does not express, and they should be visible and reviewable in one
file ([ADR-010](../decisions/ADR-010-test-topology-and-persistence.md)).

Applied by a small runner: numbered files, in order, each inside its own
transaction that also records the row in `schema_migrations`. A failure part-way
leaves neither a half-applied schema nor a false record of success.

```bash
pnpm db:up        # start Postgres
pnpm db:migrate   # apply pending migrations
pnpm db:reset     # drop everything and reapply (refused in production)
```

## 6. Indexes added in Phase 2

`releases_transient_idx` supports the liveness sweep. It is filtered on
`updated_at` rather than `in_flight_since`, because a release stranded in a
transient state never made a provider call and so never set the latter
([ADR-011](../decisions/ADR-011-unit-of-work-and-stranded-releases.md)).

## Commerce sessions (Phase 5)

Two tables sit above the per-purchase mandate, for the bounded agentic layer.
See [ADR-021](../decisions/ADR-021-bounded-agent-authority.md).

### `commerce_sessions`

What the user delegated: an aggregate budget, a purpose in their own words, the
merchants and categories in scope, and an expiry. `bounds_hash` is recomputed on
every purchase, so raising a budget by editing the row is _detected_ rather than
enforced — the same property `intent_hash` gives a single authorization.

`reserved_minor` and `spent_minor` are the accounting. The constraint that
matters:

```sql
CONSTRAINT commerce_sessions_budget_bounded
  CHECK (reserved_minor >= 0
         AND spent_minor >= 0
         AND reserved_minor + spent_minor <= total_budget_minor)
```

That is the guarantee. `reserve`'s WHERE clause is the fast path; this is what
still refuses an overspend if the repository were ever rewritten into a
read-then-write.

### `commerce_session_purchases`

One row per purchase attempt, keyed by the authorization it minted — a purchase
attempt _is_ the mandate it created. `settlement_state` is a compare-and-set
target (`RESERVED → SETTLED | RELEASED`), which is what makes counting spend
exactly-once a property of the database rather than of the caller being invoked
exactly once.

```sql
CREATE UNIQUE INDEX commerce_session_purchases_request_idx
  ON commerce_session_purchases (session_id, purchase_request_id);
```

`purchase_request_id` is derived server-side from the session and the agent's
idempotency key, so a retried request finds this row and is handed back the
authorization it already created rather than minting a second mandate.

### One new evidence kind

`AGENT_CONTEXT` carries the `ContextCapsule`: what the user asked for, what the
agent selected, and which catalogue version it was looking at. Appended before
the order gate, so a chain reads in causal order. The kind vocabulary is
enumerated in exactly two places — `ENVELOPE_KINDS` and the CHECK constraint on
`evidence_envelopes.kind` — and a parity case appends a full capsule through both
stores so a disagreement between them fails the build.

### One read projection, no new tables

The buyer surface added no schema. `GET /v1/sessions/:id/timeline` is a
projection over what is already stored — the session, its purchase rows, the
releases those authorizations produced, the evaluations recorded against them,
and the evidence chain.

One read was missing and was added to the release repository:
`listByAuthorization`, which includes terminal releases. `findActiveByAuthorization`
deliberately excludes them, because it answers "is this mandate busy?" — and a
read surface built on it showed nothing for a _refused_ purchase, which is the
case the product exists to demonstrate. Both stores implement it and the parity
suite compares them, including the ordering tiebreak under a limit.
