# CaptureLock

> **A capture-time payment verification boundary for agentic commerce.**
> Built for the Razorpay AI Buildathon 2026 (Track 1).

CaptureLock sits between an autonomous agent and payment execution and answers
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

## What it does

An agent proposes SKUs and quantities. It does **not** propose prices, its own
budget, which policy applies, or what time it is — the request schemas have no
field for any of those. CaptureLock reads live merchant state, prices the cart
itself, and issues an opaque quote. At release the agent can only point at that
quote.

Verification then runs **twice**: once when the payable order is created, and
again at capture against a _fresh_ live merchant read. That second run is where
the product earns its name — an order approved a minute ago is refused now if the
price moved.

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

|                                      | Baseline (no verification) | CaptureLock    |
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

|                                                    |                                                                                                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The kernel is a pure function.**                 | No I/O, no clock, no randomness. That is what makes a decision replayable from evidence, and it is enforced by a lint rule and an architecture test, not just intended.                                       |
| **Stages cannot approve anything.**                | A stage reports findings; one combiner decides. ALLOW requires every mandatory stage to have completed with nothing found. A stage that throws yields DENY — tested by injecting a fault into every position. |
| **Freshness compares terms, not memories.**        | Not "does the agent's remembered hash match live?" — a malicious agent just sends the current hash. It is "do the terms about to be charged match what the merchant will honour now?"                         |
| **Duplicate prevention is a database constraint.** | A partial unique index allows one non-terminal release per authorization. Ten concurrent requests: one succeeds, nine are rejected by Postgres.                                                               |
| **Indeterminate is not failure.**                  | Razorpay's capture is not idempotent and its order create rejects duplicate receipts, so a blind retry is _wrong_. There is no edge back into an in-flight state; recovery asks the provider what it knows.   |
| **Probabilistic components may only restrict.**    | The advisory intent layer can lower a verdict, never raise one. A prompt-injected reviewer cannot approve anything, and the "fail open or closed on timeout?" question dissolves.                             |

## Quickstart

```bash
pnpm install
cp .env.example .env

pnpm db:up && pnpm db:migrate   # Postgres schema from scratch
pnpm dev                        # API on :3000, Postgres, fake provider

pnpm scenario       # 7 end-to-end lifecycle scenarios
pnpm eval           # baseline vs CaptureLock → reports/

pnpm test           # 483 tests, offline, no Docker
pnpm test:db        # 38 tests against real Postgres
pnpm smoke:razorpay         # opt-in: live order semantics
pnpm smoke:razorpay:capture # opt-in: live capture semantics (one browser step)

pnpm typecheck && pnpm lint && pnpm format:check && pnpm build
```

### Walk the price-drift refusal end to end

The one that matters: approved at the order gate, refused at capture, provider
never called.

```bash
AGENT='-H content-type:application/json -H x-capturelock-user:user_priya -H x-capturelock-session:sess_01'
ISSUER="$AGENT -H x-capturelock-issuer-key:dev-issuer-key-not-for-production"

# 1. the USER's application issues the mandate. The agent cannot do this —
#    without the issuer key it gets 403, which is the point.
AUTH=$(curl -s $ISSUER -XPOST localhost:3000/v1/authorizations \
  -d @docs/examples/authorization.json | jq -r .authorizationId)

# 2. the agent proposes SKUs. CaptureLock prices the cart from live state.
SNAP=$(curl -s $AGENT -XPOST localhost:3000/v1/authorizations/$AUTH/quotes \
  -d '{"merchantId":"merchant_alpha","lines":[{"sku":"SKU-BLK-RUN-42","quantity":1}],
       "shipTo":{"country":"IN","region":null},"recurring":false}' | jq -r .snapshotId)

# 3. gate 1 → ALLOW, order created. No money has moved.
REL=$(curl -s $AGENT -XPOST localhost:3000/v1/releases \
  -d "{\"authorizationId\":\"$AUTH\",\"snapshotId\":\"$SNAP\",\"idempotencyKey\":\"idem-demo-0000001\"}" \
  | jq -r .releaseId)

# 4. the payer authorizes (a genuinely signed webhook through the real route)
curl -s -XPOST localhost:3000/v1/dev/simulate-authorization \
  -H 'content-type: application/json' -d "{\"releaseId\":\"$REL\"}" | jq -r .webhook.state

# 5. the merchant raises the price
curl -s -XPOST localhost:3000/v1/dev/catalog -H 'content-type: application/json' \
  -d '{"kind":"SET_PRICE","sku":"SKU-BLK-RUN-42","unitPriceMinor":549900}' >/dev/null

# 6. gate 2 → 422 DENY, LIVE_PRICE_DIVERGED. The provider is never called.
curl -s $AGENT -XPOST localhost:3000/v1/releases/$REL/capture \
  -d '{"idempotencyKey":"idem-demo-0000002"}' | jq '{verdict, state, reasonCodes, moneyMoved}'

# 7. replay that refusal from its evidence
curl -s localhost:3000/v1/evidence/<envelopeId> | jq .replay   # → {"reproduced": true}
```

Or just run `pnpm scenario 2-price-drift`.

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

No endpoint moves money without passing the kernel. There is no override flag.
`POST /v1/dev/*` exists only when the provider is the fake and the environment is
not production.

## Layout

```
packages/core          domain model, money, canonical hashing, ports    (no I/O)
packages/policy        deterministic rule evaluation                    (pure)
packages/kernel        pipeline, stages, combiner, FSM, services
packages/evidence      signed hash chain, replay verification
packages/integrations  Razorpay adapter + deterministic fakes
packages/persistence   SQL schema, Postgres and in-memory repositories
apps/api               thin HTTP layer
apps/eval              baseline-versus-CaptureLock harness
docs/decisions         ADR-001..010 — why, and what was rejected
```

## What is NOT guaranteed

A verification system that overstates itself is worse than one that does not
exist. In full in [`docs/security/SECURITY_MODEL.md`](docs/security/SECURITY_MODEL.md); the short list:

- **Not exactly-once end to end.** At-most-once money movement, plus
  eventually-consistent knowledge of settlement. After an indeterminate capture
  we do not know whether money moved until reconciliation succeeds.
- **Capture semantics are unverified against the live API.** The smoke test
  never captures. Order semantics _were_ measured, and two documented behaviours
  turned out wrong — reason to treat the unmeasured half with the same suspicion.
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
