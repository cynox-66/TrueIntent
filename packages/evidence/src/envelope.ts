/**
 * Evidence envelopes and the hash chain that links them.
 *
 * An envelope answers one question after the fact: *what did CaptureLock know
 * when it made this decision?* It therefore carries the full decision input,
 * not a summary — a summary cannot be re-evaluated, and a record you cannot
 * re-evaluate is a claim rather than a proof.
 *
 * Tamper evidence comes from two independent mechanisms:
 *
 *  - a SHA-256 chain, which detects modification, deletion, and reordering
 *    provided you know the head;
 *  - an Ed25519 signature over each chain hash, which means recomputing the
 *    chain is not enough to forge it.
 */

import { hash, type Sha256Hex, type Timestamp } from '@capturelock/core';
import type { EvidenceSigner, EvidenceVerifier } from './signing.js';

/** Prev-hash of the first envelope in a chain. */
export const GENESIS_CHAIN_HASH = '0'.repeat(64) as Sha256Hex;

export const ENVELOPE_KINDS = [
  'DECISION',
  'PROVIDER_OUTCOME',
  'RELEASE_TRANSITION',
  'WEBHOOK',
  'REVIEW_RESOLUTION',
  /**
   * What a buyer agent was trying to buy, and under what delegated authority.
   *
   * Appended before the order gate, so a chain reads in causal order: the
   * intent and the cart first, then what CaptureLock decided about them. It
   * carries no serialized verification context, so the replay endpoint reports
   * `reproduced: false` for it rather than attempting a re-evaluation of
   * something that was never a decision.
   *
   * This string is enumerated in exactly two places — here and the CHECK
   * constraint on `evidence_envelopes.kind` (migration 0003). They must agree.
   */
  'AGENT_CONTEXT',
] as const;

export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number];

export interface EvidenceEnvelope {
  readonly envelopeId: string;
  readonly chainId: string;
  /** Monotonic from 0 within a chain. Gaps mean an entry was removed. */
  readonly sequence: number;
  readonly prevChainHash: Sha256Hex;
  readonly chainHash: Sha256Hex;
  /** Base64 Ed25519 signature over the chain hash bytes. */
  readonly signature: string;
  readonly publicKeyId: string;
  readonly recordedAt: Timestamp;
  readonly kind: EnvelopeKind;
  /** Canonicalizable payload. Its exact shape is the caller's concern. */
  readonly body: unknown;
}

export type UnsealedEnvelope = Omit<EvidenceEnvelope, 'chainHash' | 'signature' | 'publicKeyId'>;

/**
 * Computes the chain hash over everything the envelope commits to.
 *
 * Note that `prevChainHash` and `sequence` are inside the hashed preimage. That
 * is what binds an entry to its position: moving an envelope, or dropping the
 * one before it, changes this value.
 */
export function computeChainHash(envelope: UnsealedEnvelope): Sha256Hex {
  return hash('capturelock.v1.envelope', {
    envelopeId: envelope.envelopeId,
    chainId: envelope.chainId,
    sequence: envelope.sequence,
    prevChainHash: envelope.prevChainHash,
    recordedAt: envelope.recordedAt,
    kind: envelope.kind,
    body: envelope.body,
  });
}

/** Seals an envelope: computes its chain hash and signs it. */
export function sealEnvelope(envelope: UnsealedEnvelope, signer: EvidenceSigner): EvidenceEnvelope {
  const chainHash = computeChainHash(envelope);
  return Object.freeze({
    ...envelope,
    chainHash,
    signature: signer.sign(Buffer.from(chainHash, 'utf8')),
    publicKeyId: signer.publicKeyId,
  });
}

export type ChainDefectKind =
  /** The body no longer hashes to the stored chain hash: the payload was edited. */
  | 'PAYLOAD_MODIFIED'
  /** The chain hash is internally consistent but not signed by the expected key. */
  | 'SIGNATURE_INVALID'
  /** A sequence number is missing: an entry was deleted. */
  | 'SEQUENCE_GAP'
  /** An entry's prev-hash does not match its predecessor: reordered or spliced. */
  | 'CHAIN_BROKEN'
  /** The first entry does not start from the genesis hash. */
  | 'BAD_GENESIS'
  /** Two entries claim the same sequence number. */
  | 'DUPLICATE_SEQUENCE'
  /** The chain does not end at the head the verifier was told to expect. */
  | 'HEAD_MISMATCH'
  /** Entries from more than one chain were mixed together. */
  | 'CHAIN_ID_MISMATCH';

