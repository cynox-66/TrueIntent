# CaptureLock Operator Console

The human half of the system. CaptureLock refuses to complete some releases on
its own — a paused one needs a decision, an indeterminate one needs the provider
asked — and this is where that work happens.

```bash
pnpm dev    # the API, on :3000
pnpm web    # this console, on :5173
```

Vite proxies `/v1` and `/health` to `http://localhost:3000` (override with
`CAPTURELOCK_API`), so the operator key travels on a same-origin request and no
API base URL has to be configured.

## The flow it is built around

```
queue → release → evidence → replay / verify → resolve or reconcile → queue
```

Everything on screen comes from the running API. There is no fixture path in
production code: if the API is unreachable the console says so rather than
rendering something plausible.

## Operator credentials

Held in React state and nowhere else — no `localStorage`, no `sessionStorage`,
no cookie, no URL parameter. A reload signs you out, which is the correct trade
for a bearer credential sitting in a browser. The key is submitted once, checked
against `GET /v1/operator/queue`, and never rendered again.

**This is a development credential flow and the sign-in screen says so.** A real
deployment should authenticate the operator server-side so the key never reaches
the browser at all. See ADR-017.

## What it does not do

- **It does not verify signatures itself.** Chain verification and decision
  replay both run on the server; this renders their answers. A browser-side
  reimplementation checking data the same server just handed it would prove
  nothing, and could disagree with the ledger.
- **It does not explain reason codes in its own words.** Descriptions come from
  the kernel's `REASON_CODE_DEFINITIONS`, imported directly. An unrecognised
  code is shown verbatim and labelled as unrecognised.
- **It does not hold optimistic state.** After an action the release is
  re-fetched; what you see is the server's answer, not a prediction.
- **It is not a security boundary.** Every authority check is the API's. The
  console cannot resolve a review without an operator key, and neither can
  anything else.

## Layout

```
src/api/         client (credential handling, error taxonomy) and types
src/session/     the in-memory operator session
src/lib/         formatting, reason codes, hash router, async state
src/components/  shared presentational pieces
src/views/       sign-in, queue, release detail, evidence
tests/           behaviour tests; the only place fetch is ever stubbed
```
