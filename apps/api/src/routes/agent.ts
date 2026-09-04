/**
 * The agentic commerce HTTP surface.
 *
 * Registered as its own module rather than inlined, because the authority split
 * here is the whole point and it should be readable in one place:
 *
 *   POST /v1/sessions              issuer  — delegating authority is not the
 *                                            agent's to grant itself
 *   POST /v1/sessions/:id/revoke   issuer  — nor is taking it back
 *   GET  /v1/sessions/:id          principal, owner only
 *   POST /v1/sessions/:id/agent    principal — run the bounded agent
 *   POST /v1/sessions/:id/purchase principal — ask TrueIntent to verify
 *   POST /v1/sessions/:id/capture  principal — ask it to capture
 *   GET  /v1/sessions/:id/purchases  principal, owner only
 *   GET  /v1/releases/:id/agent-context  operator — the console's read
 *
 * The purchase body is the part worth staring at. It carries a cart of SKUs and
 * quantities, an idempotency key, and the agent's own rationale for evidence.
 * There is no field for an amount, a currency, a total, a unit price, a verdict,
 * a user identity or a policy — and because every schema is `.strict()`, an
 * attempt to add one is a 400 rather than a value quietly ignored.
 *
 * The agent runtime is constructed here per request, over the application's
 * catalogue and its configured buyer model. It receives no repository and no
 * provider, so the strongest thing this whole module can produce on the agent's
 * behalf is a request for verification.
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  MerchantIdSchema,
  SessionBoundsSchema,
  SkuSchema,
  UserIdSchema,
  asSessionId,
  moneyHasMoved,
  remainingBudget,
  type SessionAuthorityRecord,
} from '@capturelock/core';
import { BuyerAgentRuntime, type AgentRunResult } from '@capturelock/agent';
import type { Application } from '../composition.js';
import { withIdempotency } from '../http-idempotency.js';
// Shared with `server.ts`: one constant-time comparison, not two.
import { hasAuthority, principalOf, unauthenticated } from '../auth.js';
import { buyerModelLabel, selectBuyerModel, type SelectedBuyerModel } from '../buyer-model.js';

/**
 * Session bounds, as the issuer states them.
 *
 * Reuses the domain schema so the HTTP surface cannot drift from what the
 * domain will accept — including the refinements that a per-purchase cap must
 * not exceed the total budget and that currencies must agree.
 */
const CreateSessionBody = z
  .object({
    userId: UserIdSchema,
    purpose: z.string().min(1).max(4_000),
    bounds: SessionBoundsSchema,
  })
  .strict();

const SessionIdParam = z.object({ id: z.string().min(1).max(64) }).strict();

const RunAgentBody = z
  .object({
    merchantId: MerchantIdSchema,
    /** The user's goal in their own words. Passed to the model, never to a check. */
    goal: z.string().min(1).max(1_000),
    maxSteps: z.number().int().min(1).max(50).optional(),
  })
  .strict();

/**
 * A purchase request.
 *
 * Note what is absent. There is no amount, no currency, no total, no unit
 * price, no verdict, no userId and no policy: every one of those is
 * server-resolved, and `.strict()` turns an attempt to supply one into a
 * validation failure rather than something ignored.
 */
const PurchaseBody = z
  .object({
    merchantId: MerchantIdSchema,
    lines: z
      .array(z.object({ sku: SkuSchema, quantity: z.number().int().min(1).max(10_000) }).strict())
      .min(1)
      .max(50),
    idempotencyKey: z.string().min(16).max(255),
    /** The agent's justification, recorded as evidence. Read by no check. */
    rationale: z.string().min(1).max(500),
    agentModel: z.string().min(1).max(128),
    agentSteps: z.number().int().min(0).max(1_000),
    agentRefusedSteps: z.number().int().min(0).max(1_000),
    catalogVersion: z.string().min(1).max(64),
  })
  .strict();

const CaptureBody = z
  .object({
    authorizationId: z.string().min(1).max(64),
    idempotencyKey: z.string().min(16).max(255),
  })
  .strict();

