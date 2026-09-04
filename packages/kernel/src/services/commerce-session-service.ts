/**
 * The commerce session service: where a delegated authority becomes a purchase.
 *
 * This is the seam between open-ended agent reasoning and deterministic
 * financial execution, and its job is to translate one into the other without
 * widening anything. It does exactly four things:
 *
 *   1. checks the request against what the user delegated,
 *   2. derives a per-purchase `AuthorizedIntent` from the session bounds,
 *   3. holds the budget it is about to spend,
 *   4. hands the resulting authorization and snapshot to `ReleaseService`.
 *
 * It adds no verification of its own to the money path. Gate 1 and Gate 2 run
 * unchanged, `mintGrant` is untouched, and the provider is reached only through
 * the guarded executor the release service already holds. Nothing in this file
 * can approve a payment; the strongest thing it does is *ask*.
 *
 * ## Why the service holds issuer authority and the agent does not
 *
 * Creating an authorization is issuer authority — a mandate with a budget. An
 * agent that could mint one could write its own budget, which would make every
 * downstream check ceremonial (AGENTS.md #27). So the agent never creates a
 * mandate. It presents a session id and an idempotency key, and *this* service,
 * running server-side, derives the mandate from bounds a human delegated
 * earlier through a separate, issuer-authenticated call.
 *
 * The derived ceiling is `min(maxPerPurchase, remainingBudget)`. That single
 * line is why the aggregate budget is enforced twice, independently: once by the
 * atomic reservation, and once by the kernel's own `INTENT_TOTAL_EXCEEDED`
 * check, inside the pure evaluator, at both gates, replayable from evidence. If
 * the reservation logic in this file were wrong, the kernel would still refuse.
 *
 * ## Why the budget hold comes before the release
 *
 * A reservation is taken against the session *before* any release exists, and
 * resolved only once the release is terminal. Two consequences:
 *
 *  - A crash anywhere in between leaves the budget *withheld*. The failure mode
 *    is a session with less money available than it should have, recoverable by
 *    a sweep — not a budget that can be spent twice.
 *  - Because safety comes from the hold rather than from the settlement,
 *    settlement can be lazy and idempotent. That is what lets `ReleaseService`
 *    stay completely untouched by this phase.
 */

import {
  computeCapsuleHash,
  computeSessionBoundsHash,
  derivePurchaseRequestId,
  moneyHasMoved,
  newSessionId,
  purchaseCeiling,
  remainingBudget,
  verifySessionBoundsIntegrity,
  addSeconds,
  asSha256Hex,
  asSnapshotId,
  isTerminalReleaseState,
  money,
  type AuthorizationId,
  type AuthorizedIntent,
  type CapsuleLine,
  type ContextCapsule,
  type IdempotencyKey,
  type MerchantId,
  type Money,
  type ReasonCode,
  type SessionAuthorityRecord,
  type SessionBounds,
  type SessionId,
  type Sha256Hex,
  type Sku,
  type Timestamp,
  type UserId,
  type VerifiedSnapshot,
} from '@capturelock/core';
import { CONTEXT_CAPSULE_VERSION, MAX_SELECTION_RATIONALE } from '@capturelock/core';
import type { Principal } from '../context.js';
import type { PaymentDependencies } from './dependencies.js';
import { AuthorizationService } from './authorization-service.js';
import { QuoteService } from './quote-service.js';
import { ReleaseService, type ReleaseOutcome } from './release-service.js';

/** How long a purchase hold may sit unresolved before the sweep looks at it. */
export const DEFAULT_SETTLE_AFTER_SECONDS = 120;

export interface CreateSessionRequest {
  readonly userId: UserId;
  /** The user's own words for what this session is for. */
  readonly purpose: string;
  readonly bounds: SessionBounds;
  readonly policyId: string;
  readonly policyVersion: string;
}

export type CreateSessionResult =
  | { readonly kind: 'CREATED'; readonly session: SessionAuthorityRecord }
  | { readonly kind: 'POLICY_NOT_FOUND' };

