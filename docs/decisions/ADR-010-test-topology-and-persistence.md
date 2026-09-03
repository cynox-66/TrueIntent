# ADR-010: Test topology, and why the concurrency claims are scoped

- **Status**: Accepted
- **Date**: 2026-09-03

## Context

The duplicate-execution defences rest on real database behaviour: a partial
unique index, an atomic compare-and-set, an advisory lock, append-only triggers.
An in-memory repository can _model_ those, but on a single-threaded event loop it
cannot prove anything about several API instances sharing a database. Claiming
otherwise from a passing in-memory test would be dishonest.

The competing requirement is that `pnpm test` must run offline and
deterministically, with no Docker and no network.

## Decision

**Two suites, with the claims scoped to whichever one proves them.**

|              | `pnpm test`                                                                                              | `pnpm test:db`                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Requires     | nothing                                                                                                  | `pnpm db:up`                                                                                                        |
| Repositories | in-memory                                                                                                | Postgres                                                                                                            |
| Proves       | kernel logic, policy, canonicalization, evidence, FSM, adversarial scenarios, single-process idempotency | partial unique index, CAS under contention, webhook dedup under contention, chain non-forking, append-only triggers |

The in-memory repositories are written to model the database's _semantics_
rather than to be convenient: every state change is a compare-and-set that
reports losing the race, uniqueness surfaces as a typed result, and every
mutating method does its read and write in one synchronous block with no `await`
between them. That last point makes them genuinely atomic with respect to other
tasks _in this process_ — enough to keep application code honest, not enough to
prove a distributed claim.

### Repositories use `pg` with explicit SQL

Not Drizzle, which ADR-001 anticipated. The statements are the guarantee — a CAS
with an explicit source-state list, an insert relying on a partial unique index —
and they should be readable as SQL by anyone auditing this system. A query
builder would put a layer of indirection between the reviewer and the statement
without adding safety. Drizzle remains a reasonable choice for ordinary reads if
the surface grows.

### Migrations are hand-written SQL

The security-relevant parts of the schema are things a generator does not
express: a `WHERE` clause on a unique index, a `plpgsql` trigger. Hand-writing
the migration keeps them visible and reviewable in one file.

## Consequences

**Positive.** A contributor with no Docker still gets 388 meaningful tests in
under three seconds. The concurrency claims are backed by tests that actually
exercise contention, and the documentation says which suite backs which claim.

**Negative.** Two suites to keep passing, and repository logic implemented twice.
The duplication is contained: repositories are thin, and the port interface keeps
them honest with each other.

**Honest limitation.** The Postgres suite runs concurrent statements from a
single Node process against one database. That is a real test of the database
constraints — which is the thing being claimed — but it is not a test of
multi-instance deployment, network partitions, or failover.
