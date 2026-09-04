/**
 * The verification context: everything the kernel is allowed to know.
 *
 * The central design rule of this package is that **all I/O happens before the
 * pipeline runs**. `resolveContext` (in the services layer) performs every
 * database read and every live merchant read, assembles the results into this
 * value, deep-freezes it, and hands it to a pure function.
 *
 * Three things follow, and each is a property we could not otherwise claim:
 *
 * 1. **Replay is exact.** The evidence envelope stores this whole context. An
 *    auditor re-runs `evaluate(context)` offline and compares decision hashes.
 *    That only works because the function has no other inputs.
 * 2. **No TOCTOU inside the pipeline.** No stage can observe a world that
 *    changed while an earlier stage was running; they all see one instant.
 * 3. **The clock is data.** `evaluatedAt` is a field, not a call. Nothing in
 *    here can read a moving clock, so freshness checks are reproducible.
 *
 * Fields that could not be loaded are explicitly `null` rather than absent, so
 * a stage must decide what to do about a missing authorization instead of
 * dereferencing undefined and throwing somewhere unhelpful.
 */

import type {
  AuthorizationRecord,
  Gate,
  LiveStateResult,
  ProposedCart,
  ReleaseRecord,
  RequestId,
  Sha256Hex,
  Timestamp,
  UserId,
  VerifiedSnapshot,
} from '@capturelock/core';
import type { PolicyDocument } from '@capturelock/policy';

/** Who is asking. Established by the API layer's authentication, never by the request body. */
export interface Principal {
  readonly userId: UserId;
  readonly sessionId: string;
}

/** What an operator approved, and for which request. */
export interface ApprovedReview {
  readonly reviewId: string;
  /**
   * The request the approval was given for.
   *
   * This is the release's request fingerprint — a hash over the authorization,
   * the snapshot and the gate. Binding to it means an approval applies to this
   * exact cart at this exact gate: a re-quote produces a new snapshot and a new
   * fingerprint, and an approval given at the order gate does not silently
   * carry over to the capture gate, where the reviewer saw nothing.
   *
   * (`ReviewRecord` stores this value in a field named `snapshotHash`. The name
   * predates the fingerprint; the value has always been the fingerprint.)
   */
  readonly boundTo: Sha256Hex;
  /** Exactly the reason codes the reviewer was shown. */
  readonly reasonCodes: readonly string[];
  readonly resolvedBy: string;
  readonly resolvedAt: Timestamp;
}

export interface ExecutionContext {
  /** The release this gate is running for, if one exists yet. */
  readonly release: ReleaseRecord | null;
  /** A release already stored against the presented client idempotency key. */
  readonly releaseForIdempotencyKey: ReleaseRecord | null;
  /** Any other non-terminal release on this authorization. */
  readonly otherActiveRelease: ReleaseRecord | null;
  /** Digest of the materially significant request fields, for idempotency-key reuse detection. */
  /**
   * An operator approval for this release, if one has been recorded.
   *
   * Present so the kernel can *consume* a decision a human already made.
   * Without it an approval changes nothing: re-verification reproduces the same
   * PAUSE, the release pauses again, and the review loop never terminates —
   * which is what the code did before this field existed.
   *
   * It is bound to a snapshot hash and to the exact reason codes the reviewer
   * saw, so it authorizes *this cart* against *those findings* and nothing
   * else. See `applyApproval` in combine.ts for how narrowly it is applied.
   */
  readonly approvedReview: ApprovedReview | null;
  readonly requestFingerprint: Sha256Hex;
  readonly attemptsInWindow: number;
  readonly velocityWindowSeconds: number;
  readonly maxAttemptsInWindow: number;
}

export interface VerificationContext {
  readonly gate: Gate;
  readonly requestId: RequestId;
  /** Captured once at the edge. The single source of "now" for every stage. */
  readonly evaluatedAt: Timestamp;
  readonly principal: Principal;
  readonly authorization: AuthorizationRecord | null;
  readonly policy: PolicyDocument | null;
  readonly snapshot: VerifiedSnapshot | null;
  /** The cart actually being charged: server-priced, taken from the snapshot. */
  readonly proposal: ProposedCart;
  readonly live: LiveStateResult;
  readonly execution: ExecutionContext;
}

/**
 * Recursively freezes a value.
 *
 * Freezing is not decoration. Without it a stage could mutate the cart it just
 * validated and hand a different one to the next stage — a time-of-check to
 * time-of-use bug entirely inside our own process. With it, such an attempt
 * throws in strict mode (all ES modules are strict), and the attempt is caught
 * by the pipeline runner as a stage error, which fails closed.
 *
 * Maps and Sets are frozen as objects and their contents frozen in place; the
 * context only ever holds read-only views of them.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;

  Object.freeze(value);

  if (value instanceof Map) {
    for (const entry of value.values()) deepFreeze(entry);
    return value;
  }
  if (value instanceof Set) {
    for (const entry of value.values()) deepFreeze(entry);
    return value;
  }

  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // Skip accessors: reading them could run arbitrary code, and the context is
    // built from plain data anyway.
    if (descriptor && 'value' in descriptor) {
      deepFreeze(descriptor.value as unknown);
    }
  }
  return value;
}
