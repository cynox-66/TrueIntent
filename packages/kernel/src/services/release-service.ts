/**
 * The release service: the only path from a verified decision to money moving.
 *
 * The shape at both gates is the same, and the *transaction boundaries* are the
 * point. Phase 1 got the ordering right but performed each step as its own
 * autocommit, which meant a crash between them could strand a release in a
 * state nothing could recover (see ADR-011). The structure here commits in
 * three deliberate steps:
 *
 *   tx A   move into the verifying state                            commit
 *          resolve context, evaluate                                pure; no I/O
 *   tx B   record evidence + evaluation, CAS into the in-flight
 *          state, persisting the receipt                            commit
 *          ── the provider call happens here; money is at risk ──
 *   tx C   CAS out of the in-flight state, record the outcome       commit
 *
 * Why that split and not one big transaction: a transaction cannot span the
 * provider call, because the call is not transactional. So the durable record
 * that we are *about to* call has to commit first — that is what makes a crash
 * recoverable rather than invisible.
 *
 * Crash points and who cleans up:
 *   after A, or inside B  → verifying state, provider never called
 *                           → liveness sweep aborts, freeing the authorization
 *   after B, before C     → in-flight state → reconciliation sweep asks the
 *                           provider what actually happened
 */

import {
  computeDecisionHash,
  deriveReceipt,
  moneyHasMoved,
  newEvaluationId,
  newReleaseId,
  requiresReconciliation,
  addSeconds,
  type AuthorizationId,
  type Gate,
  type IdempotencyKey,
  type ReasonCode,
  type ReleaseId,
  type ReleaseRecord,
  type ReleaseState,
  type Sha256Hex,
  type SnapshotId,
  type Timestamp,
  type VerificationDecision,
  type Verdict,
} from '@capturelock/core';
import { evaluate } from '../kernel.js';
import { mintGrant, type ExecutionGrant } from '../grant.js';
import { applyAdvisory, type AdvisoryJudgement, type AdvisoryOutcome } from '../advisory.js';
import { serializeContext } from '../serialize.js';
import { requireNextState, sourceStatesFor } from '../release-fsm.js';
import type { Principal } from '../context.js';
import type { PaymentDependencies } from './dependencies.js';
import type { Repositories } from './unit-of-work.js';
import { resolveContext, requestFingerprint, type ResolvedContext } from './resolve.js';

export interface ReleaseRequest {
  readonly authorizationId: AuthorizationId;
  readonly snapshotId: SnapshotId;
  readonly idempotencyKey: IdempotencyKey;
  readonly principal: Principal;
}

/**
 * A capture addresses a release that already exists.
 *
 * It carries neither an authorization nor a snapshot, because both are already
 * bound to the release. Letting a caller restate them would reintroduce exactly
 * the Phase 0 problem: a security-relevant input supplied by the party being
 * checked.
 */
export interface CaptureRequest {
  readonly releaseId: ReleaseId;
  readonly idempotencyKey: IdempotencyKey;
  readonly principal: Principal;
}

export interface ReleaseOutcome {
  readonly releaseId: string | null;
  readonly verdict: Verdict;
  readonly reasonCodes: readonly ReasonCode[];
  readonly state: ReleaseState | null;
  readonly evidenceEnvelopeId: string | null;
  /**
   * Head of the evidence chain after this decision.
   *
   * Returned deliberately: it is an independent witness. An operator who can
   * rewrite the whole database can produce a self-consistent chain, but cannot
   * change a hash a client already holds.
   */
  readonly evidenceChainHead: Sha256Hex | null;
  readonly providerOrderId: string | null;
  readonly providerPaymentId: string | null;
  /** True when a previously stored answer was returned instead of re-deciding. */
  readonly replayed: boolean;
  /** True only when the provider confirmed funds moved. */
  readonly moneyMoved: boolean;
}

interface EnvelopeRef {
  readonly envelopeId: string;
  readonly chainHash: Sha256Hex;
}

interface Evaluated {
  readonly decision: VerificationDecision;
  readonly decisionHash: Sha256Hex;
  readonly grant: ExecutionGrant | null;
  readonly resolved: ResolvedContext;
  readonly advisory: AdvisoryOutcome | null;
}

