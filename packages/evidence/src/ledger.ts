/**
 * The append-only evidence ledger.
 *
 * Append is the only mutation. There is no update and no delete on this port,
 * and the Postgres schema backs that with triggers that reject UPDATE and
 * DELETE outright — "append-only at the application level" is a convention, and
 * conventions do not survive an incident at 3am.
 *
 * Appends to one chain must be serialized. Two concurrent appends that both
 * read the same head would produce two envelopes claiming the same sequence and
 * the same prev-hash, forking the chain. The Postgres implementation takes a row
 * lock on the chain head inside the transaction, with a UNIQUE (chain_id,
 * sequence) constraint as the backstop.
 */

import type { Sha256Hex, Timestamp } from '@capturelock/core';
import type { ChainVerification, EnvelopeKind, EvidenceEnvelope } from './envelope.js';

export interface AppendEvidenceRequest {
  readonly chainId: string;
  readonly kind: EnvelopeKind;
  readonly body: unknown;
  readonly recordedAt: Timestamp;
}

export interface EvidenceLedger {
  /**
   * Appends one envelope, computing its sequence and prev-hash from the current
   * chain head under a lock. Returns the sealed envelope, whose `chainHash` the
   * caller can hand to a client as an independent witness.
   */
  append(request: AppendEvidenceRequest): Promise<EvidenceEnvelope>;
  findById(envelopeId: string): Promise<EvidenceEnvelope | null>;
  listByChain(chainId: string): Promise<readonly EvidenceEnvelope[]>;
  head(chainId: string): Promise<{ sequence: number; chainHash: Sha256Hex } | null>;
  verifyChain(chainId: string, expectedHead?: Sha256Hex): Promise<ChainVerification>;
}
