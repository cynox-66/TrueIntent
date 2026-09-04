# TrueIntent

> **A capture-time payment verification boundary for agentic commerce.**
> Built for the Razorpay AI Buildathon 2026 (Track 1).

TrueIntent sits between an autonomous agent and payment execution and answers
one question at the moment money moves:

> Does this transaction still match the user's authorized intent, the operator's
> policy, and live commercial reality — right now?

The property everything serves:

> **The agent never has final authority to move money.**

---

> [!WARNING]
> **Razorpay TEST MODE only.** A live-mode key is refused in three independent
> places: the integrations schema, the client constructor, and the API's
> configuration loader at boot. The default payment adapter is a deterministic
> fake, so a fresh checkout cannot reach a real API without being explicitly
> configured to. This is an engineering prototype, not a production system.

---

## Try it

```bash
pnpm db:up && pnpm db:migrate
pnpm dev            # API
pnpm web            # console, in another terminal — open /#/agent
pnpm demo agentic   # or watch the same story in a terminal
```

`/#/agent` is the buyer-facing surface. Three scenarios, each running the real
API against Postgres: a purchase that goes through, a restaurant that reprices
between the two gates, and an agent that reaches past what it was delegated.
The last two end in a refusal with **₹0 moved**, and the screen says which.

Behind it, `/#/operator` is the human control surface — the queue of anything
TrueIntent paused, and the evidence chain for anything it decided.

## What it does

A user delegates a **bounded commerce session** — a budget, a purpose, allowed
merchants and categories, an expiry. A buyer agent then shops inside it: it
searches the merchant catalogue, builds a cart, and asks TrueIntent to verify a
purchase. It never holds the key that created the session, and there is no tool
in its vocabulary for moving money.

An agent proposes SKUs and quantities. It does **not** propose prices, its own
budget, which policy applies, or what time it is — the request schemas have no
field for any of those. TrueIntent reads live merchant state, prices the cart
itself, and issues an opaque quote. At release the agent can only point at that
quote.

Verification then runs **twice**: once when the payable order is created, and
again at capture against a _fresh_ live merchant read. That second run is the
one that matters — an order approved a minute ago is refused now if the price
moved.

```
                              ┌──────────────────────────┐
 agent: SKUs + quantities ───►│  resolveContext()        │ ◄── live merchant read
                              │        │                 │     (all I/O here)
                              │        ▼                 │
                              │  evaluate(ctx)   ◄────── │  pure: no I/O, no clock,
                              │   STRUCTURAL             │  no randomness
                              │   AUTHORITY              │
                              │   SNAPSHOT               │
                              │   INTENT   ◄── live truth, not agent claims
                              │   POLICY                 │
                              │   FRESHNESS              │
                              │   EXECUTION              │
                              │        ▼                 │
                              │  ALLOW / PAUSE / DENY    │
                              │        ▼                 │
                              │  signed evidence         │
                              │  mintGrant() ◄─ ALLOW only
                              └──────────┬───────────────┘
                                         ▼
                              Razorpay (TEST MODE)
```

## Evaluation

`pnpm eval` runs 24 committed scenarios twice — once unmediated, once gated —
against the identical world:

|                                      | Baseline (no verification) | TrueIntent     |
| ------------------------------------ | -------------------------- | -------------- |
| Unsafe charges                       | 16                         | **0**          |
| Unauthorized spend                   | ₹90,483.00                 | **₹0.00**      |
| Live state re-checked before capture | never                      | every scenario |
| Decisions reproducible from evidence | 0                          | 24 / 24        |

Nominal scenarios wrongly refused: **0 of 4**.

These are results of our own committed scenario suite. They show the system
behaves as designed on cases we chose; they are **not** a measurement of real
agent behaviour. See [`docs/evaluation/EVALUATION_PLAN.md`](docs/evaluation/EVALUATION_PLAN.md).

## Design decisions worth knowing about

