# ADR-022: The demonstration surface, and what it is not allowed to do to prove a point

- **Status**: Accepted
- **Date**: 2026-09-04
- **Builds on**: [ADR-021](ADR-021-bounded-agent-authority.md), which established the bounded agent
- **Constrains**: the buyer-facing screens added in Phase 6

## Context

Phase 5 produced a working agentic layer whose only interface was HTTP. Phase 6
added a buyer-facing surface so the thesis could be seen rather than read.

That creates a specific hazard, and it is worth naming plainly: **a
demonstration has an incentive to cheat**. The shortest path to a convincing
screen is to let the page hold the keys it needs, stage the outcomes it wants to
show, and describe a simulated payment in the same words as a real one. Each of
those would make the demo easier and would falsify the exact property being
demonstrated.

## Decisions

### 1. The browser never holds an issuer key

Delegating a budget is issuer authority. A page calling `POST /v1/sessions`
directly would need that key in the browser — which is the key the entire
architecture exists to keep away from the agent side. Shipping it so the demo
could be self-contained would have been undermining the thesis in order to
present it.

So the browser asks `POST /v1/dev/demo-session`, which performs the delegation
server-side through the same `CommerceSessionService.create` a trusted
application would use, with bounds it does not take from the request. It returns
a session id and a principal — which confers nothing an unauthenticated caller
could not already claim.

Guarded like the rest of `routes/dev.ts`: fake provider, non-production, and
re-checked in the handler rather than only at registration.

### 2. The buyer surface is not behind the operator sign-in

It would have been one line shorter to leave everything behind the existing
gate. It would also have said something false about who the screen is for: the
person delegating a budget is not an operator, holds no operator key, and should
not be asked for one. `isOperatorRoute` now draws that line explicitly, and the
default route is the buyer surface because that is the one that explains what
the system is for.

### 3. The narrative is assembled server-side

`GET /v1/sessions/:id/timeline` returns the delegation and, for each purchase,
the release, both gate decisions with their findings, the provider state and the
evidence chain. The alternative — four round trips per purchase stitched
together in a browser — would put the ordering of the story in the client, where
it could drift from what actually happened.

Everything on the result screen is read back from this projection rather than
remembered from the request that caused it. If the server and the screen ever
disagreed, the server is right and the screen shows it.

### 4. A refusal is a first-class answer, not an error

A 422 carrying reason codes is the most interesting thing this system produces.
The API client returns those bodies instead of throwing, because routing them
into a `catch` would make "CaptureLock said no" render like "something broke" —
collapsing the distinction the whole product exists to draw.

The first version discarded the parsed body and rebuilt the result from the
error's code and message, which lost the reason codes and made the screen say
"the API returned 422" about the drift refusal. `ApiError` now carries the body.

### 5. A simulated payment is never described as a real one

The provider badge reads `/health` from the running API rather than build
configuration, and the fake gets the louder treatment. The result banner repeats
it: a captured payment reads `simulated provider, no real payment` unless
Razorpay test mode is actually wired. Someone watching cannot be expected to
infer which they are seeing, and letting them assume the stronger reading would
be the most consequential thing this interface could get wrong.

### 6. Scenarios reset the world they mutate

The drift scenario changes a merchant price, and merchant state is global. The
first version left it changed, so a second run told a different story than the
first — it was refused on budget rather than on drift. A demonstration whose
outcome depends on how many times it has been clicked is not demonstrating
anything, so each run sets the price back to the baseline before it begins.

## Consequences

**Positive.** The demo is subject to the same separation it is describing. Every
figure on screen is server-resolved, every refusal is the real one, and the two
protections — authority violation and reality drift — are shown as the distinct
checks they are rather than as one check doing double duty.

**Negative.** The buyer surface depends on `routes/dev.ts` and therefore on the
fake provider and a non-production environment. It is a demonstration, not a
product an end user could point at a live merchant, and it should not be
described as one.

**Honest limitations.**

- **The delegation is fixed.** The demo session's bounds are constants in the
  dev route. A real flow would collect them from the user, and normalising free
  text into constraints is the problem ADR-004 deliberately left outside the
  money path.
- **The agent's reasoning is a deterministic planner** unless an Anthropic key
  is configured. The screen labels the model by name, so what a viewer is
  watching is stated rather than implied.
- **The restaurant is a fixture.** Two dining rows, priced so the two
  protections land on legible numbers. The drift is real in the sense that the
  merchant's store genuinely changes and the gate genuinely re-reads it, and
  staged in the sense that we chose when.