export class ReleaseService {
  constructor(private readonly deps: PaymentDependencies) {}

  /** Gate 1: bind the terms the payer will be asked to pay. No money moves here. */
  async requestOrderCreation(request: ReleaseRequest): Promise<ReleaseOutcome> {
    const now = this.deps.clock.now();
    const fingerprint = requestFingerprint({
      authorizationId: request.authorizationId,
      snapshotId: request.snapshotId,
      gate: 'ORDER_CREATION',
      principal: request.principal,
    });

    // A repeat of the same request returns the stored answer without touching
    // the provider. A repeat with a *different* payload is not short-circuited:
    // it falls through so the kernel refuses it with the right reason code.
    const stored = await this.deps.releases.findByClientIdempotencyKey(request.idempotencyKey);
    if (stored !== null && stored.requestFingerprint === fingerprint) {
      return this.replay(stored);
    }

    let release = stored;
    if (release === null) {
      const created = await this.createDraftRelease('ORDER_CREATION', request, fingerprint, now);
      if ('outcome' in created) return created.outcome;
      release = created.release;
    }

    const evaluated = await this.evaluateGate('ORDER_CREATION', release, {
      authorizationId: request.authorizationId,
      snapshotId: request.snapshotId,
      idempotencyKey: request.idempotencyKey,
      principal: request.principal,
      now,
    });

    if (evaluated.grant === null) {
      return this.refuse(release, evaluated, now);
    }
    return this.executeOrderCreation(release, evaluated.grant, evaluated);
  }

  /**
   * Gate 2: the capture-time gate. Money moves if and only if this returns ALLOW.
   *
   * The kernel runs again here against a *fresh* live merchant read, which is
   * why an order approved a minute ago can still be refused now. Duplicate
   * capture is prevented by the state machine rather than by the idempotency
   * key: after a capture the release is no longer in a state the capture gate
   * may run from, so a second attempt cannot reach the provider whatever key it
   * presents.
   */
  async requestCapture(request: CaptureRequest): Promise<ReleaseOutcome> {
    const now = this.deps.clock.now();
    const found = await this.deps.releases.findById(request.releaseId);

    if (found === null) {
      return {
        releaseId: null,
        verdict: 'DENY',
        reasonCodes: ['AUTHORIZATION_NOT_FOUND'],
        state: null,
        evidenceEnvelopeId: null,
        evidenceChainHead: null,
        providerOrderId: null,
        providerPaymentId: null,
        replayed: false,
        moneyMoved: false,
      };
    }

    // ---- tx A -------------------------------------------------------------
    // Move into CAPTURE_VERIFYING and commit, before evaluating. Two reasons:
    // a refusal then has a legitimate source state for the VERIFICATION_DENIED
    // edge (in Phase 1 it did not, and silently fell back to a same-state
    // write), and a crash during evaluation leaves a state the liveness sweep
    // recognises as abandonable.
    const verifying = await this.deps.releases.transition(
      found.releaseId,
      sourceStatesFor('CAPTURE_REQUESTED'),
      requireNextState('PAYMENT_AUTHORIZED', 'CAPTURE_REQUESTED'),
      { incrementAttempt: true },
      now,
    );

    // Not in PAYMENT_AUTHORIZED. Evaluate anyway so the refusal is recorded
    // with a precise reason code rather than an opaque rejection.
    const release = verifying ?? found;

    const evaluated = await this.evaluateGate('CAPTURE', release, {
      authorizationId: release.authorizationId,
      snapshotId: release.snapshotId,
      idempotencyKey: request.idempotencyKey,
      principal: request.principal,
      now,
    });

    if (verifying === null) {
      // Another request moved this release first, or it was never in a state
      // the capture gate may run from. Either way this caller did not capture,
      // and must not be told ALLOW.
      return this.refuse(release, evaluated, now, {
        verdict: 'PAUSE',
        reasonCode: 'CONCURRENT_RELEASE_IN_PROGRESS',
      });
    }
    if (evaluated.grant === null) {
      return this.refuse(release, evaluated, now);
    }
    return this.executeCapture(release, evaluated.grant, evaluated);
  }

  // ---------------------------------------------------------------- evaluate

