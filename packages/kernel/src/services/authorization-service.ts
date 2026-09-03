/**
 * Creates authorizations.
 *
 * The constraints arrive already structured. Turning a sentence into
 * constraints is *normalization*, and it belongs upstream of this call, behind
 * the `IntentNormalizer` port, so that no deterministic check ever depends on a
 * model's output. What this service does is freeze the result: it hashes the
 * constraints and binds a specific policy version, so neither can be changed
 * afterwards without the authority and policy stages noticing.
 */

import {
  hash,
  intentHashInput,
  newAuthorizationId,
  type AuthorizationRecord,
  type AuthorizedIntent,
  type UserId,
} from '@capturelock/core';
import { computePolicyHash } from '@capturelock/policy';
import type { CoreDependencies } from './dependencies.js';

export interface CreateAuthorizationRequest {
  readonly userId: UserId;
  readonly sessionId: string;
  readonly intent: AuthorizedIntent;
  readonly policyId: string;
  readonly policyVersion: string;
}

export type CreateAuthorizationResult =
  | { readonly kind: 'CREATED'; readonly authorization: AuthorizationRecord }
  | { readonly kind: 'POLICY_NOT_FOUND' };

export class AuthorizationService {
  constructor(private readonly deps: CoreDependencies) {}

  async create(request: CreateAuthorizationRequest): Promise<CreateAuthorizationResult> {
    const policy = await this.deps.policies.findByIdAndVersion(
      request.policyId,
      request.policyVersion,
    );
    // An authorization with no enforceable policy would be a mandate with no
    // operator constraints at all, so it is refused rather than created.
    if (policy === null) return { kind: 'POLICY_NOT_FOUND' };

    const record: AuthorizationRecord = {
      authorizationId: newAuthorizationId(),
      userId: request.userId,
      sessionId: request.sessionId,
      intent: request.intent,
      // Content address of the constraints. Editing the stored row later
      // invalidates this and the authority stage refuses.
      intentHash: hash('capturelock.v1.intent', intentHashInput(request.intent)),
      policyId: policy.policyId,
      policyVersion: policy.version,
      // Content address of the policy, so substituting a permissive document
      // under the same id and version is detectable.
      policyHash: computePolicyHash(policy),
      state: 'ACTIVE',
      createdAt: this.deps.clock.now(),
      revokedAt: null,
      consumedByReleaseId: null,
    };

    await this.deps.authorizations.insert(record);
    return { kind: 'CREATED', authorization: record };
  }

  async revoke(authorizationId: AuthorizationRecord['authorizationId']): Promise<boolean> {
    const updated = await this.deps.authorizations.transition(
      authorizationId as Parameters<typeof this.deps.authorizations.transition>[0],
      ['ACTIVE'],
      'REVOKED',
      { revokedAt: this.deps.clock.now() },
    );
    return updated !== null;
  }
}