/** Projection of a session for the wire. Never exposes the policy binding. */
function sessionView(session: SessionAuthorityRecord): Record<string, unknown> {
  const remaining = remainingBudget(session);
  return {
    sessionId: session.sessionId,
    purpose: session.purpose,
    state: session.state,
    boundsHash: session.boundsHash,
    bounds: session.bounds,
    reservedMinor: session.reservedMinor,
    spentMinor: session.spentMinor,
    remaining,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

/** Maps a session-layer refusal onto a status code. */
function statusForRefusal(reasonCode: string): number {
  switch (reasonCode) {
    case 'SESSION_NOT_FOUND':
    case 'AUTHORIZATION_NOT_FOUND':
      return 404;
    case 'SESSION_NOT_OWNED':
      return 403;
    case 'LIVE_STATE_UNAVAILABLE':
      return 503;
    default:
      // Everything else is a refusal of the request as stated: an expired or
      // revoked session, an exhausted budget, an ungrounded cart. 422 rather
      // than 400, because the request was well-formed and still not permitted.
      return 422;
  }
}

function statusForVerdict(verdict: string): number {
  if (verdict === 'ALLOW') return 200;
  if (verdict === 'PAUSE') return 202;
  return 422;
}

export function registerAgentRoutes(server: FastifyInstance, app: Application): void {
  // ------------------------------------------------------------- sessions --
  // Delegating spending authority is issuer authority. An agent that could
  // create its own session would be choosing its own budget, which makes every
  // check below it ceremonial.
  server.post('/v1/sessions', async (request, reply) => {
    if (!hasAuthority(request, 'x-capturelock-issuer-key', app.config.issuerApiKey)) {
      return reply.status(403).send({
        error: 'FORBIDDEN',
        message:
          'Issuer authority required: a commerce session delegates spending authority and must originate from a trusted application.',
      });
    }
    const body = CreateSessionBody.parse(request.body);

    const created = await app.commerceSessionService.create({
      userId: body.userId,
      purpose: body.purpose,
      bounds: body.bounds,
      policyId: app.config.agentPolicyId,
      policyVersion: app.config.agentPolicyVersion,
    });

    if (created.kind === 'POLICY_NOT_FOUND') {
      return reply.status(422).send({
        error: 'POLICY_NOT_FOUND',
        message: 'No operator policy is available to bind this session to.',
      });
    }

    request.log.info(
      {
        sessionId: created.session.sessionId,
        userId: created.session.userId,
        totalBudgetMinor: created.session.bounds.totalBudget.amountMinor,
      },
      'commerce session delegated',
    );

    return reply.status(201).send(sessionView(created.session));
  });

  server.post('/v1/sessions/:id/revoke', async (request, reply) => {
    // Revocation is the user's, exercised through the trusted application. An
    // agent that could revoke could also not-revoke, which is not a power worth
    // handing it either way.
    if (!hasAuthority(request, 'x-capturelock-issuer-key', app.config.issuerApiKey)) {
      return reply
        .status(403)
        .send({ error: 'FORBIDDEN', message: 'Issuer authority required to revoke a session.' });
    }
    const { id } = SessionIdParam.parse(request.params);
    const revoked = await app.commerceSessionService.revoke(asSessionId(id));
    if (!revoked) {
      return reply
        .status(404)
        .send({ error: 'NOT_FOUND', message: 'No active session with that id.' });
    }
    return reply.send({ sessionId: id, state: 'REVOKED' });
  });

  server.get('/v1/sessions/:id', async (request, reply) => {
    const principal = principalOf(request);
    if (principal === null) return unauthenticated(reply);
    const { id } = SessionIdParam.parse(request.params);

    const session = await app.commerceSessionService.findById(asSessionId(id));
    if (session === null) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'No such session.' });
    }
    if (session.userId !== principal.userId) {
      return reply
        .status(403)
        .send({ error: 'SESSION_NOT_OWNED', message: 'That session belongs to another user.' });
    }
    return reply.send(sessionView(session));
  });

  server.get('/v1/sessions/:id/purchases', async (request, reply) => {
    const principal = principalOf(request);
    if (principal === null) return unauthenticated(reply);
    const { id } = SessionIdParam.parse(request.params);

    const session = await app.commerceSessionService.findById(asSessionId(id));
    if (session === null) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'No such session.' });
    }
    if (session.userId !== principal.userId) {
      return reply
        .status(403)
        .send({ error: 'SESSION_NOT_OWNED', message: 'That session belongs to another user.' });
    }

    const purchases = await app.deps.sessions.listPurchasesBySession(session.sessionId, 50);
    return reply.send({
      sessionId: session.sessionId,
      purchases: purchases.map(purchase => ({
        authorizationId: purchase.authorizationId,
        reservedMinor: purchase.reservedMinor,
        settlementState: purchase.settlementState,
        capsuleHash: purchase.capsuleHash,
        createdAt: purchase.createdAt,
        settledAt: purchase.settledAt,
      })),
    });
  });

  /**
   * The buyer-facing story of a session, assembled server-side.
   *
   * Principal authority, not operator: this is the user's own session, and the
   * screen that shows it is the one they are standing in front of. It carries
   * no policy binding and no operator-only field.
   *
   * Every value is projected from stored state. A step that did not happen is
   * absent rather than inferred, and `moneyMoved` is read from release state
   * rather than derived from a verdict — a refusal and an unmoved payment are
   * different claims, and only the second one is a promise worth making.
   */
  server.get('/v1/sessions/:id/timeline', async (request, reply) => {
    const principal = principalOf(request);
    if (principal === null) return unauthenticated(reply);
    const { id } = SessionIdParam.parse(request.params);

    const session = await app.commerceSessionService.findById(asSessionId(id));
    if (session === null) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'No such session.' });
    }
    if (session.userId !== principal.userId) {
      return reply
        .status(403)
        .send({ error: 'SESSION_NOT_OWNED', message: 'That session belongs to another user.' });
    }

    const purchases = await app.deps.sessions.listPurchasesBySession(session.sessionId, 50);

    const timeline = await Promise.all(
      purchases.map(async purchase => {
        const authorizationId = purchase.authorizationId as never;
        // Terminal releases included: a refused purchase is exactly the case
        // this screen exists to show, and `findActiveByAuthorization` would
        // return null for it.
        const releases = await app.deps.releases.listByAuthorization(authorizationId, 1);
        const release = releases[0] ?? null;
        const evaluations =
          release === null ? [] : await app.deps.evaluations.listByRelease(release.releaseId);
        const chain = await app.deps.evidence.listByChain(purchase.authorizationId);
        const verification = await app.deps.evidence.verifyChain(purchase.authorizationId);
        const capsuleEnvelope = chain.find(entry => entry.kind === 'AGENT_CONTEXT');

        return {
          authorizationId: purchase.authorizationId,
          releaseId: release?.releaseId ?? null,
          state: release?.state ?? null,
          amount: release === null ? null : release.amount,
          settlementState: purchase.settlementState,
          reservedMinor: purchase.reservedMinor,
          capsuleHash: purchase.capsuleHash,
          capsule: (capsuleEnvelope?.body as { capsule?: unknown } | undefined)?.capsule ?? null,
          gates: evaluations.map(evaluation => ({
            gate: evaluation.gate,
            verdict: evaluation.decision.verdict,
            reasonCodes: evaluation.decision.reasonCodes,
            findings: evaluation.decision.findings.map(finding => ({
              code: finding.code,
              severity: finding.severity,
              stage: finding.stage,
              message: finding.message,
              detail: finding.detail,
            })),
            decisionHash: evaluation.decisionHash,
            evaluatedAt: evaluation.evaluatedAt,
          })),
          providerOrderId: release?.providerOrderId ?? null,
          providerPaymentId: release?.providerPaymentId ?? null,
          // From release state, never from a verdict.
          moneyMoved: release === null ? false : moneyHasMoved(release.state),
          evidence: {
            chainId: purchase.authorizationId,
            envelopeCount: chain.length,
            kinds: chain.map(entry => entry.kind),
            valid: verification.valid,
            headChainHash: verification.headChainHash,
          },
          createdAt: purchase.createdAt,
        };
      }),
    );

    return reply.send({
      session: sessionView(session),
      purchases: timeline,
      anyMoneyMoved: timeline.some(entry => entry.moneyMoved),
      paymentProvider: app.providerName,
    });
  });

  // ---------------------------------------------------------------- agent --
  // Runs the bounded agent. It shops; it does not buy. The response is a draft
  // cart and a step log, and the caller must still ask for a purchase.
  server.post('/v1/sessions/:id/agent', async (request, reply) => {
    const principal = principalOf(request);
    if (principal === null) return unauthenticated(reply);
    const { id } = SessionIdParam.parse(request.params);
    const body = RunAgentBody.parse(request.body);

    const session = await app.commerceSessionService.findById(asSessionId(id));
    if (session === null) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'No such session.' });
    }
    if (session.userId !== principal.userId) {
      return reply
        .status(403)
        .send({ error: 'SESSION_NOT_OWNED', message: 'That session belongs to another user.' });
    }

    const selected = selectBuyerModel(app.config);
    const runtime = new BuyerAgentRuntime({
      // The catalogue and a model. No repository, no provider, no kernel.
      // Whichever model was selected reaches the same bounded tool vocabulary.
      catalog: app.productCatalog,
      model: selected.model,
      maxSteps: body.maxSteps,
    });

    const result = await runtime.run({
      session,
      merchantId: body.merchantId,
      goal: body.goal,
    });

    request.log.info(
      {
        sessionId: session.sessionId,
        model: result.model,
        modelKind: selected.kind,
        outcome: result.outcome.kind,
        steps: result.steps.length,
      },
      'bounded agent run finished',
    );

    return reply.send(agentRunView(result, selected));
  });

  // ------------------------------------------------------------- purchase --
  // The agent asks. TrueIntent decides. This route cannot approve anything:
  // it hands the request to the commerce service, which derives a mandate and
  // runs the unchanged order gate.
  server.post('/v1/sessions/:id/purchase', async (request, reply) => {
    const principal = principalOf(request);
    if (principal === null) return unauthenticated(reply);
    const { id } = SessionIdParam.parse(request.params);
    const body = PurchaseBody.parse(request.body);

    return withIdempotency(
      app.idempotency,
      reply,
      {
        key: body.idempotencyKey,
        route: 'POST /v1/sessions/:id/purchase',
        body: { ...body, sessionId: id },
        principal,
      },
      async () => {
        const result = await app.commerceSessionService.requestPurchase({
          sessionId: asSessionId(id),
          principal: principal as never,
          merchantId: body.merchantId,
          lines: body.lines,
          idempotencyKey: body.idempotencyKey as never,
          rationale: body.rationale,
          agentModel: body.agentModel,
          agentSteps: body.agentSteps,
          agentRefusedSteps: body.agentRefusedSteps,
          catalogVersion: body.catalogVersion,
        });

        if (result.kind === 'REFUSED') {
          request.log.info(
            { sessionId: id, reasonCode: result.reasonCode },
            'purchase refused before verification',
          );
          return {
            statusCode: statusForRefusal(result.reasonCode),
            body: {
              error: result.reasonCode,
              message: result.detail,
              // Stated explicitly: nothing was verified, so no release and no
              // evidence chain exist for this attempt.
              verified: false,
              moneyMoved: false,
            },
          };
        }

        request.log.info(
          {
            sessionId: id,
            authorizationId: result.authorizationId,
            verdict: result.outcome.verdict,
            reasonCodes: result.outcome.reasonCodes,
            releaseId: result.outcome.releaseId,
            capsuleHash: result.capsuleHash,
          },
          'agentic order gate decided',
        );

        return {
          statusCode: statusForVerdict(result.outcome.verdict),
          body: {
            sessionId: result.sessionId,
            authorizationId: result.authorizationId,
            snapshotId: result.snapshotId,
            capsuleHash: result.capsuleHash,
            replayedPurchase: result.replayedPurchase,
            ...result.outcome,
          },
        };
      },
    );
  });

  // The capture gate, reached through the session so the hold can be settled.
  server.post('/v1/sessions/:id/capture', async (request, reply) => {
    const principal = principalOf(request);
    if (principal === null) return unauthenticated(reply);
    const { id } = SessionIdParam.parse(request.params);
    const body = CaptureBody.parse(request.body);

    return withIdempotency(
      app.idempotency,
      reply,
      {
        key: body.idempotencyKey,
        route: 'POST /v1/sessions/:id/capture',
        body: { ...body, sessionId: id },
        principal,
      },
      async () => {
        const result = await app.commerceSessionService.requestCapture({
          sessionId: asSessionId(id),
          authorizationId: body.authorizationId as never,
          principal: principal as never,
          idempotencyKey: body.idempotencyKey as never,
        });

        if (result.kind === 'REFUSED') {
          return {
            statusCode: statusForRefusal(result.reasonCode),
            body: {
              error: result.reasonCode,
              message: result.detail,
              verified: false,
              moneyMoved: false,
            },
          };
        }

        request.log.info(
          {
            sessionId: id,
            authorizationId: result.authorizationId,
            verdict: result.outcome.verdict,
            reasonCodes: result.outcome.reasonCodes,
            moneyMoved: result.outcome.moneyMoved,
          },
          'agentic capture gate decided',
        );

        return {
          statusCode: statusForVerdict(result.outcome.verdict),
          body: {
            sessionId: result.sessionId,
            authorizationId: result.authorizationId,
            capsuleHash: result.capsuleHash,
            ...result.outcome,
          },
        };
      },
    );
  });

  // ------------------------------------------------------- agent context --
  // The console's read. Operator authority, because it discloses the user's
  // stated intent and the agent's reasoning about it.
  server.get('/v1/releases/:id/agent-context', async (request, reply) => {
    if (!hasAuthority(request, 'x-capturelock-operator-key', app.config.operatorApiKey)) {
      return reply.status(403).send({
        error: 'FORBIDDEN',
        message: 'Operator authority required: this discloses user intent and agent reasoning.',
      });
    }
    const { id } = SessionIdParam.parse(request.params);

    const release = await app.deps.releases.findById(id as never);
    if (release === null) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'No such release.' });
    }

    const purchase = await app.deps.sessions.findPurchaseByAuthorization(release.authorizationId);
    if (purchase === null) {
      // A release with no agentic context is an ordinary API-driven one. Not an
      // error: the console asks about every release it shows.
      return reply.send({ releaseId: id, agentic: false, capsule: null, session: null });
    }

    const session = await app.commerceSessionService.findById(purchase.sessionId);
    const chain = await app.deps.evidence.listByChain(release.authorizationId);
    const envelope = chain.find(entry => entry.kind === 'AGENT_CONTEXT');

    return reply.send({
      releaseId: id,
      agentic: true,
      capsuleHash: purchase.capsuleHash,
      settlementState: purchase.settlementState,
      reservedMinor: purchase.reservedMinor,
      capsule: (envelope?.body as { capsule?: unknown } | undefined)?.capsule ?? null,
      evidenceEnvelopeId: envelope?.envelopeId ?? null,
      session: session === null ? null : sessionView(session),
    });
  });
}

/** Projects an agent run for the wire. The step log is the interesting part. */
function agentRunView(
  result: AgentRunResult,
  selected: SelectedBuyerModel,
): Record<string, unknown> {
  return {
    model: result.model,
    // Which kind of model actually drove this run, so a screen states it
    // rather than asking a viewer to recognise a model name. Carries no key,
    // no key fragment and no prompt.
    modelKind: selected.kind,
    modelLabel: buyerModelLabel(selected.kind),
    modelReason: selected.reason,
    outcome: result.outcome,
    steps: result.steps.map(step => ({
      index: step.index,
      action: step.action,
      accepted: step.accepted,
      refusedWith: step.refusedWith,
      detail: step.detail,
    })),
    observed: result.observed.map(product => ({
      sku: product.sku,
      name: product.name,
      category: product.category,
      // Labelled indicative, because it is: the charged price is resolved
      // server-side at quote time and re-read at both gates.
      indicativeUnitPriceMinor: product.unitPrice.amountMinor,
      currency: product.unitPrice.currency,
      available: product.available,
      availableStock: product.availableStock,
    })),
  };
}