  /**
   * Resolves the context and evaluates it. Performs no writes.
   *
   * Recording is deliberately *not* done here: the evidence append has to land
   * in the same transaction as the state change it justifies, and which state
   * change that is depends on the verdict.
   */
  private async evaluateGate(
    gate: Gate,
    release: ReleaseRecord,
    input: {
      authorizationId: AuthorizationId;
      snapshotId: SnapshotId;
      idempotencyKey: IdempotencyKey;
      principal: Principal;
      now: Timestamp;
    },
  ): Promise<Evaluated> {
    const resolved = await resolveContext(this.deps, {
      gate,
      authorizationId: input.authorizationId,
      snapshotId: input.snapshotId,
      idempotencyKey: input.idempotencyKey,
      principal: input.principal,
      release,
      evaluatedAt: input.now,
    });

    const decision = evaluate(resolved.context);
    const decisionHash = computeDecisionHash(decision);

    // The advisory layer runs OUTSIDE the kernel and may only restrict. The
    // deterministic decision and its hash are what get recorded for replay; the
    // advisory adjustment is recorded beside them, attributed, so an auditor can
    // reproduce the deterministic half exactly and see the judgement for what it
    // is. See ADR-009.
    const advised = await this.applyAdvisory(resolved, decision);
    const effective = advised.decision;

    const grant =
      resolved.snapshot === null
        ? null
        : mintGrant(
            effective,
            decisionHash,
            {
              releaseId: release.releaseId,
              authorizationId: input.authorizationId,
              snapshotId: input.snapshotId,
              snapshotHash: resolved.snapshot.snapshotHash,
              receipt: release.receipt,
              amount: release.amount,
            },
            {
              nonce: `${release.releaseId}:${gate}:${input.now}:${decisionHash.slice(0, 16)}`,
              expiresAt: addSeconds(input.now, this.deps.config.grantTtlSeconds),
            },
          );

    return { decision: effective, decisionHash, grant, resolved, advisory: advised.outcome };
  }

  /**
   * Runs the advisory reviewer, if one is configured.
   *
   * A reviewer that throws is treated exactly as one that is unavailable: no
   * restriction is applied, and the absence is recorded. Safe precisely because
   * the layer can only ever restrict — there is no failure mode in which
   * skipping it approves something.
   */
  private async applyAdvisory(
    resolved: ResolvedContext,
    decision: VerificationDecision,
  ): Promise<{ decision: VerificationDecision; outcome: AdvisoryOutcome | null }> {
    const reviewer = this.deps.advisory;
    if (reviewer === undefined || resolved.authorization === null) {
      return { decision, outcome: null };
    }

    let judgement: AdvisoryJudgement | null = null;
    try {
      judgement = await reviewer.review({
        rawIntent: resolved.authorization.intent.rawText,
        cart: resolved.context.proposal,
        liveItems:
          resolved.context.live.kind === 'OK'
            ? [...resolved.context.live.state.items.values()]
            : [],
      });
    } catch {
      judgement = null;
    }

    return applyAdvisory(decision, reviewer.name, judgement);
  }

  // ----------------------------------------------------------------- refusal

