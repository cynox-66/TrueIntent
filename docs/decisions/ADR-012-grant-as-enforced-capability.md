# ADR-012: The execution grant as an enforced capability

- **Status**: Accepted
- **Date**: 2026-09-03
- **Extends**: the `ExecutionGrant` design introduced in Phase 1

## Context

Phase 1 made `ExecutionGrant` unforgeable — a module-private `unique symbol`
brand, minted only by the kernel, only for an ALLOW. That part held up.

What did not hold up is how it was _used_. `ReleaseService` held a raw
`PaymentProvider`, and `PaymentProvider.capturePayment` took
`{ paymentId, amount }`. The grant was passed _alongside_ the provider call, not
required by it. Enforcement rested on three layers of discipline:

1. only the composition root constructs a provider,
2. only `ReleaseService` receives it,
3. only its private `executeCapture` calls it, and only after `mintGrant`
   returned non-null.

Discipline is the part that erodes. Nothing in the type system stopped a future
edit — or a future service — from calling the provider with an arbitrary amount.

Two further gaps: a grant could be used more than once, and it never expired.

## Decision

### 1. Split the port along the line that matters

```ts
interface PaymentReader {
  findOrderByReceipt(receipt);
  getPayment(id);
}
interface PaymentExecutor<TGrant> {
  createOrder(grant: TGrant, request): Promise<CreateOrderOutcome>;
  capturePayment(grant: TGrant, request): Promise<CaptureOutcome>;
}
```

The grant is now a **precondition of the call**, not a companion to it.

The split falls naturally along read/write, and it buys something specific:
`ReconciliationService` receives only the reader. Reconciliation runs unattended
on a timer, and it **structurally cannot capture** — the method is not on the
interface it holds. That is worth more than a comment saying it should not.

`CoreDependencies` has no provider field of any kind, so the quote, webhook,
review and authorization services cannot call one either. Three bundles, three
levels of authority, checked by the compiler.

### 2. `GuardedPaymentExecutor` is the only holder of a raw provider

It enforces what the type cannot:

- **Single use.** A consumed nonce is refused.
- **Expiry.** A grant past its TTL is refused, against the injected clock.
- **Amount binding.** The amount and receipt sent to the provider are read off
  the _grant_, never off the caller's request. A caller holding a valid grant
  still cannot charge a different figure.

An invalid grant throws rather than returning a result. Reaching that point is a
programming error or an attack, and neither should be recoverable into a
provider call.

### 3. Separated authority at the API

The attack review found that this type-level rigour was being undermined at the
HTTP boundary, where two routes had no authentication at all:

- `POST /v1/authorizations` accepted `userId` from the body. **An agent could
  mint its own mandate with its own budget** — after which every downstream
  check is faithfully enforcing a mandate the agent authored. This directly
  violated the standing requirement that an agent must not create its own
  authorization.
- `POST /v1/reviews/:id/resolve` accepted `resolvedBy` from the body. **An agent
  could approve its own paused release**, and name any approver, which makes
  PAUSE indistinguishable from ALLOW.

Three authorities now, and an agent holds only the first:

| authority | header                            | may do                                      |
| --------- | --------------------------------- | ------------------------------------------- |
| principal | `x-capturelock-user` / `-session` | quote, request a release, request a capture |
| issuer    | `x-capturelock-issuer-key`        | create an authorization                     |
| operator  | `x-capturelock-operator-key`      | resolve a review, force reconciliation      |

Identity comes from the authenticated principal, never from a request body.
Comparison is constant-time. Production refuses to start without real keys; the
predictable development defaults cannot exist there.

## Alternatives rejected

- **Keeping the grant as a companion argument and relying on review.** It is
  what Phase 1 did, and it is what the attack review found had been quietly
  undermined one layer up.
- **A single `PaymentProvider` with a grant on every method.** Reconciliation
  would then have to synthesize a grant to read a payment, which is exactly the
  forgery path the brand exists to close.
- **Persisting consumed nonces.** Grants never leave the process, so an
  in-process set is the honest scope. Claiming distributed replay protection
  would overstate it.

## Consequences

**Positive.** "Nothing captures without a verdict" is checked by the compiler at
the provider boundary and by authority separation at the HTTP boundary.
Reconciliation's inability to capture is structural.

**Negative.** A generic type parameter on `PaymentExecutor<TGrant>`, because the
port lives in `core` and the grant lives in `kernel`. Slightly awkward; the
alternative was moving the grant into `core`, which would have put a
kernel-minted capability in a package the kernel's callers can see.

**Honest limitation.** Single-use enforcement is per-process. Two API instances
do not share a consumed-nonce set. This does not permit a double capture — the
release state machine and the database constraints do that — but a grant
replayed across instances within its TTL would not be caught by _this_
mechanism.
