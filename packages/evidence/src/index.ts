/**
 * @capturelock/evidence
 *
 * Tamper-evident, replayable proof records: a signed hash chain over
 * canonicalizable payloads. Deliberately ignorant of what a payload means, so
 * the ledger stays a general-purpose primitive rather than a second copy of the
 * domain model.
 */

export {
  ENVELOPE_KINDS,
  GENESIS_CHAIN_HASH,
  computeChainHash,
  sealEnvelope,
  verifyChain,
  type ChainDefect,
  type ChainDefectKind,
  type ChainVerification,
  type EnvelopeKind,
  type EvidenceEnvelope,
  type UnsealedEnvelope,
} from './envelope.js';

export {
  createSigner,
  createVerifier,
  generateEvidenceKeyPair,
  publicKeyFingerprint,
  publicKeyFromPrivate,
  type EvidenceKeyPair,
  type EvidenceSigner,
  type EvidenceVerifier,
} from './signing.js';

export type { AppendEvidenceRequest, EvidenceLedger } from './ledger.js';