  /**
   * Records the decision and applies the refusal, atomically.
   *
   * A refusal never moves a release forward, and a stale refusal never
   * overwrites a newer state. When the declared transition does not apply the
   * state is left alone and the reason codes are still persisted, so an
   * operator sees why rather than finding an unexplained no-op.
   */
  private async refuse(
    release: ReleaseRecord,
    evaluated: Evaluated,
    now: Timestamp,
    /**
     * Set when the refusal is *not* the kernel's verdict.
     *
     * A caller that lost a race, or arrived at a gate the release is not in a
     * state for, may still have had its context evaluate to ALLOW — the state
     * moved under it between the read and the transition. Reporting that ALLOW
     * would tell the caller the transaction was approved when it was refused,
     * and a client could reasonably conclude money moved. The override makes
     * the reported verdict match what actually happened, while the evaluation
     * is still recorded as it was computed.
     */
    override?: { readonly verdict: Verdict; readonly reasonCode: ReasonCode },
  ): Promise<ReleaseOutcome> {
    const reported = override?.verdict ?? evaluated.decision.verdict;
    const reasonCodes: readonly ReasonCode[] =
      override === undefined
        ? evaluated.decision.reasonCodes
        : [override.reasonCode, ...evaluated.decision.reasonCodes];

    const { envelope, state } = await this.deps.unitOfWork.withTransaction(async repos => {
      const envelope = await this.recordDecision(repos, release, evaluated);

      // A refusal that is only about *timing* must not mark the release DENIED:
      // the transaction itself may be perfectly valid, and a later attempt from
      // a legal state should still be able to proceed.
      if (override !== undefined) {
        const current = await repos.releases.findById(release.releaseId);
        if (current !== null) {
          await repos.releases.transition(
            release.releaseId,
            [current.state],
            current.state,
            { lastReasonCodes: [...reasonCodes] },
            now,
          );
        }
        return { envelope, state: current?.state ?? release.state };
      }

      const trigger =
        evaluated.decision.verdict === 'PAUSE' ? 'VERIFICATION_PAUSED' : 'VERIFICATION_DENIED';
      const to = evaluated.decision.verdict === 'PAUSE' ? 'PAUSED' : 'DENIED';

      const updated = await repos.releases.transition(
        release.releaseId,
        sourceStatesFor(trigger),
        to,
        { lastReasonCodes: [...evaluated.decision.reasonCodes], inFlightSince: null },
        now,
      );

      if (updated === null) {
        const current = await repos.releases.findById(release.releaseId);
        if (current !== null) {
          await repos.releases.transition(
            release.releaseId,
            [current.state],
            current.state,
            { lastReasonCodes: [...evaluated.decision.reasonCodes] },
            now,
          );
        }
        return { envelope, state: current?.state ?? release.state };
      }

      if (evaluated.decision.verdict === 'PAUSE') {
        const existing = await repos.reviews.findOpenByRelease(release.releaseId);
        if (existing === null) {
          await repos.reviews.insert({
            reviewId: `rev_${release.releaseId.slice(4)}` as never,
            releaseId: release.releaseId,
            authorizationId: release.authorizationId,
            // Bound to this exact cart. Re-quoting produces a new hash and needs
            // a new review, so an approval cannot be reused for a cart the
            // reviewer never saw.
            snapshotHash: release.requestFingerprint,
            reasonCodes: [...evaluated.decision.reasonCodes],
            state: 'OPEN',
            createdAt: now,
            resolvedAt: null,
            resolvedBy: null,
          });
        }
      }

      return { envelope, state: updated.state };
    });

    const head = await this.deps.evidence.head(release.authorizationId);
    const current = await this.deps.releases.findById(release.releaseId);
    return {
      releaseId: release.releaseId,
      verdict: reported,
      reasonCodes,
      state,
      evidenceEnvelopeId: envelope.envelopeId,
      evidenceChainHead: head?.chainHash ?? envelope.chainHash,
      providerOrderId: current?.providerOrderId ?? release.providerOrderId,
      providerPaymentId: current?.providerPaymentId ?? release.providerPaymentId,
      replayed: false,
      moneyMoved: moneyHasMoved(state),
    };
  }

  // ----------------------------------------------------------------- execute