/**
 * What an agent may say when asking to buy.
 *
 * Compare this against what it cannot say: no amount, no currency, no total, no
 * unit price, no verdict, no user identity, no policy. The lines carry SKUs and
 * quantities; everything authoritative is derived from the session and the live
 * merchant read.
 */
export interface PurchaseRequest {
  readonly sessionId: SessionId;
  readonly principal: Principal;
  readonly merchantId: MerchantId;
  readonly lines: readonly { readonly sku: Sku; readonly quantity: number }[];
  readonly idempotencyKey: IdempotencyKey;
  /** The agent's justification, for evidence. Read by no deterministic check. */
  readonly rationale: string;
  /** Model identity, for attribution in evidence. */
  readonly agentModel: string;
  readonly agentSteps: number;
  readonly agentRefusedSteps: number;
  /** Which catalogue version the agent was looking at when it chose. */
  readonly catalogVersion: string;
}

export interface PurchaseAccepted {
  readonly kind: 'DECIDED';
  readonly sessionId: SessionId;
  readonly authorizationId: AuthorizationId;
  readonly snapshotId: string;
  readonly capsuleHash: Sha256Hex;
  /** CaptureLock's answer, verbatim. This service does not interpret it. */
  readonly outcome: ReleaseOutcome;
  /** True when this request was answered from an existing purchase. */
  readonly replayedPurchase: boolean;
}

/**
 * A refusal that happened before any mandate existed.
 *
 * Distinct from a CaptureLock verdict on purpose: nothing was verified, no
 * release was created, and no evidence chain was started, because the request
 * never got far enough to deserve one.
 */
export interface PurchaseRefused {
  readonly kind: 'REFUSED';
  readonly reasonCode: ReasonCode;
  readonly detail: string;
}

export type PurchaseResult = PurchaseAccepted | PurchaseRefused;

export interface CommerceSessionDependencies extends PaymentDependencies {
  /** Present so the derived intent can be quoted; never used to price. */
  readonly settleAfterSeconds?: number;
}

export class CommerceSessionService {
  private readonly authorizations: AuthorizationService;
  private readonly quotes: QuoteService;
  private readonly releases: ReleaseService;

  constructor(private readonly deps: CommerceSessionDependencies) {
    // Composed from the existing services rather than reaching into the kernel.
    // The agent-facing layer therefore inherits every check they already make,
    // and cannot accidentally route around one.
    this.authorizations = new AuthorizationService(deps);
    this.quotes = new QuoteService(deps);
    this.releases = new ReleaseService(deps);
  }

  /**
   * Creates a bounded commerce session.
   *
   * Called with **issuer** authority at the HTTP boundary, never by an agent.
   * A session is a delegation, and a party that can create its own delegation
   * has not delegated anything.
   */
  async create(request: CreateSessionRequest): Promise<CreateSessionResult> {
    const policy = await this.deps.policies.findByIdAndVersion(
      request.policyId,
      request.policyVersion,
    );
    // A session with no enforceable operator policy would be a delegation with
    // no operator constraints at all, so it is refused rather than created —
    // the same rule `AuthorizationService.create` applies one level down.
    if (policy === null) return { kind: 'POLICY_NOT_FOUND' };

    const now = this.deps.clock.now();
    const record: SessionAuthorityRecord = {
      sessionId: newSessionId(),
      userId: request.userId,
      purpose: request.purpose,
      bounds: request.bounds,
      boundsHash: computeSessionBoundsHash(request.bounds),
      policyId: request.policyId,
      policyVersion: request.policyVersion,
      state: 'ACTIVE',
      reservedMinor: 0,
      spentMinor: 0,
      createdAt: now,
      expiresAt: request.bounds.expiresAt,
      revokedAt: null,
    };

    await this.deps.sessions.insert(record);
    return { kind: 'CREATED', session: record };
  }

  async findById(sessionId: SessionId): Promise<SessionAuthorityRecord | null> {
    return this.deps.sessions.findById(sessionId);
  }

