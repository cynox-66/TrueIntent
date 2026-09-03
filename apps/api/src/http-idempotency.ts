/**
 * The request-scoped idempotency wrapper the routes call explicitly.
 *
 * Deliberately not hidden middleware. A route that can move money should read
 * as though it does what it does; burying the replay semantics in a plugin
 * makes the most security-relevant behaviour in the file invisible at the call
 * site.
 *
 * Semantics, all four of them:
 *
 *   same key, same fingerprint, completed  → replay the stored response verbatim
 *   same key, different fingerprint        → 409, never answered from cache
 *   same key, still in flight              → 409, the caller should retry later
 *   crash while in flight                  → the row stays IN_FLIGHT; the sweep
 *                                            resolves the release, and the stale
 *                                            claim is reaped so a retry can proceed
 *
 * The third case returning 409 rather than blocking is deliberate: waiting would
 * tie up a connection on a request whose outcome we cannot predict, and a client
 * that retries is in a better position to decide how long to wait than we are.
 */

import type { FastifyReply } from 'fastify';
import { fingerprintOf, type IdempotencyStore } from './idempotency.js';

export interface IdempotentResult {
  readonly statusCode: number;
  readonly body: unknown;
}

export async function withIdempotency(
  store: IdempotencyStore,
  reply: FastifyReply,
  input: {
    readonly key: string | null;
    readonly route: string;
    readonly body: unknown;
    readonly principal: { userId: string; sessionId: string } | null;
  },
  work: () => Promise<IdempotentResult>,
): Promise<FastifyReply> {
  // No key means no replay protection is being asked for. Endpoints that must
  // have one enforce it in their schema, so reaching here without one means the
  // caller opted out on an endpoint where that is safe.
  if (input.key === null) {
    const result = await work();
    return reply.status(result.statusCode).send(result.body);
  }

  const fingerprint = fingerprintOf(input.route, input.body, input.principal);
  const claim = await store.claim(input.key, input.route, fingerprint);

  switch (claim.kind) {
    case 'REPLAY':
      return reply
        .status(claim.statusCode)
        .header('idempotency-replayed', 'true')
        .send(claim.response);

    case 'FINGERPRINT_MISMATCH':
      return reply.status(409).send({
        error: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
        message:
          'This idempotency key was already used for a materially different request. Reusing it would return an answer given for other input.',
      });

    case 'IN_FLIGHT':
      return reply.status(409).send({
        error: 'REQUEST_IN_FLIGHT',
        message: 'A request with this idempotency key is already being processed.',
      });

    case 'CLAIMED':
      break;
  }

  try {
    const result = await work();
    await store.complete(input.key, result.statusCode, result.body);
    return reply.status(result.statusCode).send(result.body);
  } catch (error) {
    // Release the claim so a retry is not blocked forever by a request that
    // failed before producing an answer. The work itself is separately
    // recoverable: anything that reached the provider left a durable release
    // row for the sweeps to resolve.
    await store.abandon(input.key);
    throw error;
  }
}