  private async executeOrderCreation(
    release: ReleaseRecord,
    grant: ExecutionGrant,
    evaluated: Evaluated,
  ): Promise<ReleaseOutcome> {
    const now = this.deps.clock.now();

    // ---- tx B: everything that must be durable BEFORE the provider call ----
    const prepared = await this.deps.unitOfWork.withTransaction(async repos => {
      const envelope = await this.recordDecision(repos, release, evaluated);

      const claimed = await repos.snapshots.claimForRelease(release.snapshotId, release.releaseId);
      if (claimed === null) {
        await repos.releases.transition(
          release.releaseId,
          ['VERIFYING', 'VERIFIED'],
          'DENIED',
          { lastReasonCodes: ['SNAPSHOT_ALREADY_REDEEMED'] },
          now,
        );
        return { envelope, inFlight: null, blocked: 'SNAPSHOT_ALREADY_REDEEMED' as const };
      }

      const verified = await repos.releases.transition(
        release.releaseId,
        sourceStatesFor('VERIFICATION_ALLOWED'),
        requireNextState('VERIFYING', 'VERIFICATION_ALLOWED'),
        { lastReasonCodes: [...evaluated.decision.reasonCodes] },
        now,
      );
      if (verified === null) return { envelope, inFlight: null, blocked: null };

      // The write-ahead. Once this transaction commits, a crash leaves a durable
      // record that a provider call was about to be made.
      const inFlight = await repos.releases.transition(
        release.releaseId,
        sourceStatesFor('ORDER_CALL_STARTED'),
        requireNextState('VERIFIED', 'ORDER_CALL_STARTED'),
        { inFlightSince: now },
        now,
      );
      return { envelope, inFlight, blocked: null };
    });

    if (prepared.blocked !== null) {
      const state = (await this.deps.releases.findById(release.releaseId))?.state ?? release.state;
      return this.outcome(release, state, evaluated.decision, prepared.envelope, false, [
        prepared.blocked,
      ]);
    }
    if (prepared.inFlight === null) return this.lostRace(release, prepared.envelope);

    // ---- the provider call. The grant is a precondition, not a companion. ---
    const result = await this.deps.paymentExecutor.createOrder(grant, {
      receipt: grant.receipt,
      amount: grant.amount,
      notes: { releaseId: release.releaseId },
    });

    const after = this.deps.clock.now();
    let orderId: string | null = null;
    let target: ReleaseState;
    let codes: readonly string[] = [];

    switch (result.kind) {
      case 'CREATED':
        orderId = result.order.orderId;
        target = 'ORDER_CREATED';
        break;
      case 'DUPLICATE_RECEIPT': {
        // Razorpay refuses a repeat receipt rather than returning the order, so
        // the only way to learn the order id is to look it up.
        const foundOrder = await this.deps.paymentReader.findOrderByReceipt(grant.receipt);
        orderId = foundOrder?.orderId ?? null;
        target = foundOrder === null ? 'FAILED' : 'ORDER_CREATED';
        codes = ['IDEMPOTENT_REPLAY'];
        break;
      }
      case 'REJECTED':
        target = 'FAILED';
        break;
      case 'INDETERMINATE':
        target = 'ORDER_INDETERMINATE';
        break;
    }

    // ---- tx C: record what the provider said ------------------------------
    const state = await this.deps.unitOfWork.withTransaction(async repos => {
      const next = await repos.releases.transition(
        release.releaseId,
        ['ORDER_IN_FLIGHT'],
        target,
        {
          providerOrderId: orderId,
          // An indeterminate outcome keeps `inFlightSince`, so the
          // reconciliation sweep can find it. Clearing it would lose the fact
          // that a call was made.
          inFlightSince: target === 'ORDER_INDETERMINATE' ? undefined : null,
          lastReasonCodes: codes,
        },
        after,
      );
      await this.recordProviderOutcome(
        repos,
        release,
        'ORDER_CREATION',
        result.kind,
        target,
        after,
      );
      return next?.state ?? (await repos.releases.findById(release.releaseId))?.state ?? target;
    });

    return this.outcome(
      { ...release, providerOrderId: orderId },
      state,
      evaluated.decision,
      prepared.envelope,
      false,
    );
  }