  /** Revokes a session. Held by the issuer, on the user's behalf. */
  async revoke(sessionId: SessionId): Promise<boolean> {
    const now = this.deps.clock.now();
    const updated = await this.deps.sessions.transition(sessionId, ['ACTIVE'], 'REVOKED', {
      revokedAt: now,
    });
    return updated !== null;
  }

  /**
   * The agent's purchase request.
   *
   * Every step before the release is a refusal opportunity, and none of them
   * can approve anything. The only thing that decides whether money moves is
   * the release service, running the unchanged two-gate pipeline.
   */
  async requestPurchase(request: PurchaseRequest): Promise<PurchaseResult> {
    const now = this.deps.clock.now();

    const session = await this.deps.sessions.findById(request.sessionId);
    if (session === null) {
      return refuse('SESSION_NOT_FOUND', `No session ${request.sessionId}`);
    }

    // Ownership before anything else. Identity comes from the authenticated
    // principal, never from the request body.
    if (session.userId !== request.principal.userId) {
      return refuse('SESSION_NOT_OWNED', 'The authenticated principal does not own this session.');
    }
    // The agent presents a session id in its principal too, and it must be the
    // one it is spending. Otherwise an agent holding two sessions could spend
    // the wrong budget.
    if (request.principal.sessionId !== session.sessionId) {
      return refuse(
        'SESSION_NOT_OWNED',
        'The presented session does not match the one being spent.',
      );
    }

    // Recompute the bounds hash: raising a budget by editing the row is
    // detected here rather than enforced, exactly as `intentHash` catches an
    // edited mandate.
    const integrity = verifySessionBoundsIntegrity(session);
    if (!integrity.valid) {
      return refuse(
        'SESSION_BOUNDS_HASH_MISMATCH',
        'The stored session bounds do not hash to the value recorded at delegation.',
      );
    }

    if (session.state === 'REVOKED') {
      return refuse('SESSION_REVOKED', 'This session was revoked.');
    }
    if (session.state === 'EXPIRED' || session.expiresAt <= now) {
      return refuse('SESSION_EXPIRED', 'This session is no longer valid.');
    }

    if (request.lines.length === 0) {
      return refuse('INVALID_AGENT_ACTION', 'A purchase must name at least one line.');
    }
    const distinct = new Set(request.lines.map(line => line.sku));
    if (distinct.size !== request.lines.length) {
      return refuse('INVALID_AGENT_ACTION', 'The same SKU appears in more than one line.');
    }

    // Merchant and quantity, against what the user delegated. Deterministic,
    // and independent of whatever the agent runtime already checked: two
    // checks, neither relying on the other having run.
    const scope = checkScope(session.bounds, request);
    if (scope !== null) return scope;

    // A repeated request resolves to the purchase it already made. This is
    // ahead of authorization creation deliberately — a retry must not mint a
    // second mandate against the same session.
    const purchaseRequestId = derivePurchaseRequestId(session.sessionId, request.idempotencyKey);
    const existing = await this.deps.sessions.findPurchaseByRequestId(
      session.sessionId,
      purchaseRequestId,
    );
    if (existing !== null) {
      return this.replayPurchase(session, existing, request);
    }

    if (remainingBudget(session).amountMinor <= 0) {
      return refuse('SESSION_BUDGET_EXCEEDED', 'This session has no budget remaining.');
    }

    // Derive the mandate. This is the issuer-authority step the agent cannot
    // perform, and the ceiling is what makes the kernel enforce the aggregate
    // budget independently of the reservation below.
    const created = await this.authorizations.create({
      userId: session.userId,
      sessionId: session.sessionId,
      intent: deriveIntent(session, request, now),
      policyId: session.policyId,
      policyVersion: session.policyVersion,
    });
    if (created.kind === 'POLICY_NOT_FOUND') {
      return refuse(
        'POLICY_NOT_FOUND',
        `Policy ${session.policyId}@${session.policyVersion} is no longer available.`,
      );
    }
    const authorization = created.authorization;
    const authorizationId = authorization.authorizationId as AuthorizationId;

    // The server prices the cart from a live merchant read. The agent supplied
    // SKUs and quantities and nothing else, so there is no price of its to
    // disagree with.
    const quote = await this.quotes.issue({
      authorizationId,
      merchantId: request.merchantId,
      lines: request.lines.map(line => ({ sku: line.sku, quantity: line.quantity })),
      shipTo: null,
      recurring: false,
    });

    if (quote.kind === 'LIVE_STATE_UNAVAILABLE') {
      return refuse('LIVE_STATE_UNAVAILABLE', `The merchant could not be read: ${quote.reason}`);
    }
    if (quote.kind === 'ITEM_NOT_FOUND') {
      return refuse('CART_NOT_GROUNDED', `${quote.sku} is not in the live catalogue.`);
    }
    if (quote.kind === 'AUTHORIZATION_NOT_FOUND') {
      return refuse('AUTHORIZATION_NOT_FOUND', 'The derived authorization vanished.');
    }
    const snapshot = quote.snapshot;

    // Hold the budget. Atomic, and the only place the aggregate is committed.
    const reserved = await this.deps.sessions.reserve(session.sessionId, snapshot.total, now);
    if (reserved.kind === 'REFUSED') {
      // No release exists yet, so nothing needs unwinding: an authorization
      // with no release is abandoned by the existing liveness rules.
      return refuse(
        reserved.reason === 'BUDGET_EXCEEDED'
          ? 'SESSION_BUDGET_EXCEEDED'
          : reserved.reason === 'EXPIRED'
            ? 'SESSION_EXPIRED'
            : reserved.reason === 'NOT_ACTIVE'
              ? 'SESSION_REVOKED'
              : 'SESSION_NOT_FOUND',
        describeReserveRefusal(reserved.reason, snapshot.total, session),
      );
    }

    const capsule = this.buildCapsule({ session, request, authorization, snapshot, now });
    const capsuleHash = computeCapsuleHash(capsule);

    // The hold's bookkeeping and the agentic context commit together. A
    // reservation with no capsule to explain it is budget withheld for no
    // recorded reason, which a later reader cannot distinguish from a bug.
    try {
      await this.deps.unitOfWork.withTransaction(async repos => {
        const recorded = await repos.sessions.recordPurchase({
          authorizationId,
          sessionId: session.sessionId,
          purchaseRequestId,
          reservedMinor: snapshot.total.amountMinor,
          settlementState: 'RESERVED',
          capsuleHash,
          createdAt: now,
          settledAt: null,
        });
        // A concurrent identical request won the unique index. Its
        // authorization is the real one; roll this transaction back and hand
        // the caller the winner.
        if (recorded.kind === 'DUPLICATE_REQUEST') {
          throw new ConcurrentPurchaseRequest(recorded.existing.authorizationId);
        }

        // Appended before the gates, so the chain reads in causal order: what
        // the agent was trying to buy and why, and only then what CaptureLock
        // decided about it.
        await repos.evidence.append({
          chainId: authorizationId,
          kind: 'AGENT_CONTEXT',
          recordedAt: now,
          body: { capsuleHash, capsule: capsuleBody(capsule) },
        });
      });
    } catch (error) {
      if (error instanceof ConcurrentPurchaseRequest) {
        const winner = await this.deps.sessions.findPurchaseByRequestId(
          session.sessionId,
          purchaseRequestId,
        );
        if (winner !== null) return this.replayPurchase(session, winner, request);
        return refuse('INVALID_AGENT_ACTION', 'A concurrent identical request is in flight.');
      }
      // The hold was taken by its own statement, before this transaction. If
      // the bookkeeping failed, free it rather than leaving the session short
      // of budget it never spent.
      await this.releaseHoldQuietly(authorizationId, now);
      throw error;
    }

    // Hand over to CaptureLock. From here the answer is entirely the kernel's.
    const outcome = await this.releases.requestOrderCreation({
      authorizationId,
      snapshotId: asSnapshotId(snapshot.snapshotId),
      idempotencyKey: request.idempotencyKey,
      principal: request.principal,
    });

    await this.resolveHoldIfTerminal(authorizationId, outcome, now);

    return {
      kind: 'DECIDED',
      sessionId: session.sessionId,
      authorizationId,
      snapshotId: snapshot.snapshotId,
      capsuleHash,
      outcome,
      replayedPurchase: false,
    };
  }