|                                                                          |                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The kernel is a pure function.**                                       | No I/O, no clock, no randomness. That is what makes a decision replayable from evidence, and it is enforced by a lint rule and an architecture test, not just intended.                                                                                                                            |
| **Stages cannot approve anything.**                                      | A stage reports findings; one combiner decides. ALLOW requires every mandatory stage to have completed with nothing found. A stage that throws yields DENY — tested by injecting a fault into every position.                                                                                      |
| **Freshness compares terms, not memories.**                              | Not "does the agent's remembered hash match live?" — a malicious agent just sends the current hash. It is "do the terms about to be charged match what the merchant will honour now?"                                                                                                              |
| **Duplicate prevention is a database constraint.**                       | A partial unique index allows one non-terminal release per authorization. Ten concurrent requests: one succeeds, nine are rejected by Postgres.                                                                                                                                                    |
| **Indeterminate is not failure.**                                        | Razorpay's capture is not idempotent and its order create rejects duplicate receipts, so a blind retry is _wrong_. There is no edge back into an in-flight state; recovery asks the provider what it knows.                                                                                        |
| **Probabilistic components may only restrict.**                          | The advisory intent layer can lower a verdict, never raise one. A prompt-injected reviewer cannot approve anything, and the "fail open or closed on timeout?" question dissolves.                                                                                                                  |
| **The test double is checked, not trusted.**                             | 65 cases run one operation sequence against the in-memory store and against Postgres and compare what a caller can observe — including _which_ constraint refused a write. A fake that quietly diverged is how a real defect once hid.                                                             |
| **An agent's budget is bounded in aggregate, not just per transaction.** | An 800-per-purchase mandate spent repeatedly is the failure a per-transaction ceiling structurally cannot see. A session budget refuses it twice: an atomic reservation backed by a CHECK constraint, and the derived mandate's own ceiling inside the pure kernel. Neither rests on the other.    |
| **The agent's tool vocabulary has no word for money.**                   | Not "present but guarded" — absent. A model that hallucinates `capture_payment` emits an action that fails schema validation like any other malformed output. Its draft cart lines carry a SKU and a quantity, so "the agent lied about the price" is unrepresentable rather than merely detected. |

## Quickstart

```bash
pnpm install
cp .env.example .env

pnpm db:up && pnpm db:migrate   # Postgres schema from scratch
pnpm dev                        # API on :3000, Postgres, fake provider

pnpm demo           # `agentic` — the canonical walkthrough (needs `pnpm dev`)
pnpm demo drift     #   …price drift at the capture gate, without the agent layer
pnpm demo agent     #   …an aggregate budget across several small purchases
pnpm demo review    #   …the operator flow: paused, approved, re-verified
pnpm demo happy     #   …verified at both gates, then captured

pnpm scenario       # 9 end-to-end lifecycle scenarios
pnpm eval           # baseline vs TrueIntent → reports/

pnpm test           # 708 offline + 56 console tests, no Docker
pnpm test:db        # 112 tests against real Postgres, incl. 67 parity cases
pnpm web            # operator console at :5173, proxying the API
pnpm smoke:razorpay         # opt-in: live order semantics
pnpm smoke:razorpay:capture # opt-in: live capture semantics (one browser step)

pnpm typecheck && pnpm lint && pnpm format:check && pnpm build
```

### Walk the price-drift refusal end to end

The one that matters: approved at the order gate, refused at capture, provider
never called.

```bash
pnpm dev      # in one terminal
pnpm demo     # in another
```

`pnpm demo` makes the same requests an agent, an issuer and an operator would
make — with exactly the headers each of those parties holds, and no privileged
access of any kind — and **asserts what it expects at every step**, exiting
non-zero the moment reality disagrees. So it is a check as well as a
demonstration:

```
3. Gate 1: the order gate.
   ALLOW → ORDER_CREATED, order order_fake_…
   moneyMoved: false — an order is not a charge

5. The merchant raises the price. TrueIntent is told nothing.
   INR 4799.00 → INR 5499.00 in the merchant's catalogue.

6. Gate 2: the capture gate. The kernel runs again against a fresh live read.
   DENY → DENIED (LIVE_PRICE_DIVERGED)
   moneyMoved: false. The provider was never asked to capture.

7. Replay that decision from its evidence.
   reproduced: true (a488f53c9324b41f…)
```

Two more:

```bash
pnpm demo review   # paused at BOTH gates, approved by a human, still re-verified
pnpm demo happy    # verified twice, captured, and the mandate cannot be respent
```

Then open the console at `pnpm web` and look at the release: the two verdicts
side by side, the time between them, and the two prices that differ.

> [!NOTE]
> The walkthrough used to be a block of `curl` commands sharing header strings
> through shell variables. That form is silently broken under **zsh**, which
> does not word-split an unquoted parameter expansion — every request comes back
> `400` with no hint as to why. zsh has been the macOS default since Catalina,
> so the most likely reader was the one guaranteed to hit it. If you want the
> raw HTTP, read [`scripts/demo.mts`](scripts/demo.mts); it is one call per
> step with the headers spelled out.

The same paths, without a server: `pnpm scenario 2-price-drift`,
`pnpm scenario 8-operator-approval`.

## API