  private async executeCapture(
    release: ReleaseRecord,
    grant: ExecutionGrant,
    evaluated: Evaluated,
  ): Promise<ReleaseOutcome> {
    const now = this.deps.clock.now();

    if (release.providerPaymentId === null) {
      return this.refuse(release, evaluated, now, {
        verdict: 'DENY',
        reasonCode: 'INVALID_RELEASE_STATE_FOR_GATE',
      });
    }

    // ---- tx B: durable before money can move ------------------------------
    const prepared = await this.deps.unitOfWork.withTransaction(async repos => {
      const envelope = await this.recordDecision(repos, release, evaluated);

      const approved = await repos.releases.transition(
        release.releaseId,
        sourceStatesFor('CAPTURE_ALLOWED'),
        requireNextState('CAPTURE_VERIFYING', 'CAPTURE_ALLOWED'),
        { lastReasonCodes: [...evaluated.decision.reasonCodes] },
        now,
      );
      if (approved === null) return { envelope, inFlight: null };

      // The single most important commit in the system. Everything after it may
      // already have taken effect.
      const inFlight = await repos.releases.transition(
        release.releaseId,
        sourceStatesFor('CAPTURE_CALL_STARTED'),
        requireNextState('CAPTURE_APPROVED', 'CAPTURE_CALL_STARTED'),
        { inFlightSince: now },
        now,
      );
      return { envelope, inFlight };
    });

    if (prepared.inFlight === null) return this.lostRace(release, prepared.envelope);

    const result = await this.deps.paymentExecutor.capturePayment(grant, {
      paymentId: release.providerPaymentId,
      amount: grant.amount,
    });

    const after = this.deps.clock.now();
    let target: ReleaseState;
    let codes: readonly string[] = [];

    switch (result.kind) {
      case 'CAPTURED':
        target = 'CAPTURED';
        break;
      case 'ALREADY_CAPTURED':
        // Not a failure. The provider is reporting that the money already moved,
        // which must be recorded as a capture rather than retried.
        target = 'CAPTURED';
        codes = ['IDEMPOTENT_REPLAY'];
        break;
      case 'NOT_CAPTURABLE':
      case 'REJECTED':
        target = 'CAPTURE_REJECTED';
        break;
      case 'INDETERMINATE':
        target = 'CAPTURE_INDETERMINATE';
        break;
    }

    // ---- tx C -------------------------------------------------------------
    const state = await this.deps.unitOfWork.withTransaction(async repos => {
      const next = await repos.releases.transition(
        release.releaseId,
        ['CAPTURE_IN_FLIGHT'],
        target,
        {
          inFlightSince: target === 'CAPTURE_INDETERMINATE' ? undefined : null,
          lastReasonCodes: codes,
        },
        after,
      );
      await this.recordProviderOutcome(repos, release, 'CAPTURE', result.kind, target, after);

      if (target === 'CAPTURED') {
        // An authorization funds one purchase. Marking it consumed is what makes
        // a later replay of the same mandate fail at the authority stage.
        await repos.authorizations.transition(release.authorizationId, ['ACTIVE'], 'CONSUMED', {
          consumedByReleaseId: release.releaseId,
        });
      }

      return next?.state ?? (await repos.releases.findById(release.releaseId))?.state ?? target;
    });

    return this.outcome(release, state, evaluated.decision, prepared.envelope, false);
  }

  // ------------------------------------------------------------- persistence

