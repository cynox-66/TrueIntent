/**
 * The execution grant: proof that the kernel approved a specific transaction.
 *
 * This type is how "nothing may bypass verification" becomes a compile-time
 * property rather than a code-review convention.
 *
 * The brand is a module-private `unique symbol`. It is not exported, so no
 * other module — no route handler, no adapter, no test — can construct a value
 * of this type. `mintGrant` is the only producer, and it returns `null` for any
 * verdict other than ALLOW. Since `PaymentExecutor` requires a grant to move
 * money, a caller who has not been through the kernel cannot even express the
 * call.
 *
 * The grant also pins *what* was approved: release, snapshot hash, amount and
 * receipt. Verifying one cart and then charging another would require mutating
 * a frozen object.
 */

import type {
  AuthorizationId,
  Money,
  Receipt,
  ReleaseId,
  Sha256Hex,
  SnapshotId,
  Timestamp,
  VerificationDecision,
} from '@capturelock/core';

declare const EXECUTION_GRANT: unique symbol;

export interface ExecutionGrant {
  /** Phantom brand. Not exported, so this type cannot be forged elsewhere. */
  readonly [EXECUTION_GRANT]: true;
  readonly releaseId: ReleaseId;
  readonly authorizationId: AuthorizationId;
  readonly snapshotId: SnapshotId;
  readonly snapshotHash: Sha256Hex;
  readonly receipt: Receipt;
  readonly amount: Money;
  readonly decisionHash: Sha256Hex;
  readonly grantedAt: Timestamp;
  /**
   * Unique per mint, so the executor can refuse a second use.
   *
   * Grants never leave the process, so an in-process consumed-nonce set is
   * sufficient and is what `GuardedPaymentExecutor` keeps. This is replay
   * protection within one process; it is not, and is not presented as, a
   * distributed guarantee. See ADR-012.
   */
  readonly nonce: string;
  /**
   * Short expiry. A grant is consumed milliseconds after minting, in the same
   * call, so a generous window would only widen the replay surface.
   */
  readonly expiresAt: Timestamp;
}

export interface GrantSubject {
  readonly releaseId: ReleaseId;
  readonly authorizationId: AuthorizationId;
  readonly snapshotId: SnapshotId;
  readonly snapshotHash: Sha256Hex;
  readonly receipt: Receipt;
  readonly amount: Money;
}

/**
 * Mints a grant, but only for an ALLOW.
 *
 * Returning `null` rather than throwing is deliberate: the caller must write an
 * explicit branch for the refusal case, and TypeScript will not let them reach
 * the provider call without narrowing the null away.
 */
export function mintGrant(
  decision: VerificationDecision,
  decisionHash: Sha256Hex,
  subject: GrantSubject,
  options: { readonly nonce: string; readonly expiresAt: Timestamp },
): ExecutionGrant | null {
  if (decision.verdict !== 'ALLOW') return null;
  return Object.freeze({
    releaseId: subject.releaseId,
    authorizationId: subject.authorizationId,
    snapshotId: subject.snapshotId,
    snapshotHash: subject.snapshotHash,
    receipt: subject.receipt,
    amount: subject.amount,
    decisionHash,
    grantedAt: decision.evaluatedAt,
    nonce: options.nonce,
    expiresAt: options.expiresAt,
  }) as ExecutionGrant;
}
