/**
 * Stage 2: does a valid, unspent authorization actually exist?
 *
 * This is where "the agent asked nicely" stops being sufficient. Nothing here
 * reads the request body: the authorization is loaded server-side by id, and
 * the principal comes from the API layer's authentication rather than from a
 * field the caller supplied.
 */

import { finding, hash, intentHashInput, isAfter, isBefore, type Finding } from '@capturelock/core';
import type { VerificationContext } from '../context.js';
import { blocked, completed, type StageOutcome, type VerificationStage } from '../pipeline.js';

const STAGE = 'AUTHORITY' as const;

export const authorityStage: VerificationStage = {
  id: STAGE,
  run(context: VerificationContext): StageOutcome {
    const authorization = context.authorization;

    if (authorization === null) {
      return blocked('authorization', [
        finding(
          STAGE,
          'AUTHORIZATION_NOT_FOUND',
          'No authorization exists for the referenced id, so nothing has been authorized to spend.',
        ),
      ]);
    }

    const findings: Finding[] = [];

    switch (authorization.state) {
      case 'REVOKED':
        findings.push(
          finding(STAGE, 'AUTHORIZATION_REVOKED', 'The user revoked this authorization.', {
            revokedAt: authorization.revokedAt ?? 'unknown',
          }),
        );
        break;
      case 'CONSUMED':
        findings.push(
          finding(
            STAGE,
            'AUTHORIZATION_ALREADY_CONSUMED',
            'This authorization was already spent by a settled release; presenting it again is a replay.',
            { consumedByReleaseId: authorization.consumedByReleaseId ?? 'unknown' },
          ),
        );
        break;
      case 'EXPIRED':
        findings.push(
          finding(STAGE, 'AUTHORIZATION_EXPIRED', 'The authorization is marked expired.'),
        );
        break;
      case 'ACTIVE':
        break;
    }

    const constraints = authorization.intent.constraints;
    if (isBefore(context.evaluatedAt, constraints.notBefore)) {
      findings.push(
        finding(STAGE, 'AUTHORIZATION_NOT_YET_VALID', 'The authorization window has not opened.', {
          notBefore: constraints.notBefore,
          evaluatedAt: context.evaluatedAt,
        }),
      );
    }
    if (isAfter(context.evaluatedAt, constraints.notAfter)) {
      findings.push(
        finding(STAGE, 'AUTHORIZATION_EXPIRED', 'The authorization window has closed.', {
          notAfter: constraints.notAfter,
          evaluatedAt: context.evaluatedAt,
        }),
      );
    }

    if (authorization.userId !== context.principal.userId) {
      findings.push(
        finding(
          STAGE,
          'USER_MISMATCH',
          'The authenticated principal does not own this authorization.',
          { authorizationUserId: authorization.userId, principalUserId: context.principal.userId },
        ),
      );
    }

    if (authorization.sessionId !== context.principal.sessionId) {
      findings.push(
        finding(
          STAGE,
          'SESSION_MISMATCH',
          'The presented session is not the one bound to this authorization.',
          {
            authorizationSessionId: authorization.sessionId,
            principalSessionId: context.principal.sessionId,
          },
        ),
      );
    }

    // Recompute the intent hash. If the constraints row was edited after
    // issuance — raising a budget, dropping a required attribute — the stored
    // hash no longer matches and we refuse rather than enforce the new terms.
    const recomputed = hash('capturelock.v1.intent', intentHashInput(authorization.intent));
    if (recomputed !== authorization.intentHash) {
      findings.push(
        finding(
          STAGE,
          'INTENT_HASH_MISMATCH',
          'The stored intent does not hash to the value recorded at issuance.',
          { storedHash: authorization.intentHash, recomputedHash: recomputed },
        ),
      );
    }

    return completed(findings);
  },
};
