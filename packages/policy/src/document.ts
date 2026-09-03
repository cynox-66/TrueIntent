/**
 * A policy document: a versioned, content-addressed set of rules.
 *
 * `rules` is typed as `unknown[]` on purpose. A policy is durable data that
 * outlives the binary reading it, so a document written by a newer deployment
 * may contain a rule kind this build has never heard of. If the document schema
 * rejected the whole thing, the system would fail *open* in the worst way — an
 * operator would remove the offending rule to make things work again.
 *
 * Instead each rule is parsed individually at evaluation time, and one that
 * fails to parse becomes a DENY-severity violation. An unreadable rule stops
 * the transaction; it never gets skipped. See ADR-003.
 */

import { z } from 'zod';
import { hash, type Sha256Hex, type Timestamp, TimestampSchema } from '@capturelock/core';

export const PolicyDocumentSchema = z
  .object({
    policyId: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/, 'Policy id must be lower_snake_case'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Policy version must be semver-like'),
    name: z.string().min(1).max(128),
    rules: z.array(z.unknown()).max(256),
    createdAt: TimestampSchema,
  })
  .strict();

export interface PolicyDocument {
  readonly policyId: string;
  readonly version: string;
  readonly name: string;
  readonly rules: readonly unknown[];
  readonly createdAt: Timestamp;
}

/**
 * Content address of a policy.
 *
 * Bound to the authorization at issuance, so at execution time we can prove the
 * policy being enforced is the one the user's authorization was created under —
 * not a permissive one substituted later.
 */
export function computePolicyHash(document: PolicyDocument): Sha256Hex {
  return hash('capturelock.v1.policy', {
    policyId: document.policyId,
    version: document.version,
    name: document.name,
    createdAt: document.createdAt,
    rules: [...document.rules],
  });
}

export interface PolicyRepository {
  findByIdAndVersion(policyId: string, version: string): Promise<PolicyDocument | null>;
  insert(document: PolicyDocument): Promise<void>;
}
