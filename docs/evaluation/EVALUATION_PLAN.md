# TrueIntent evaluation

## 1. What is being measured, and what is not

The harness runs a committed scenario suite twice against the identical world:
once with no verification, once through TrueIntent. Run it with `pnpm eval`;
output lands in `reports/evaluation.md` and `reports/evaluation.json`.

**What the numbers mean.** Whether this system behaves as designed on cases we
chose.

**What they do not mean.** They are not a sample of real agent behaviour. No
real-world prevention rate should be inferred from them, and none is claimed. The
report says so in its own header.

The harness exits non-zero if any scenario fails to behave as declared, so it
gates a build rather than merely informing one.

## 2. The baseline is not a straw man

It reads the same merchant catalogue, calls the same provider, and charges the
same amounts. The only differences are the ones that matter:

- **It quotes once and never looks again.** Anything that changes between quote
  and capture is invisible to it. This is what an agent framework with a payment
  tool does today.
- **On a lost capture response it retries.** Without a notion of an indeterminate
  outcome there is nothing else to do. Razorpay rejects the second capture with a
  400, which the baseline records as a failure while the money has in fact moved
  — so the baseline's own ledger ends up wrong, which is its own kind of failure.

## 3. Scenarios

24 scenarios: 4 nominal, 20 adversarial, spanning the threat families in
`THREAT_MODEL.md`. Each declares its expected verdict, reason codes and whether
money should move, so a test that passes is provably testing what it names.

**Nominal (4).** Exact match; total exactly on the ceiling; a price drop before
the quote; fast capture well inside the freshness window.

**Intent drift, F2 (8).** Attribute substitution (white for black); category
drift; over budget; hidden shipping fee; excess tip; quantity inflation;
unauthorized merchant; subscription introduced.

**TOCTOU, F1 (8).** Price rises after quote; price _falls_ after quote (the user
would overpay); stock depleted; item withdrawn; fee added; attribute changed;
snapshot expired; merchant unreachable.

**Duplicate execution, F5 (4).** Same capture submitted twice; five racing
captures; capture succeeds but the response is lost then the agent retries;
settled mandate replayed for a second purchase.

## 4. Results

From the committed suite as of this writing:

| Metric                                            | Baseline   | TrueIntent     |
| ------------------------------------------------- | ---------- | -------------- |
| Unsafe charges (money moved that should not have) | 16         | **0**          |
| Unauthorized spend across the suite               | ₹90,483.00 | **₹0.00**      |
| Scenarios with more than one capture              | 1          | 0              |
| Total provider captures                           | 25         | 8              |
| Live state re-checked before capture              | never      | every scenario |
| Decisions reproducible from evidence              | 0          | 24 / 24        |
| Evidence chains verifying                         | n/a        | 24 / 24        |

- Nominal scenarios wrongly refused: **0 of 4**.
- Scenarios matching their declared expectation: **24 of 24**.

"Unsafe" means money moved that should not have: a charge where none was
authorized, or more charges than the scenario legitimately calls for.

## 5. Metrics deliberately not reported

- **Latency.** Measurable, but every measurement here would be against
  in-process fakes, so a number would describe our test doubles rather than
  anything real.
- **False-positive rate.** 0 of 4 nominal scenarios is not a rate. Four
  hand-written happy paths cannot estimate one.
- **Coverage percentage.** It would measure how much code the tests touch, not
  whether the security properties hold. The property tests — fault injection into
  every pipeline position, determinism under a faked clock, concurrency against
  real Postgres — are the meaningful measure.

## 6. Suites

| Command        | Requires     | Proves                                                                                             |
| -------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `pnpm test`    | nothing      | kernel, policy, canonicalization, evidence, FSM, adversarial scenarios, API                        |
| `pnpm test:db` | `pnpm db:up` | partial unique index, CAS under contention, webhook dedup, chain non-forking, append-only triggers |
| `pnpm eval`    | nothing      | baseline versus TrueIntent over the scenario suite                                                 |

The split and its rationale are in
[ADR-010](../decisions/ADR-010-test-topology-and-persistence.md). The short
version: the in-memory repositories cannot prove a distributed claim, so the
distributed claims are scoped to the suite that actually tests contention.