  /**
   * Runs the capture gate for a purchase.
   *
   * Separate from `requestPurchase` because the payer authorization sits in
   * between: the order gate binds the terms, the payer authorizes at the
   * provider, and only then can the capture gate run. Splitting it here mirrors
   * the release service's own split rather than hiding it.
   */
  async requestCapture(input: {
    readonly sessionId: SessionId;
    readonly authorizationId: AuthorizationId;
    readonly principal: Principal;
    readonly idempotencyKey: IdempotencyKey;
  }): Promise<PurchaseResult> {
    const now = this.deps.clock.now();

    const session = await this.deps.sessions.findById(input.sessionId);
    if (session === null) return refuse('SESSION_NOT_FOUND', `No session ${input.sessionId}`);
    if (session.userId !== input.principal.userId) {
      return refuse('SESSION_NOT_OWNED', 'The authenticated principal does not own this session.');
    }

    const purchase = await this.deps.sessions.findPurchaseByAuthorization(input.authorizationId);
    if (purchase === null || purchase.sessionId !== session.sessionId) {
      return refuse('SESSION_NOT_OWNED', 'That purchase does not belong to this session.');
    }

    const release = await this.deps.releases.findActiveByAuthorization(input.authorizationId);
    if (release === null) {
      return refuse('AUTHORIZATION_NOT_FOUND', 'No active release for that purchase.');
    }

    const outcome = await this.releases.requestCapture({
      releaseId: release.releaseId,
      idempotencyKey: input.idempotencyKey,
      principal: input.principal,
    });

    await this.resolveHoldIfTerminal(input.authorizationId, outcome, now);

    return {
      kind: 'DECIDED',
      sessionId: session.sessionId,
      authorizationId: input.authorizationId,
      snapshotId: release.snapshotId,
      capsuleHash: purchase.capsuleHash,
      outcome,
      replayedPurchase: false,
    };
  }

