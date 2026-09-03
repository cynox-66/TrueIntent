/**
 * Context resolution: every read the kernel's decision depends on, done once.
 *
 * This is the boundary between the world and the pure function. Everything
 * asynchronous happens here; everything after it is arithmetic over a frozen
 * value. Getting that split right is what makes a decision reproducible and
 * what stops a stage from observing the world mid-flight.
 *
 * Note what is *not* taken from the caller: the intent, the policy, the prices,
 * the timestamp. All are loaded or computed server-side. The caller supplies
 * only identifiers and its own idempotency key. That is the correction to the
 * Phase 0 contract, expressed in code rather than in a comment.
 */

import {
  hash,
  type AuthorizationId,
  type AuthorizationRecord,
  type Gate,
  type IdempotencyKey,
  type LiveStateResult,
  type ProposedCart,
  type ReleaseRecord,
  type Sha256Hex,
  type SnapshotId,
  type Timestamp,
  type VerifiedSnapshot,
} from '@capturelock/core';
import { newRequestId } from '@capturelock/core';
import type { PolicyDocument } from '@capturelock/policy';
import { deepFreeze, type Principal, type VerificationContext } from '../context.js';
import type { CoreDependencies } from './dependencies.js';

export interface ResolveInput {
  readonly gate: Gate;
  readonly authorizationId: AuthorizationId;
  readonly snapshotId: SnapshotId;
  readonly idempotencyKey: IdempotencyKey;
  readonly principal: Principal;
  readonly release: ReleaseRecord | null;
  readonly evaluatedAt: Timestamp;
}

/**
 * Digest of the fields that make two requests materially the same.
 *
 * Reusing an idempotency key with a different fingerprint means the caller is
 * trying to get a different transaction charged under an answer we already
 * gave. The gate is included so the order and capture requests for one release
 * are correctly treated as different requests.
 */
export function requestFingerprint(input: {
  authorizationId: string;
  snapshotId: string;
  gate: Gate;
  principal: Principal;
}): Sha256Hex {
  return hash('capturelock.v1.request_fingerprint', {
    authorizationId: input.authorizationId,
    snapshotId: input.snapshotId,
    gate: input.gate,
    userId: input.principal.userId,
    sessionId: input.principal.sessionId,
  });
}

export interface ResolvedContext {
  readonly context: VerificationContext;
  readonly authorization: AuthorizationRecord | null;
  readonly snapshot: VerifiedSnapshot | null;
  readonly policy: PolicyDocument | null;
}

export async function resolveContext(
  deps: CoreDependencies,
  input: ResolveInput,
): Promise<ResolvedContext> {
  const authorization = await deps.authorizations.findById(input.authorizationId);
  const snapshot = await deps.snapshots.findById(input.snapshotId);

  // The policy is located by the id and version bound to the authorization, not
  // by anything the caller said. The policy stage separately checks that what
  // came back still hashes to the value recorded at issuance.
  const policy =
    authorization === null
      ? null
      : await deps.policies.findByIdAndVersion(authorization.policyId, authorization.policyVersion);

  const proposal: ProposedCart = snapshot?.cart ?? emptyCart();

  // The live read is the freshest fact in the context and the reason the same
  // authorization can be approved at order time and refused at capture time.
  const live: LiveStateResult =
    snapshot === null
      ? { kind: 'UNAVAILABLE', reason: 'no snapshot to read live state for' }
      : await deps.merchant.read({
          merchantId: snapshot.merchantId,
          lines: snapshot.cart.lines.map(line => ({ sku: line.sku, quantity: line.quantity })),
          shipTo: snapshot.cart.shipTo,
        });

  const releaseForIdempotencyKey = await deps.releases.findByClientIdempotencyKey(
    input.idempotencyKey,
  );
  const otherActiveRelease = await deps.releases.findActiveByAuthorization(input.authorizationId);

  const fingerprint = requestFingerprint({
    authorizationId: input.authorizationId,
    snapshotId: input.snapshotId,
    gate: input.gate,
    principal: input.principal,
  });

  const context = deepFreeze<VerificationContext>({
    gate: input.gate,
    requestId: newRequestId(),
    evaluatedAt: input.evaluatedAt,
    principal: input.principal,
    authorization,
    policy,
    snapshot,
    proposal,
    live,
    execution: {
      release: input.release,
      releaseForIdempotencyKey,
      otherActiveRelease:
        otherActiveRelease !== null && otherActiveRelease.releaseId === input.release?.releaseId
          ? null
          : otherActiveRelease,
      requestFingerprint: fingerprint,
      attemptsInWindow: (input.release?.attemptCount ?? 0) + 1,
      velocityWindowSeconds: deps.config.velocityWindowSeconds,
      maxAttemptsInWindow: deps.config.maxAttemptsInWindow,
    },
  });

  return { context, authorization, snapshot, policy };
}

/**
 * Placeholder cart used when no snapshot exists.
 *
 * The structural stage will report it as empty and the snapshot stage will
 * report the snapshot missing, so this can never be mistaken for a real cart.
 * It exists so the context type stays non-nullable in the common case.
 */
function emptyCart(): ProposedCart {
  return {
    merchantId: 'unknown' as ProposedCart['merchantId'],
    currency: 'INR',
    lines: [],
    adjustments: [],
    declaredTotal: { currency: 'INR', amountMinor: 0 },
    recurring: false,
    shipTo: null,
  };
}