|                                      |                                                         |
| ------------------------------------ | ------------------------------------------------------- |
| `POST /v1/authorizations`            | create a mandate from structured constraints            |
| `GET /v1/authorizations/:id`         |                                                         |
| `POST /v1/authorizations/:id/quotes` | server-priced quote from a live merchant read           |
| `POST /v1/releases`                  | **gate 1** — create the payable order                   |
| `POST /v1/releases/:id/capture`      | **gate 2 — money moves here, on ALLOW only**            |
| `POST /v1/releases/:id/reconcile`    | resolve an indeterminate release by asking the provider |
| `GET /v1/releases/:id`               | release state and its evaluation history                |
| `POST /v1/reviews/:id/resolve`       | operator resolves a PAUSE; approval re-verifies         |
| `POST /v1/webhooks/razorpay`         | HMAC over raw bytes, deduplicated by event id           |
| `GET /v1/operator/queue`             | **operator only** — every release awaiting a human      |
| `GET /v1/evidence/:id`               | envelope plus a live replay check                       |
| `GET /v1/evidence/chain/:id`         | an authorization's evidence timeline, in sequence       |
| `GET /v1/evidence/chain/:id/verify`  | verify an authorization's chain                         |
| `GET /v1/evidence/public-key`        | the Ed25519 key an auditor needs                        |

Three separated authorities, all header-borne and never body-supplied: a
principal (`x-capturelock-user` + `x-capturelock-session`) acts, an issuer
(`x-capturelock-issuer-key`) creates mandates, and an operator
(`x-capturelock-operator-key` + `x-capturelock-operator`) resolves reviews,
forces reconciliation and reads the queue. An agent holds only the first.

> [!NOTE]
> The project was built as **CaptureLock** and is now **TrueIntent**. The rename
> is a product one: header names, package scopes (`@capturelock/*`), hash domains
> (`capturelock.v1.*`) and database identifiers keep the original spelling,
> because changing a hash domain would invalidate every signed evidence chain
> already committed to this repository.

No endpoint moves money without passing the kernel. There is no override flag.
`POST /v1/dev/*` exists only when the provider is the fake and the environment is
not production.

## Layout

```
packages/core          domain model, money, canonical hashing, ports    (no I/O)
packages/policy        deterministic rule evaluation                    (pure)
packages/agent         bounded buyer runtime, tool vocabulary, model port
packages/kernel        pipeline, stages, combiner, FSM, services
packages/evidence      signed hash chain, replay verification
packages/integrations  Razorpay adapter + deterministic fakes
packages/persistence   SQL schema, Postgres and in-memory repositories
apps/api               thin HTTP layer
apps/eval              baseline-versus-TrueIntent harness + agentic scenarios
docs/decisions         ADR-001..022 — why, and what was rejected
```

`packages/agent` imports `core` and `zod` and nothing else — no repository, no
provider, no kernel. The strongest thing it can produce is a request for
verification, and an architecture test says so.

## What is NOT guaranteed

A verification system that overstates itself is worse than one that does not
exist. In full in [`docs/security/SECURITY_MODEL.md`](docs/security/SECURITY_MODEL.md); the short list:

- **Not exactly-once end to end.** At-most-once money movement, plus
  eventually-consistent knowledge of settlement. After an indeterminate capture
  we do not know whether money moved until reconciliation succeeds.
- **The lost-response path is unmeasured.** Capture semantics themselves _were_
  measured live — a full authorize → capture lifecycle, `payment_capture: 0`
  holding a payment at `authorized`, and the exact duplicate-capture wording
  ([ADR-016](docs/decisions/ADR-016-live-capture-verification.md)). What cannot
  be induced on demand is a genuinely lost response, so `CAPTURE_INDETERMINATE`
  is reached by injecting a timeout into a fake.
- **`RETRY_VELOCITY_EXCEEDED` counts attempts, not a rate.** No per-attempt
  timestamps are persisted, so `VELOCITY_WINDOW_SECONDS` is carried into the
  finding for context and bounds nothing.
- **Grant single-use is per-process.** Two API instances do not share a
  consumed-nonce set.
- **Signing-key compromise forges history.** The key is a local environment
  variable here.
- **Freshness is only as good as the live read**, and ours is a deterministic
  fake. A real merchant feed could itself be stale.
- **Normalization error is undetectable.** Constraints that do not match what the
  user meant are enforced correctly and wrongly.
- **Concurrency is proven for one process against one database.** Partitions and
  failover are untested.
- **No external security review**, penetration test, or compliance assessment.

## License

MIT. Developed for the Razorpay AI Buildathon 2026.