  /**
   * Resolves stranded budget holds.
   *
   * The crash window between the provider call and the settlement write leaves
   * a hold in place. That is the safe direction — budget withheld, never
   * double-spendable — but it must not be permanent, so this reads the release
   * the hold belongs to and adopts whatever the release now says. It never
   * calls a provider and never decides anything itself.
   */
  async sweepUnsettledPurchases(limit = 50): Promise<
    readonly {
      readonly authorizationId: string;
      readonly resolution: 'SETTLED' | 'RELEASED' | 'STILL_IN_FLIGHT';
    }[]
  > {
    const now = this.deps.clock.now();
    const cutoff = addSeconds(now, -(this.deps.settleAfterSeconds ?? DEFAULT_SETTLE_AFTER_SECONDS));
    const stranded = await this.deps.sessions.findUnsettledPurchases(cutoff, limit);

    const results: {
      authorizationId: string;
      resolution: 'SETTLED' | 'RELEASED' | 'STILL_IN_FLIGHT';
    }[] = [];

    for (const purchase of stranded) {
      const authorizationId = purchase.authorizationId as AuthorizationId;
      const release = await this.deps.releases.findActiveByAuthorization(authorizationId);

      if (release === null) {
        // No active release: either it never got created, or it reached a
        // terminal state. Either way the hold should not persist. A settled
        // release would already have been resolved at the time, so the honest
        // reading of "no active release and still reserved" is that no money
        // moved under this hold.
        const freed = await this.deps.sessions.releasePurchase(authorizationId, now);
        results.push({
          authorizationId: purchase.authorizationId,
          resolution: freed === null ? 'STILL_IN_FLIGHT' : 'RELEASED',
        });
        continue;
      }

      if (moneyHasMoved(release.state)) {
        const settled = await this.deps.sessions.settlePurchase(authorizationId, now);
        results.push({
          authorizationId: purchase.authorizationId,
          resolution: settled === null ? 'STILL_IN_FLIGHT' : 'SETTLED',
        });
        continue;
      }

      if (isTerminalReleaseState(release.state)) {
        const freed = await this.deps.sessions.releasePurchase(authorizationId, now);
        results.push({
          authorizationId: purchase.authorizationId,
          resolution: freed === null ? 'STILL_IN_FLIGHT' : 'RELEASED',
        });
        continue;
      }

      // Genuinely still in flight, or waiting on an operator. Leave the hold
      // alone: reconciliation owns the release, and guessing here would either
      // free budget for a purchase that then captures, or record spend for one
      // that never did.
      results.push({ authorizationId: purchase.authorizationId, resolution: 'STILL_IN_FLIGHT' });
    }

    return results;
  }