  private async createDraftRelease(
    gate: Gate,
    request: ReleaseRequest,
    fingerprint: Sha256Hex,
    now: Timestamp,
  ): Promise<{ release: ReleaseRecord } | { outcome: ReleaseOutcome }> {
    const authorization = await this.deps.authorizations.findById(request.authorizationId);
    const snapshot = await this.deps.snapshots.findById(request.snapshotId);

    // Three reasons to refuse before a release row exists at all: no
    // authorization, no snapshot, or an authorization that is no longer active.
    //
    // The last is included here rather than being left to the insert, because
    // the insert would fail on the one-active-release index and report
    // AUTHORIZATION_HAS_ACTIVE_RELEASE. A mandate that has already been spent
    // should say so; "busy" does not tell an operator what happened.
    if (authorization === null || snapshot === null || authorization.state !== 'ACTIVE') {
      const evaluated = await this.evaluateGate(
        gate,
        {
          releaseId: newReleaseId(),
          authorizationId: request.authorizationId,
          snapshotId: request.snapshotId,
          state: 'DRAFT',
          clientIdempotencyKey: request.idempotencyKey,
          requestFingerprint: fingerprint,
          receipt: 'cl_placeholder' as ReleaseRecord['receipt'],
          amount: { currency: 'INR', amountMinor: 0 },
          currency: 'INR',
          providerOrderId: null,
          providerPaymentId: null,
          attemptCount: 0,
          inFlightSince: null,
          createdAt: now,
          updatedAt: now,
          lastReasonCodes: [],
        },
        {
          authorizationId: request.authorizationId,
          snapshotId: request.snapshotId,
          idempotencyKey: request.idempotencyKey,
          principal: request.principal,
          now,
        },
      );

      const envelope = await this.deps.unitOfWork.withTransaction(repos =>
        this.recordDecision(repos, null, evaluated),
      );

      return {
        outcome: {
          releaseId: null,
          verdict: evaluated.decision.verdict,
          reasonCodes: evaluated.decision.reasonCodes,
          state: null,
          evidenceEnvelopeId: envelope.envelopeId,
          evidenceChainHead: envelope.chainHash,
          providerOrderId: null,
          providerPaymentId: null,
          replayed: false,
          moneyMoved: false,
        },
      };
    }

    const record: ReleaseRecord = {
      releaseId: newReleaseId(),
      authorizationId: request.authorizationId,
      snapshotId: request.snapshotId,
      state: 'DRAFT',
      clientIdempotencyKey: request.idempotencyKey,
      requestFingerprint: fingerprint,
      // Server-derived, not caller-supplied: the agent cannot mint a fresh
      // receipt to escape provider-side deduplication.
      receipt: deriveReceipt(request.authorizationId, snapshot.snapshotHash),
      amount: snapshot.total,
      currency: snapshot.currency,
      providerOrderId: null,
      providerPaymentId: null,
      attemptCount: 0,
      inFlightSince: null,
      createdAt: now,
      updatedAt: now,
      lastReasonCodes: [],
    };

    const inserted = await this.deps.releases.insert(record);
    if (inserted.kind === 'INSERTED') {
      const verifying = await this.deps.releases.transition(
        record.releaseId,
        sourceStatesFor('RELEASE_REQUESTED'),
        requireNextState('DRAFT', 'RELEASE_REQUESTED'),
        { incrementAttempt: true },
        now,
      );
      return { release: verifying ?? record };
    }

    // The database refused. Both refusals are security-relevant and are reported
    // with their own reason code rather than being retried.
    const code: ReasonCode =
      inserted.kind === 'AUTHORIZATION_BUSY'
        ? 'AUTHORIZATION_HAS_ACTIVE_RELEASE'
        : 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD';

    return {
      outcome: {
        releaseId: inserted.existing.releaseId,
        verdict: 'DENY',
        reasonCodes: [code],
        state: inserted.existing.state,
        evidenceEnvelopeId: null,
        evidenceChainHead:
          (await this.deps.evidence.head(request.authorizationId))?.chainHash ?? null,
        providerOrderId: inserted.existing.providerOrderId,
        providerPaymentId: inserted.existing.providerPaymentId,
        replayed: false,
        moneyMoved: moneyHasMoved(inserted.existing.state),
      },
    };
  }

  /** Appends the decision envelope and the evaluation row. Must run inside a transaction. */
  private async recordDecision(
    repos: Repositories,
    release: ReleaseRecord | null,
    evaluated: Evaluated,
  ): Promise<EnvelopeRef> {
    const context = evaluated.resolved.context;
    const decision = evaluated.decision;

    // One evidence chain per authorization: a natural audit unit, so a reviewer
    // can verify one purchase without reading the whole ledger.
    const chainId = context.authorization?.authorizationId ?? 'chn_orphan';

    const envelope = await repos.evidence.append({
      chainId,
      kind: 'DECISION',
      recordedAt: context.evaluatedAt,
      body: {
        gate: context.gate,
        decisionHash: evaluated.decisionHash,
        verdict: decision.verdict,
        reasonCodes: [...decision.reasonCodes],
        releaseId: release?.releaseId ?? null,
        // The full context: this is what makes the record replayable rather
        // than merely descriptive.
        context: serializeContext(context),
        // Kept separate from the deterministic decision, and clearly labelled,
        // because it is a judgement rather than a computation.
        advisory:
          evaluated.advisory === null
            ? null
            : {
                reviewer: evaluated.advisory.reviewer,
                judgement: evaluated.advisory.judgement,
                deterministicVerdict: evaluated.advisory.deterministicVerdict,
                effectiveVerdict: evaluated.advisory.effectiveVerdict,
                restricted: evaluated.advisory.restricted,
              },
        decision: {
          verdict: decision.verdict,
          gate: decision.gate,
          evaluatedAt: decision.evaluatedAt,
          reasonCodes: [...decision.reasonCodes],
          findings: decision.findings.map(f => ({
            code: f.code,
            severity: f.severity,
            stage: f.stage,
            message: f.message,
            detail: Object.keys(f.detail)
              .sort()
              .map(key => ({ key, value: f.detail[key] ?? null })),
          })),
          stages: decision.stages.map(s => ({
            stage: s.stage,
            status: s.status,
            findingCount: s.findingCount,
          })),
        },
      },
    });

    if (context.authorization !== null && release !== null) {
      await repos.evaluations.append({
        evaluationId: newEvaluationId(),
        authorizationId: context.authorization.authorizationId as AuthorizationId,
        releaseId: release.releaseId,
        gate: context.gate,
        decision,
        contextHash: envelope.chainHash,
        decisionHash: evaluated.decisionHash,
        evaluatedAt: context.evaluatedAt,
      });
    }

    return { envelopeId: envelope.envelopeId, chainHash: envelope.chainHash };
  }

