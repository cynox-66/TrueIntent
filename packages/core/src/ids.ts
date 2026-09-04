/**
 * Prefixed, branded identifiers.
 *
 * Every identifier carries a type prefix so that a mis-wired call site is
 * obvious in logs and in evidence, and so a release id can never be passed
 * where an authorization id is expected.
 */

import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { Brand } from './brand.js';
import type { Sha256Hex } from './canonical.js';
import { CaptureLockError } from './errors.js';

export type AuthorizationId = Brand<string, 'AuthorizationId'>;
export type SnapshotId = Brand<string, 'SnapshotId'>;
export type ReleaseId = Brand<string, 'ReleaseId'>;
export type EvaluationId = Brand<string, 'EvaluationId'>;
export type EnvelopeId = Brand<string, 'EnvelopeId'>;
export type ReviewId = Brand<string, 'ReviewId'>;
export type RequestId = Brand<string, 'RequestId'>;
export type ChainId = Brand<string, 'ChainId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;
export type UserId = Brand<string, 'UserId'>;
export type MerchantId = Brand<string, 'MerchantId'>;
export type Sku = Brand<string, 'Sku'>;

/**
 * Receipt sent to the payment provider.
 *
 * Razorpay caps `receipt` at 40 characters and treats it as an idempotency key,
 * so this type exists to make the length constraint impossible to violate by
 * accident. See ADR-006.
 */
export type Receipt = Brand<string, 'Receipt'>;

export const ID_PREFIXES = {
  authorization: 'auth',
  snapshot: 'snap',
  release: 'rel',
  evaluation: 'evl',
  envelope: 'env',
  review: 'rev',
  request: 'req',
  chain: 'chn',
  session: 'sess',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

function randomSuffix(): string {
  return randomUUID().replace(/-/g, '');
}

function makeId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomSuffix()}`;
}

function pattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}_[0-9a-f]{32}$`);
}

function parseId<T extends string>(kind: IdKind, value: string): T {
  if (!pattern(kind).test(value)) {
    throw new CaptureLockError('INVALID_IDENTIFIER', `Malformed ${kind} identifier`, { kind });
  }
  return value as T;
}

function idSchema<T extends string>(kind: IdKind): z.ZodType<T, z.ZodTypeDef, string> {
  return z
    .string()
    .regex(pattern(kind), `Must be a valid ${kind} identifier`)
    .transform(value => value as T);
}

export const newAuthorizationId = (): AuthorizationId => makeId('authorization') as AuthorizationId;
export const newSnapshotId = (): SnapshotId => makeId('snapshot') as SnapshotId;
export const newReleaseId = (): ReleaseId => makeId('release') as ReleaseId;
export const newEvaluationId = (): EvaluationId => makeId('evaluation') as EvaluationId;
export const newEnvelopeId = (): EnvelopeId => makeId('envelope') as EnvelopeId;
export const newReviewId = (): ReviewId => makeId('review') as ReviewId;
export const newRequestId = (): RequestId => makeId('request') as RequestId;
export const newChainId = (): ChainId => makeId('chain') as ChainId;
export const newSessionId = (): SessionId => makeId('session') as SessionId;

export const asAuthorizationId = (v: string): AuthorizationId =>
  parseId<AuthorizationId>('authorization', v);
export const asSnapshotId = (v: string): SnapshotId => parseId<SnapshotId>('snapshot', v);
export const asReleaseId = (v: string): ReleaseId => parseId<ReleaseId>('release', v);
export const asEnvelopeId = (v: string): EnvelopeId => parseId<EnvelopeId>('envelope', v);
export const asChainId = (v: string): ChainId => parseId<ChainId>('chain', v);
export const asReviewId = (v: string): ReviewId => parseId<ReviewId>('review', v);
export const asSessionId = (v: string): SessionId => parseId<SessionId>('session', v);

export const AuthorizationIdSchema = idSchema<AuthorizationId>('authorization');
export const SnapshotIdSchema = idSchema<SnapshotId>('snapshot');
export const ReleaseIdSchema = idSchema<ReleaseId>('release');
export const EvaluationIdSchema = idSchema<EvaluationId>('evaluation');
export const EnvelopeIdSchema = idSchema<EnvelopeId>('envelope');
export const ReviewIdSchema = idSchema<ReviewId>('review');
export const RequestIdSchema = idSchema<RequestId>('request');
export const ChainIdSchema = idSchema<ChainId>('chain');
export const SessionIdSchema = idSchema<SessionId>('session');

/**
 * Identifiers supplied by callers (users, merchants, SKUs) are restricted to a
 * conservative charset.
 *
 * These strings are compared against allowlists. Permitting arbitrary Unicode
 * would allow a homoglyph merchant id that looks identical to an allowlisted
 * one but compares unequal — or worse, one that normalizes into a match
 * somewhere downstream.
 */
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function externalIdSchema<T extends string>(label: string): z.ZodType<T, z.ZodTypeDef, string> {
  return z
    .string()
    .regex(
      EXTERNAL_ID_PATTERN,
      `${label} must be 1-128 chars of [A-Za-z0-9._:-] and start alphanumeric`,
    )
    .transform(value => value as T);
}

export const UserIdSchema = externalIdSchema<UserId>('User id');
export const MerchantIdSchema = externalIdSchema<MerchantId>('Merchant id');
export const SkuSchema = externalIdSchema<Sku>('SKU');

/**
 * Client-supplied idempotency key.
 *
 * Deliberately opaque to CaptureLock: it dedups *requests*. It does not and
 * cannot bound money movement on its own, because the agent chooses it. The
 * server-derived receipt below is what bounds money movement.
 */
export const IdempotencyKeySchema = z
  .string()
  .min(16, 'Idempotency key must be at least 16 characters')
  .max(255)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency key must be [A-Za-z0-9._:-]')
  .transform(value => value as IdempotencyKey);

export const MAX_RECEIPT_LENGTH = 40;
const RECEIPT_PREFIX = 'cl_';

/**
 * Derives the provider receipt deterministically from the authorization and the
 * exact cart being paid for.
 *
 * Two properties matter:
 *
 * - Deterministic: a retry after a timeout recomputes the same receipt, so the
 *   provider recognises it. This is what makes recovery possible at all.
 * - Server-derived: the agent cannot mint a fresh receipt to escape dedup by
 *   varying its own idempotency key.
 *
 * 24 bytes of SHA-256 output are base64url-encoded to 32 characters, giving a
 * 35-character receipt inside Razorpay's 40-character limit. Truncating to 192
 * bits keeps collision resistance far beyond what a per-account receipt
 * namespace requires.
 */
export function deriveReceipt(authorizationId: AuthorizationId, snapshotHash: Sha256Hex): Receipt {
  const digest = createHash('sha256')
    .update(Buffer.from('capturelock.v1.receipt', 'utf8'))
    .update(Buffer.of(0x00))
    .update(Buffer.from(authorizationId, 'utf8'))
    .update(Buffer.of(0x00))
    .update(Buffer.from(snapshotHash, 'utf8'))
    .digest();
  const receipt = `${RECEIPT_PREFIX}${digest.subarray(0, 24).toString('base64url')}`;
  if (receipt.length > MAX_RECEIPT_LENGTH) {
    throw new CaptureLockError('INVARIANT_VIOLATION', 'Derived receipt exceeds provider limit', {
      length: receipt.length,
    });
  }
  return receipt as Receipt;
}

export const ReceiptSchema = z
  .string()
  .max(MAX_RECEIPT_LENGTH)
  .regex(/^cl_[A-Za-z0-9_-]+$/, 'Malformed receipt')
  .transform(value => value as Receipt);