export interface ChainDefect {
  readonly kind: ChainDefectKind;
  readonly sequence: number;
  readonly envelopeId: string | null;
  readonly detail: string;
}

export interface ChainVerification {
  readonly valid: boolean;
  readonly defects: readonly ChainDefect[];
  readonly verifiedCount: number;
  readonly headChainHash: Sha256Hex | null;
}

/**
 * Verifies a contiguous run of envelopes.
 *
 * `expectedHead` is optional but important: without an independently held head,
 * an adversary who can rewrite every row can also produce a chain that verifies
 * perfectly. Handing the head back to the client on each release gives them a
 * witness that makes wholesale rewriting detectable.
 */
export function verifyChain(
  envelopes: readonly EvidenceEnvelope[],
  verifier: EvidenceVerifier,
  expectedHead?: Sha256Hex,
): ChainVerification {
  const defects: ChainDefect[] = [];

  if (envelopes.length === 0) {
    return { valid: expectedHead === undefined, defects, verifiedCount: 0, headChainHash: null };
  }

  const ordered = [...envelopes].sort((a, b) => a.sequence - b.sequence);
  const chainId = ordered[0]?.chainId;

  const seenSequences = new Set<number>();
  let previous: EvidenceEnvelope | null = null;

  for (const envelope of ordered) {
    if (envelope.chainId !== chainId) {
      defects.push({
        kind: 'CHAIN_ID_MISMATCH',
        sequence: envelope.sequence,
        envelopeId: envelope.envelopeId,
        detail: `Envelope belongs to chain ${envelope.chainId}, expected ${String(chainId)}`,
      });
    }

    if (seenSequences.has(envelope.sequence)) {
      defects.push({
        kind: 'DUPLICATE_SEQUENCE',
        sequence: envelope.sequence,
        envelopeId: envelope.envelopeId,
        detail: `Sequence ${envelope.sequence} appears more than once`,
      });
    }
    seenSequences.add(envelope.sequence);

    // Recompute the hash from the stored body. This is the check that catches
    // an edited payload, and it must come before the signature check so that a
    // modified body is reported as modified rather than as a bad signature.
    const recomputed = computeChainHash(envelope);
    if (recomputed !== envelope.chainHash) {
      defects.push({
        kind: 'PAYLOAD_MODIFIED',
        sequence: envelope.sequence,
        envelopeId: envelope.envelopeId,
        detail: `Stored hash ${envelope.chainHash} but body hashes to ${recomputed}`,
      });
    } else if (!verifier.verify(Buffer.from(envelope.chainHash, 'utf8'), envelope.signature)) {
      defects.push({
        kind: 'SIGNATURE_INVALID',
        sequence: envelope.sequence,
        envelopeId: envelope.envelopeId,
        detail: 'Signature does not verify under the expected public key',
      });
    }

    if (previous === null) {
      if (envelope.sequence !== 0) {
        defects.push({
          kind: 'SEQUENCE_GAP',
          sequence: envelope.sequence,
          envelopeId: envelope.envelopeId,
          detail: `Chain starts at sequence ${envelope.sequence}, expected 0`,
        });
      }
      if (envelope.prevChainHash !== GENESIS_CHAIN_HASH) {
        defects.push({
          kind: 'BAD_GENESIS',
          sequence: envelope.sequence,
          envelopeId: envelope.envelopeId,
          detail: 'First envelope does not reference the genesis hash',
        });
      }
    } else {
      if (envelope.sequence !== previous.sequence + 1) {
        defects.push({
          kind: 'SEQUENCE_GAP',
          sequence: envelope.sequence,
          envelopeId: envelope.envelopeId,
          detail: `Sequence jumps from ${previous.sequence} to ${envelope.sequence}; an entry is missing`,
        });
      }
      if (envelope.prevChainHash !== previous.chainHash) {
        defects.push({
          kind: 'CHAIN_BROKEN',
          sequence: envelope.sequence,
          envelopeId: envelope.envelopeId,
          detail: `prevChainHash does not match the hash of sequence ${previous.sequence}`,
        });
      }
    }

    previous = envelope;
  }

  const head = previous?.chainHash ?? null;
  if (expectedHead !== undefined && head !== expectedHead) {
    defects.push({
      kind: 'HEAD_MISMATCH',
      sequence: previous?.sequence ?? -1,
      envelopeId: previous?.envelopeId ?? null,
      detail: `Chain head ${String(head)} does not match the independently held head ${expectedHead}`,
    });
  }

  return {
    valid: defects.length === 0,
    defects,
    verifiedCount: ordered.length,
    headChainHash: head,
  };
}
