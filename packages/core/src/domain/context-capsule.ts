/**
 * The context capsule: why a payment was attempted.
 *
 * TrueIntent's evidence already answers "what did the system decide, and from
 * what inputs?" exactly — the kernel is pure, so a decision replays. What it
 * cannot answer is the question a human actually asks after an agent spends
 * their money: *why did it think I wanted this?* The capsule is the missing
 * link, binding the user's words and the agent's selection to the
 * authorization, snapshot and policy the kernel then evaluated.
 *
 * It is an evidence object, not a transcript. Three things it deliberately
 * excludes:
 *
 *  - **The conversation.** A full model transcript in an append-only ledger is
 *    a privacy liability that grows without bound and proves nothing a hash
 *    cannot. What is kept is the agent's own one-line justification and a count
 *    of the steps it took.
 *  - **Anything secret.** No credential, no key, no provider identifier. An
 *    envelope is served over an unauthenticated read endpoint.
 *  - **Anything the agent asserted as fact.** Every price and total here is the
 *    server's, taken from the priced snapshot. The capsule records what the
 *    agent *chose*, never what it claimed things cost.
 *
 * It is canonicalizable and hashable, so the capsule recorded in evidence can
 * be shown to be the capsule the purchase ran under: lines are sorted, money is
 * flattened to integer minor units, and every optional field is an explicit
 * null so an absent value cannot hash the same as an unset one.
 */

import { hash, type Sha256Hex } from '../canonical.js';
import type { CurrencyCode, Money } from '../money.js';
import type { Timestamp } from '../time.js';
import type { MerchantId, SessionId, Sku, UserId } from '../ids.js';

/** Schema version, so a capsule read years later can be interpreted. */
export const CONTEXT_CAPSULE_VERSION = 1;

/** Ceiling on the agent's justification. Free text, so it is bounded. */
export const MAX_SELECTION_RATIONALE = 500;

/**
 * One line of the purchase, as the server priced it.
 *
 * `unitPriceMinor` comes from the snapshot, which came from a live merchant
 * read. It is here so a reader can see what was about to be charged, not so
 * anything can be recomputed from the agent's view of the world.
 */
export interface CapsuleLine {
  readonly sku: Sku;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  /** Merchant-stated, at snapshot time. */
  readonly name: string;
  readonly category: string;
}

/**
 * What the agent did, compressed to what a dispute needs.
 *
 * `steps` and `refusedSteps` together say whether the agent had an easy time or
 * fought its way to this cart — a run with nine refusals before a purchase is
 * worth a second look even when the purchase itself is clean.
 */
export interface CapsuleAgentDecision {
  /** Model identity, for attribution. Never a credential. */
  readonly model: string;
  readonly steps: number;
  readonly refusedSteps: number;
  /** The agent's own words for why this cart. Judgement, clearly labelled. */
  readonly rationale: string;
}

export interface ContextCapsule {
  readonly capsuleVersion: number;

  // ---- what the user delegated -------------------------------------------
  readonly sessionId: SessionId;
  readonly userId: UserId;
  /** The user's own words. Evidence only; no deterministic check reads it. */
  readonly intentText: string;
  /** Binds to the bounds in force, without copying them. */
  readonly boundsHash: Sha256Hex;

  // ---- what the agent selected -------------------------------------------
  readonly merchantId: MerchantId;
  /** Which version of the catalogue the agent was looking at when it chose. */
  readonly catalogVersion: string;
  readonly lines: readonly CapsuleLine[];
  readonly agentDecision: CapsuleAgentDecision;

  // ---- what the server resolved ------------------------------------------
  readonly authorizationId: string;
  readonly intentHash: Sha256Hex;
  readonly snapshotId: string;
  readonly snapshotHash: Sha256Hex;
  readonly currency: CurrencyCode;
  /** The authoritative total, from the priced snapshot. */
  readonly totalMinor: number;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyHash: Sha256Hex;

  readonly observedAt: Timestamp;
}

/**
 * Projects the capsule into the exact shape that gets hashed.
 *
 * Lines are sorted by SKU: an agent adding the same items in a different order
 * built the same cart, and a hash that disagreed would report tampering where
 * there was none.
 */
export function capsuleHashInput(capsule: ContextCapsule): Record<string, unknown> {
  return {
    capsuleVersion: capsule.capsuleVersion,
    sessionId: capsule.sessionId,
    userId: capsule.userId,
    intentText: capsule.intentText,
    boundsHash: capsule.boundsHash,
    merchantId: capsule.merchantId,
    catalogVersion: capsule.catalogVersion,
    lines: [...capsule.lines]
      .map(line => ({
        sku: line.sku,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        name: line.name,
        category: line.category,
      }))
      .sort((a, b) => a.sku.localeCompare(b.sku, 'en')),
    agentModel: capsule.agentDecision.model,
    agentSteps: capsule.agentDecision.steps,
    agentRefusedSteps: capsule.agentDecision.refusedSteps,
    agentRationale: capsule.agentDecision.rationale,
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

export function computeCapsuleHash(capsule: ContextCapsule): Sha256Hex {
  return hash('capturelock.v1.context_capsule', capsuleHashInput(capsule));
}

/**
 * Recomputes the hash and reports whether the stored value still holds.
 *
 * The capsule lives in an append-only, hash-chained ledger, so this is a
 * second-line check rather than the primary one — but a capsule read back out
 * of the database and compared here catches a `jsonb` round-trip that dropped
 * a field, which chain verification would report only as a broken payload.
 */
export function verifyCapsuleIntegrity(
  capsule: ContextCapsule,
  expected: Sha256Hex,
): { readonly valid: boolean; readonly recomputed: Sha256Hex } {
  const recomputed = computeCapsuleHash(capsule);
  return { valid: recomputed === expected, recomputed };
}

export type { Money, Sha256Hex };