  /**
   * Converts or frees a hold once the release can no longer change what it means.
   *
   * `moneyMoved` is a property of the release rather than of this request, which
   * is exactly what is wanted: a duplicate capture of an already-captured
   * release reports true, and the hold settles once because the purchase row's
   * compare-and-set permits only one settlement.
   */
  private async resolveHoldIfTerminal(
    authorizationId: AuthorizationId,
    outcome: ReleaseOutcome,
    now: Timestamp,
  ): Promise<void> {
    if (outcome.moneyMoved) {
      await this.deps.sessions.settlePurchase(authorizationId, now);
      return;
    }
    if (outcome.state !== null && isTerminalReleaseState(outcome.state)) {
      await this.deps.sessions.releasePurchase(authorizationId, now);
    }
    // Otherwise the release is still live — paused, in flight, or awaiting a
    // payer. The hold stays, and the sweep resolves it if nothing else does.
  }

  /**
   * Frees a hold without letting the failure mask the original error.
   *
   * Deliberately swallows its own failure: the caller is already re-throwing
   * something more informative, and a secondary error here would replace the
   * real cause with a bookkeeping detail. The sweep resolves anything this
   * misses.
   */
  private async releaseHoldQuietly(
    authorizationId: AuthorizationId,
    now: Timestamp,
  ): Promise<void> {
    try {
      await this.deps.sessions.releasePurchase(authorizationId, now);
    } catch {
      // Left to sweepUnsettledPurchases.
    }
  }

  /** Answers a repeated request from the purchase it already made. */
  private async replayPurchase(
    session: SessionAuthorityRecord,
    purchase: { readonly authorizationId: string; readonly capsuleHash: Sha256Hex },
    request: PurchaseRequest,
  ): Promise<PurchaseResult> {
    const authorizationId = purchase.authorizationId as AuthorizationId;
    const release = await this.deps.releases.findActiveByAuthorization(authorizationId);

    if (release === null) {
      // The release reached a terminal state; re-running the order gate under
      // the original key returns the stored answer rather than acting again.
      const stored = await this.deps.releases.findByClientIdempotencyKey(request.idempotencyKey);
      if (stored === null) {
        return refuse(
          'INVALID_AGENT_ACTION',
          'That purchase request was already made and its release is gone.',
        );
      }
      return {
        kind: 'DECIDED',
        sessionId: session.sessionId,
        authorizationId,
        snapshotId: stored.snapshotId,
        capsuleHash: purchase.capsuleHash,
        outcome: {
          releaseId: stored.releaseId,
          verdict: moneyHasMoved(stored.state) ? 'ALLOW' : 'DENY',
          reasonCodes: ['IDEMPOTENT_REPLAY'],
          state: stored.state,
          evidenceEnvelopeId: null,
          evidenceChainHead: null,
          providerOrderId: stored.providerOrderId,
          providerPaymentId: stored.providerPaymentId,
          replayed: true,
          moneyMoved: moneyHasMoved(stored.state),
        },
        replayedPurchase: true,
      };
    }

    // A live release: re-drive the order gate with the same key, which the
    // release service answers from its stored decision without touching the
    // provider.
    const outcome = await this.releases.requestOrderCreation({
      authorizationId,
      snapshotId: asSnapshotId(release.snapshotId),
      idempotencyKey: request.idempotencyKey,
      principal: request.principal,
    });

    return {
      kind: 'DECIDED',
      sessionId: session.sessionId,
      authorizationId,
      snapshotId: release.snapshotId,
      capsuleHash: purchase.capsuleHash,
      outcome,
      replayedPurchase: true,
    };
  }

