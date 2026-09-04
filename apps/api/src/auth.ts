/**
 * The three authority classes, in one place.
 *
 * The kernel faithfully enforces whatever mandate it is given. Nothing it does
 * prevents a caller from *writing its own mandate*, or from clearing its own
 * PAUSE — that has to be prevented at this boundary, and in Phase 1 it was not.
 *
 *   principal  the acting user and session. An agent has this and nothing else.
 *   issuer     may create an authorization or delegate a commerce session.
 *              The trusted user-facing application.
 *   operator   may resolve a paused review, force reconciliation, read agent
 *              context. A human console.
 *
 * These live in their own module because the comparison is security-relevant
 * and was previously written out twice. Two constant-time comparisons are two
 * things to get subtly different, and the second copy is the one nobody
 * reviews — so there is one.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const USER_HEADER = 'x-capturelock-user';
export const SESSION_HEADER = 'x-capturelock-session';
export const ISSUER_KEY_HEADER = 'x-capturelock-issuer-key';
export const OPERATOR_KEY_HEADER = 'x-capturelock-operator-key';
export const OPERATOR_NAME_HEADER = 'x-capturelock-operator';

export interface HttpPrincipal {
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * Whether the request carries the expected shared secret for `header`.
 *
 * Returns false when no secret is configured, so a missing key can never be
 * matched by an absent header. Length is checked first because
 * `timingSafeEqual` throws on a length mismatch, and that throw would itself be
 * a timing signal.
 */
export function hasAuthority(
  request: FastifyRequest,
  header: string,
  expected: string | undefined,
): boolean {
  if (expected === undefined) return false;
  const presented = request.headers[header];
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The authenticated principal, or null.
 *
 * Identity is always taken from headers, never from a request body. A body-
 * supplied user id is a user id chosen by the party being checked.
 */
export function principalOf(request: FastifyRequest): HttpPrincipal | null {
  const userId = request.headers[USER_HEADER];
  const sessionId = request.headers[SESSION_HEADER];
  if (typeof userId !== 'string' || typeof sessionId !== 'string') return null;
  return { userId, sessionId };
}

export function forbidden(reply: FastifyReply, authority: string, why: string): FastifyReply {
  return reply
    .status(403)
    .send({ error: 'FORBIDDEN', message: `${authority} authority required: ${why}` });
}

export function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: 'UNAUTHENTICATED',
    message: `${USER_HEADER} and ${SESSION_HEADER} are required.`,
  });
}