  private async recordProviderOutcome(
    repos: Repositories,
    release: ReleaseRecord,
    gate: Gate,
    outcomeKind: string,
    state: ReleaseState,
    at: Timestamp,
  ): Promise<void> {
    await repos.evidence.append({
      chainId: release.authorizationId,
      kind: 'PROVIDER_OUTCOME',
      recordedAt: at,
      body: {
        gate,
        releaseId: release.releaseId,
        provider: this.deps.paymentExecutor.name,
        outcome: outcomeKind,
        resultingState: state,
        receipt: release.receipt,
        amountMinor: release.amount.amountMinor,
        currency: release.currency,
        requiresReconciliation: requiresReconciliation(state),
      },
    });
  }

  // ----------------------------------------------------------------- results

  private async replay(stored: ReleaseRecord): Promise<ReleaseOutcome> {
    return {
      releaseId: stored.releaseId,
      verdict: stored.state === 'DENIED' ? 'DENY' : stored.state === 'PAUSED' ? 'PAUSE' : 'ALLOW',
      reasonCodes: ['IDEMPOTENT_REPLAY', ...(stored.lastReasonCodes as ReasonCode[])],
      state: stored.state,
      evidenceEnvelopeId: null,
      evidenceChainHead: (await this.deps.evidence.head(stored.authorizationId))?.chainHash ?? null,
      providerOrderId: stored.providerOrderId,
      providerPaymentId: stored.providerPaymentId,
      replayed: true,
      moneyMoved: moneyHasMoved(stored.state),
    };
  }

  private async lostRace(release: ReleaseRecord, envelope: EnvelopeRef): Promise<ReleaseOutcome> {
    // Another request moved this release first. Report what is now true; never
    // force our own transition through.
    const current = await this.deps.releases.findById(release.releaseId);
    return {
      releaseId: release.releaseId,
      verdict: 'PAUSE',
      reasonCodes: ['CONCURRENT_RELEASE_IN_PROGRESS'],
      state: current?.state ?? release.state,
      evidenceEnvelopeId: envelope.envelopeId,
      evidenceChainHead: envelope.chainHash,
      providerOrderId: current?.providerOrderId ?? null,
      providerPaymentId: current?.providerPaymentId ?? null,
      replayed: false,
      moneyMoved: moneyHasMoved(current?.state ?? release.state),
    };
  }

  /**
   * Builds the caller-facing result.
   *
   * `evidenceChainHead` is read at the end of the operation rather than taken
   * from the decision envelope. The client is meant to keep it as an independent
   * witness, so it has to cover *everything* this call appended — including the
   * provider outcome. A witness covering only the decision would leave a later
   * truncation of the provider record undetectable.
   */
  private async outcome(
    release: ReleaseRecord,
    state: ReleaseState,
    decision: VerificationDecision,
    envelope: EnvelopeRef,
    replayed: boolean,
    extraCodes: readonly string[] = [],
  ): Promise<ReleaseOutcome> {
    const head = await this.deps.evidence.head(release.authorizationId);
    const current = await this.deps.releases.findById(release.releaseId);
    return {
      releaseId: release.releaseId,
      verdict: decision.verdict,
      reasonCodes: [...decision.reasonCodes, ...(extraCodes as readonly ReasonCode[])],
      state,
      evidenceEnvelopeId: envelope.envelopeId,
      evidenceChainHead: head?.chainHash ?? envelope.chainHash,
      providerOrderId: current?.providerOrderId ?? release.providerOrderId,
      providerPaymentId: current?.providerPaymentId ?? release.providerPaymentId,
      replayed,
      moneyMoved: moneyHasMoved(state),
    };
  }
}
