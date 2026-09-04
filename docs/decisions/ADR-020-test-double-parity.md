# ADR-020: The in-memory store is a test double, and it must be provably faithful

- **Status**: Accepted
- **Date**: 2026-09-04
- **Extends**: [ADR-010](ADR-010-test-topology-and-persistence.md), which set up the two-suite topology
- **Prompted by**: [ADR-019](ADR-019-operator-approval-at-the-capture-gate.md), whose defect hid behind a divergence

## Context

TrueIntent runs its fast suite against in-memory repositories and its
concurrency suite against Postgres. That split is deliberate and worth keeping:
one gives a sub-second feedback loop with no Docker, the other proves the things
only a database can prove.

It also creates a specific hazard, and the hazard has already fired. The
in-memory review store overwrote a row where Postgres kept it. Offline tests
passed. Postgres would have behaved differently. Nobody noticed, because nothing
was comparing the two — and in the meantime, reasoning about the operator flow
had come to rest on the fake's behaviour rather than the database's.

That is the worst shape a testing bug can take. It does not make tests fail. It
makes them **pass for a reason that is not true in production**.

A second instance of the same shape was found while writing this: the
`Database.migrate()` test helper applied `0001_init.sql` and nothing else, so
three suites had been running against a schema missing the entire second
migration. Not a divergence between the fake and the database — a divergence
between the _test database_ and the real one, one level further down and
correspondingly harder to see.

## Decision

**Assert parity mechanically, as a test, over the operations callers actually
perform.**

`packages/persistence/tests/parity.db.test.ts` runs the same operation sequence
against both backends and compares what a caller can observe. It is the only
place in the repository where the two implementations meet.

Three choices shape it.

**1. Compare observable behaviour, not implementation.** Return values, the
state visible through subsequent reads, and whether an operation was refused —
and, for a refusal, _which constraint_ refused it, because a store that rejects
a write for the wrong reason is not equivalent. Deliberately excluded: error
classes (requiring the fake to impersonate `pg` teaches nothing), generated
identifiers, and JSON key order.

**2. When the two disagree, the fake changes.** Postgres is the production
store; its constraints are the guarantee. Loosening SQL to match a double would
be deleting a safety property to make a test pass. Every divergence found was
resolved by making the fake stricter or better-ordered.

**3. Name the constraint in both places.** Each uniqueness check in the fake
carries the Postgres constraint name it stands in for, and the harness compares
that name. A constraint renamed in SQL and not in the fake now fails the build,
so the correspondence cannot rot silently.

**What the fake deliberately does not model** — and this is the part that has to
stay explicit rather than becoming an unstated assumption:

- **Foreign keys between tables.** Building a referential graph into a set of
  `Map`s is reimplementing a database inside a test double. Every production
  write goes through a service that has already resolved its parent row.
- **Process-restart durability.** An in-process `Map` cannot have it. The
  request-scoped idempotency layer depends on it, and it is asserted against
  Postgres alone.
- **Cross-process contention and real transaction isolation.** The fake's
  atomicity comes from running its read and write in one synchronous block on a
  single-threaded loop. That proves the application logic has the right shape;
  it says nothing about several API instances sharing a database.

Each of these is asserted directly against Postgres in a
`constraints only Postgres enforces` block, so the boundary is checked rather
than merely described.

## Divergences found, and what each meant

| Divergence                                   | The fake did        | Postgres does            | Consequence                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `releases.provider_payment_id` UNIQUE        | not modelled        | refuses                  | Two releases could hold one payment. The capture gate presents `release.providerPaymentId` with _this_ release's amount, so an offline test could not see a payment being capturable for the wrong figure.                    |
| `releases.provider_order_id` UNIQUE          | not modelled        | refuses                  | Two releases could claim one order.                                                                                                                                                                                           |
| `releases.receipt` UNIQUE                    | overwrote its index | refuses                  | A duplicate receipt is the same cart heading to the provider twice — the exact thing deriving the receipt from (authorization, snapshot hash) exists to prevent. The fake also re-pointed its lookup at the _second_ release. |
| `releases_pkey`                              | overwrote the row   | refuses                  | A release record could be silently replaced.                                                                                                                                                                                  |
| `verified_snapshots.snapshot_hash` UNIQUE    | not modelled        | refuses                  | Two snapshots could claim to be the same priced cart.                                                                                                                                                                         |
| `review_requests` PK                         | **overwrote**       | `ON CONFLICT DO NOTHING` | The one that already fired. A resolved review — its approval, its operator, its binding — replaced by a fresh OPEN row, in a table that is part of the audit record.                                                          |
| `evaluations.listByRelease` order            | insertion order     | `evaluated_at ASC`       | The console reads the last evaluation per gate to decide which verdicts it is contrasting, so the release page could tell a different story from production.                                                                  |
| `findRequiringReconciliation` order          | insertion order     | `in_flight_since ASC`    | Under a limit this returns a different _set_, so the sweeper picks up different work.                                                                                                                                         |
| `findAbandonedInTransientState` order        | insertion order     | `updated_at ASC`         | Same.                                                                                                                                                                                                                         |
| `webhookInbox.markProcessed` null release id | cleared it          | `COALESCE`, keeps it     | The service calls this with null where no release matched; the fake would have erased the record of which release an event was applied to.                                                                                    |
| `policies.insert` repeat                     | **overwrote**       | `ON CONFLICT DO NOTHING` | An authorization is bound to its policy by hash at issuance. A store that let a re-insert replace the rules would be performing the substitution the hash check exists to detect.                                             |

Two changes went the other way, to the SQL rather than to the fake, because the
SQL was under-specified rather than wrong:

- `findRequiringReconciliation` and `findAbandonedInTransientState` ordered by a
  timestamp alone. Two rows sharing one ordered arbitrarily, so a limit could
  return a different set on each call and no double could match a behaviour that
  is not defined. `release_id` now makes both orderings total.
- `evaluations.listByRelease` likewise: both gates take their timestamp once at
  the start of an evaluation, so two evaluations can share an instant.
  `evaluation_id` now breaks the tie.

Neither weakens anything; both make an existing behaviour defined.

## Consequences

- An offline test that exercises a sequence covered here now proves something
  about production, and that claim is checked on every `pnpm test:db` rather
  than believed.
- The fake is stricter than it was, so a future service that violates a schema
  constraint fails offline instead of at the database.
- Adding a constraint to the schema now means adding it to the fake and to the
  parity suite. That is the cost, and it is the right one: an unmodelled
  constraint is an offline suite that lies.
- `Database.migrate()` delegates to the real migration runner, so the test
  schema is the production schema by construction rather than by a hard-coded
  filename.

## What this does not claim

Parity is asserted over the sequences in the suite, not over all possible
sequences. Property-based generation was considered and rejected for now: the
divergences here were found by reading the schema and asking "does the double
model this?", and a generator producing random valid sequences would have
struggled to reach several of them (the review-id reuse needs a resolve between
two inserts; the null-release-id case needs a specific two-call order). A
hand-authored suite whose cases each name the invariant they protect is more
useful to a reader and easier to keep honest. If the operation surface grows
substantially, revisit.
