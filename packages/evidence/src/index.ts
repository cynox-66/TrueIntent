/**
 * @capturelock/evidence
 *
 * Evidence Envelope and Replayable Proof Ledger Contracts for CaptureLock.
 *
 * NOTE: Phase 0 environment bootstrap only.
 * No cryptographic hashing or storage logic is implemented here.
 */

import { z } from 'zod';
import {
  CartSnapshotSchema,
  IntentSnapshotSchema,
  VerificationVerdictSchema,
  ReasonCodeSchema,
} from '@capturelock/core';

/**
 * Portable, replayable proof artifact emitted for every charge attempt.
 */
export const EvidenceEnvelopeSchema = z.object({
  envelopeId: z.string().uuid(),
  sessionId: z.string().uuid(),
  sequenceNumber: z.number().int().nonnegative(),
  previousEnvelopeHash: z.string().min(1),
  currentEnvelopeHash: z.string().min(1),
  timestamp: z.string().datetime(),
  intentSnapshot: IntentSnapshotSchema,
  cartSnapshot: CartSnapshotSchema,
  policyVersion: z.string().min(1),
  liveStateDigest: z.string().min(1),
  verdict: VerificationVerdictSchema,
  reasonCodes: z.array(ReasonCodeSchema),
  idempotencyKey: z.string().min(8),
  razorpayOrderId: z.string().optional(),
  razorpayPaymentId: z.string().optional(),
});
export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;

/**
 * Interface contract for the append-only evidence ledger.
 */
export interface IEvidenceLedger {
  append(envelope: Omit<EvidenceEnvelope, 'currentEnvelopeHash'>): Promise<EvidenceEnvelope>;
  getById(envelopeId: string): Promise<EvidenceEnvelope | null>;
  verifyChain(
    fromSequence?: number,
    toSequence?: number,
  ): Promise<{ valid: boolean; error?: string }>;
}