  private buildCapsule(input: {
    readonly session: SessionAuthorityRecord;
    readonly request: PurchaseRequest;
    readonly authorization: {
      readonly authorizationId: string;
      readonly intentHash: string;
      readonly policyHash: string;
    };
    readonly snapshot: VerifiedSnapshot;
    readonly now: Timestamp;
  }): ContextCapsule {
    const { session, request, authorization, snapshot } = input;

    // Priced from the snapshot, never from the agent's view. `asserted` on a
    // snapshot line is the server's own record of what the merchant said.
    const lines: CapsuleLine[] = snapshot.cart.lines.map(line => ({
      sku: line.sku,
      quantity: line.quantity,
      unitPriceMinor: line.unitPrice.amountMinor,
      name: line.asserted.name,
      category: line.asserted.category,
    }));

    return {
      capsuleVersion: CONTEXT_CAPSULE_VERSION,
      sessionId: session.sessionId,
      userId: session.userId,
      intentText: session.purpose,
      boundsHash: session.boundsHash,
      merchantId: snapshot.merchantId,
      catalogVersion: request.catalogVersion,
      lines,
      agentDecision: {
        model: request.agentModel,
        steps: request.agentSteps,
        refusedSteps: request.agentRefusedSteps,
        rationale: request.rationale.slice(0, MAX_SELECTION_RATIONALE),
      },
      authorizationId: authorization.authorizationId,
      intentHash: authorization.intentHash as Sha256Hex,
      snapshotId: snapshot.snapshotId,
      snapshotHash: snapshot.snapshotHash,
      currency: snapshot.currency,
      totalMinor: snapshot.total.amountMinor,
      policyId: session.policyId,
      policyVersion: session.policyVersion,
      // Taken from the mandate rather than recomputed: this is the hash the
      // kernel will compare the loaded policy against, so recording a
      // separately derived one could disagree with the decision it justifies.
      policyHash: asSha256Hex(authorization.policyHash),
      observedAt: input.now,
    };
  }
}

/** Thrown inside the purchase transaction when a concurrent request won. */
class ConcurrentPurchaseRequest extends Error {
  constructor(public readonly winningAuthorizationId: string) {
    super('A concurrent identical purchase request won the unique index');
    this.name = 'ConcurrentPurchaseRequest';
  }
}

function refuse(reasonCode: ReasonCode, detail: string): PurchaseRefused {
  return { kind: 'REFUSED', reasonCode, detail };
}

/**
 * Checks the request against the delegated scope.
 *
 * Merchant and quantity only. Category is deliberately *not* checked here: the
 * agent runtime cannot be trusted to have checked it, and the authoritative
 * category comes from the live merchant read the kernel performs — so it is
 * enforced by the derived intent's `allowedCategories`, inside the pure
 * evaluator, against live state rather than against a browse view.
 */
function checkScope(bounds: SessionBounds, request: PurchaseRequest): PurchaseRefused | null {
  if (
    bounds.merchants.mode === 'ALLOWLIST' &&
    !bounds.merchants.merchantIds.includes(request.merchantId)
  ) {
    return refuse(
      'SESSION_PURCHASE_NOT_PERMITTED',
      `${request.merchantId} is not a merchant this session may buy from.`,
    );
  }
  for (const line of request.lines) {
    if (
      line.quantity < bounds.itemsPerPurchase.min ||
      line.quantity > bounds.itemsPerPurchase.max
    ) {
      return refuse(
        'SESSION_PURCHASE_NOT_PERMITTED',
        `Quantity ${String(line.quantity)} for ${line.sku} is outside the delegated band ${String(
          bounds.itemsPerPurchase.min,
        )}-${String(bounds.itemsPerPurchase.max)}.`,
      );
    }
  }
  return null;
}

