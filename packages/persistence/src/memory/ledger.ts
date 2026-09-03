/**
 * In-memory evidence ledger.
 *
 * Appends to a chain are serialized through a promise queue rather than simply
 * reading the head and writing. Two concurrent appends that both read sequence
 * N would produce two envelopes at N with the same prev-hash, forking the chain
 * into something no verifier could make sense of. The Postgres implementation
 * takes a row lock for the same reason.
 */

import {
  GENESIS_CHAIN_HASH,
  sealEnvelope,
  verifyChain,
  type AppendEvidenceRequest,
  type ChainVerification,
  type EvidenceLedger,
  type EvidenceSigner,
  type EvidenceVerifier,
  type EvidenceEnvelope,
} from '@capturelock/evidence';
import { newEnvelopeId, type Sha256Hex } from '@capturelock/core';

export class InMemoryEvidenceLedger implements EvidenceLedger {
  private readonly chains = new Map<string, EvidenceEnvelope[]>();
  private readonly byId = new Map<string, EvidenceEnvelope>();
  /** Serializes appends per chain so two writers cannot both claim one sequence. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly signer: EvidenceSigner,
    private readonly verifier: EvidenceVerifier,
  ) {}

  async append(request: AppendEvidenceRequest): Promise<EvidenceEnvelope> {
    const previous = this.locks.get(request.chainId) ?? Promise.resolve();
    const next = previous.then(() => this.appendUnsafe(request));
    // Keep the queue alive even if one append rejects, so a single failure does
    // not wedge the chain.
    this.locks.set(
      request.chainId,
      next.catch(() => undefined),
    );
    return next;
  }

  private appendUnsafe(request: AppendEvidenceRequest): EvidenceEnvelope {
    const chain = this.chains.get(request.chainId) ?? [];
    const head = chain.length === 0 ? null : chain[chain.length - 1]!;

    const sealed = sealEnvelope(
      {
        envelopeId: newEnvelopeId(),
        chainId: request.chainId,
        sequence: head === null ? 0 : head.sequence + 1,
        prevChainHash: head === null ? GENESIS_CHAIN_HASH : head.chainHash,
        recordedAt: request.recordedAt,
        kind: request.kind,
        body: request.body,
      },
      this.signer,
    );

    chain.push(sealed);
    this.chains.set(request.chainId, chain);
    this.byId.set(sealed.envelopeId, sealed);
    return sealed;
  }

  async findById(envelopeId: string): Promise<EvidenceEnvelope | null> {
    return this.byId.get(envelopeId) ?? null;
  }

  async listByChain(chainId: string): Promise<readonly EvidenceEnvelope[]> {
    return [...(this.chains.get(chainId) ?? [])];
  }

  async head(chainId: string): Promise<{ sequence: number; chainHash: Sha256Hex } | null> {
    const chain = this.chains.get(chainId);
    if (chain === undefined || chain.length === 0) return null;
    const last = chain[chain.length - 1]!;
    return { sequence: last.sequence, chainHash: last.chainHash };
  }

  async verifyChain(chainId: string, expectedHead?: Sha256Hex): Promise<ChainVerification> {
    return verifyChain(this.chains.get(chainId) ?? [], this.verifier, expectedHead);
  }

  /**
   * Captures the ledger's state and returns a restore function.
   *
   * Used by the in-memory unit of work so a rolled-back transaction leaves no
   * partial evidence — the same property the Postgres transaction gives us.
   */
  snapshot(): () => void {
    const chains = new Map([...this.chains].map(([id, list]) => [id, [...list]] as const));
    const byId = new Map(this.byId);
    return () => {
      this.chains.clear();
      for (const [id, list] of chains) this.chains.set(id, [...list]);
      this.byId.clear();
      for (const [id, envelope] of byId) this.byId.set(id, envelope);
    };
  }

  /** Test-only: replaces a stored envelope, to model an operator editing the ledger. */
  tamper(envelopeId: string, mutate: (envelope: EvidenceEnvelope) => EvidenceEnvelope): void {
    const current = this.byId.get(envelopeId);
    if (current === undefined) return;
    const replaced = mutate(current);
    this.byId.set(envelopeId, replaced);
    const chain = this.chains.get(current.chainId);
    if (chain === undefined) return;
    const index = chain.findIndex(e => e.envelopeId === envelopeId);
    if (index >= 0) chain[index] = replaced;
  }
}