/**
 * Derives a per-purchase mandate from the session bounds.
 *
 * Mechanical by design: every field is either copied from the bounds or is the
 * ceiling arithmetic. There is no judgement here, and nothing the agent
 * supplied reaches a constraint — `rawText` is the *user's* purpose, carried for
 * evidence and for the advisory reviewer, and read by no deterministic check.
 */
function deriveIntent(
  session: SessionAuthorityRecord,
  request: PurchaseRequest,
  now: Timestamp,
): AuthorizedIntent {
  const bounds = session.bounds;
  const ceiling: Money = purchaseCeiling(session);

  return {
    rawText: session.purpose,
    constraints: {
      currency: bounds.currency,
      // The line that makes the kernel enforce the aggregate budget.
      maxTotal: ceiling,
      maxUnitPrice: null,
      quantity: bounds.itemsPerPurchase,
      allowedCategories: [...bounds.allowedCategories],
      forbiddenCategories: [...bounds.forbiddenCategories],
      requiredAttributes: [],
      forbiddenAttributes: [],
      merchants: bounds.merchants,
      fees: {
        maxShipping: null,
        maxTax: null,
        maxTip: money(bounds.currency, 0),
        maxConvenienceFee: null,
        // Fees must fit inside the same ceiling as everything else; a session
        // budget that fees could exceed would not be a budget.
        maxTotalFees: ceiling,
      },
      recurrence: bounds.recurrence,
      geography: null,
      maxSnapshotAgeSeconds: 300,
      notBefore: now,
      // The mandate cannot outlive the delegation that produced it.
      notAfter: bounds.expiresAt,
    },
    normalization: {
      // The bounds were authored by a human through the issuer surface; this
      // step is a mechanical projection of them, not an interpretation.
      method: 'TEMPLATE',
      modelId: request.agentModel,
      confirmedByUser: true,
    },
  };
}

function describeReserveRefusal(
  reason: 'BUDGET_EXCEEDED' | 'NOT_ACTIVE' | 'EXPIRED' | 'NOT_FOUND',
  total: Money,
  session: SessionAuthorityRecord,
): string {
  if (reason !== 'BUDGET_EXCEEDED') return `The session is ${reason.toLowerCase()}.`;
  const remaining = remainingBudget(session);
  return `The purchase totals ${String(total.amountMinor)} ${total.currency} (minor units) but only ${String(
    remaining.amountMinor,
  )} remains on this session.`;
}

/** Flattens the capsule for the evidence body. Must stay canonicalizable. */
function capsuleBody(capsule: ContextCapsule): Record<string, unknown> {
  return {
    capsuleVersion: capsule.capsuleVersion,
    sessionId: capsule.sessionId,
    userId: capsule.userId,
    intentText: capsule.intentText,
    boundsHash: capsule.boundsHash,
    merchantId: capsule.merchantId,
    catalogVersion: capsule.catalogVersion,
    lines: capsule.lines.map(line => ({
      sku: line.sku,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      name: line.name,
      category: line.category,
    })),
    agentDecision: {
      model: capsule.agentDecision.model,
      steps: capsule.agentDecision.steps,
      refusedSteps: capsule.agentDecision.refusedSteps,
      rationale: capsule.agentDecision.rationale,
    },
    authorizationId: capsule.authorizationId,
    intentHash: capsule.intentHash,
    snapshotId: capsule.snapshotId,
    snapshotHash: capsule.snapshotHash,
    currency: capsule.currency,
    totalMinor: capsule.totalMinor,
    policyId: capsule.policyId,
    policyVersion: capsule.policyVersion,
    policyHash: capsule.policyHash,
    observedAt: capsule.observedAt,
  };
}
