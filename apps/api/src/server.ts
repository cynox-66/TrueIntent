/**
 * HTTP surface.
 *
 * Deliberately thin: every handler validates, calls a service, and maps the
 * result. There is no business logic here, and no route holds a payment
 * provider — the composition root gives those only to the release and
 * reconciliation services.
 *
 * There is exactly one endpoint that can move money (`POST /v1/releases/:id/capture`)
 * and one that can create a payable order (`POST /v1/releases`). Both go
 * through the kernel; neither has a bypass, an override flag, or a "force"
 * parameter.
 */

import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import {
  CaptureLockError,
  asAuthorizationId,
  asReleaseId,
  asReviewId,
  type AuthorizedIntent,
} from '@capturelock/core';
import { RAZORPAY_EVENT_ID_HEADER, RAZORPAY_SIGNATURE_HEADER } from '@capturelock/integrations';
import { deserializeContext, evaluate } from '@capturelock/kernel';
import { computeDecisionHash } from '@capturelock/core';
import type { Application } from './composition.js';
import { withIdempotency } from './http-idempotency.js';
import { registerDevRoutes } from './routes/dev.js';
import {
  AuthorizationIdParam,
  CaptureBody,
  CreateAuthorizationBody,
  CreateQuoteBody,
  CreateReleaseBody,
  ReleaseIdParam,
  ResolveReviewBody,
  ReviewIdParam,
} from './routes/schemas.js';

export interface ServerOptions {
  readonly logger?: boolean;
  readonly app: Application;
}

/**
 * Establishes who is asking.
 *
 * A prototype stand-in for real authentication, but the shape is the point: the
 * principal comes from transport headers the agent's *operator* sets, not from
 * the request body. An agent that could name its own user id could spend
 * someone else's mandate.
 */
/**
 * Three distinct authorities, and an agent holds only the first.
 *
 * The separation is the point. An agent that could issue its own authorization
 * would set its own budget; an agent that could resolve its own paused release
 * would defeat the purpose of pausing. Neither is prevented by anything the
 * kernel does — the kernel faithfully enforces whatever mandate it is given —
 * so it has to be prevented here.
 *
 *   principal  the acting user/session. Agents have this.
 *   issuer     may create authorizations. The trusted user-facing app.
 *   operator   may resolve reviews and force reconciliation. A human console.
 */
function hasAuthority(
  request: FastifyRequest,
  header: string,
  expected: string | undefined,
): boolean {
  if (expected === undefined) return false;
  const presented = request.headers[header];
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Constant-time, and length-checked first because timingSafeEqual throws on
  // a mismatch — which would itself be a timing signal.
  return a.length === b.length && timingSafeEqual(a, b);
}

function forbidden(reply: FastifyReply, authority: string, why: string): FastifyReply {
  return reply
    .status(403)
    .send({ error: 'FORBIDDEN', message: `${authority} authority required: ${why}` });
}

function principalOf(request: FastifyRequest): { userId: string; sessionId: string } | null {
  const userId = request.headers['x-capturelock-user'];
  const sessionId = request.headers['x-capturelock-session'];
  if (typeof userId !== 'string' || typeof sessionId !== 'string') return null;
  return { userId, sessionId };
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = options.app;
  const server = Fastify({ logger: options.logger ?? false });

  await server.register(cors, { origin: true });

  /**
   * Request correlation.
   *
   * Every log line for a request carries the same id, so a refusal can be
   * traced from the HTTP layer through the kernel to the evidence envelope.
   * Deliberately absent from the log context: headers, credentials, and request
   * bodies — a verification service's logs are read by operators, not by the
   * party being checked, and neither should contain the other's secrets.
   */
  server.addHook('onRequest', async request => {
    request.log = request.log.child({ requestId: request.id });
  });

  // The webhook route needs the exact bytes: the HMAC is computed over the raw
  // body, and re-serializing a parsed object produces different bytes.
  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const raw = body as Buffer;
    (request as FastifyRequest & { rawBody?: Buffer }).rawBody = raw;
    if (raw.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(raw.toString('utf8')) as unknown);
    } catch {
      done(new CaptureLockError('CONFIGURATION_ERROR', 'Malformed JSON body'), undefined);
    }
  });

  /**
   * Global error handler.
   *
   * Never returns 200 for an unhandled error, and never leaks a stack trace: a
   * verification service's error responses are read by the party being checked.
   */
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: 'MALFORMED_REQUEST',
        message: 'Request failed schema validation.',
        issues: error.issues.map(issue => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }
    if (error instanceof CaptureLockError) {
      reply.status(400).send({ error: error.code, message: error.message });
      return;
    }
    request.log.error({ err: error }, 'unhandled error');
    reply
      .status(500)
      .send({ error: 'INTERNAL_ERROR', message: 'The request could not be completed.' });
  });

  // ---------------------------------------------------------------- status --
  server.get('/health', async () => ({
    status: 'ok',
    service: 'capturelock-api',
    paymentProvider: app.providerName,
    timestamp: new Date().toISOString(),
  }));

  server.get('/', async () => ({
    service: 'capturelock-api',
    description: 'Capture-time payment execution verification for agentic commerce.',
    paymentProvider: app.providerName,
    endpoints: [
      'POST /v1/authorizations',
      'GET  /v1/authorizations/:id',
      'POST /v1/authorizations/:id/quotes',
      'POST /v1/releases',
      'POST /v1/releases/:id/capture',
      'POST /v1/releases/:id/reconcile',
      'GET  /v1/releases/:id',
      'POST /v1/reviews/:id/resolve',
      'POST /v1/webhooks/razorpay',
      'GET  /v1/evidence/:id',
      'GET  /v1/evidence/chain/:id/verify',
      'GET  /v1/evidence/public-key',
    ],
  }));

  // -------------------------------------------------------- authorizations --
  server.post('/v1/authorizations', async (request, reply) => {
    // An authorization is a mandate to spend the user's money. It must
    // originate from a trusted user-facing flow, never from the agent that will
    // spend it — otherwise the agent simply grants itself whatever budget it
    // wants and every check downstream is enforcing a mandate it authored.
    if (!hasAuthority(request, 'x-capturelock-issuer-key', app.config.issuerApiKey)) {
      return forbidden(reply, 'Issuer', 'an authorization must be issued by a trusted application');
    }
    const principal = principalOf(request);
    if (principal === null) return unauthenticated(reply);

    const body = CreateAuthorizationBody.parse(request.body);
    const intent: AuthorizedIntent = {
      rawText: body.rawIntent,
      constraints: body.constraints,
      normalization: body.normalization,
    };

    const result = await app.authorizationService.create({
      // Identity comes from the authenticated principal, never from the body.
      // A body-supplied userId would let the issuer mint mandates for anyone.
      userId: principal.userId as never,
      sessionId: principal.sessionId,
      intent,
      policyId: body.policyId,
      policyVersion: body.policyVersion,
    });

    if (result.kind === 'POLICY_NOT_FOUND') {
      return reply.status(422).send({
        error: 'POLICY_NOT_FOUND',
        message: 'No such policy version; an authorization must be bound to an enforceable policy.',
      });
    }

    return reply.status(201).send({
      authorizationId: result.authorization.authorizationId,
      intentHash: result.authorization.intentHash,
      policyHash: result.authorization.policyHash,
      state: result.authorization.state,
    });
  });

  server.get('/v1/authorizations/:id', async (request, reply) => {
    const { id } = AuthorizationIdParam.parse(request.params);
    const record = await app.deps.authorizations.findById(id);
    if (record === null) return reply.status(404).send({ error: 'NOT_FOUND' });
    return reply.send({
      authorizationId: record.authorizationId,
      state: record.state,
      intentHash: record.intentHash,
      policyHash: record.policyHash,
      constraints: record.intent.constraints,
      rawIntent: record.intent.rawText,
      consumedByReleaseId: record.consumedByReleaseId,
    });
  });

  // ---------------------------------------------------------------- quotes --
  server.post('/v1/authorizations/:id/quotes', async (request, reply) => {
    const principal = principalOf(request);
    if (principal === null) return unauthenticated(reply);
    const { id } = AuthorizationIdParam.parse(request.params);
    const body = CreateQuoteBody.parse(request.body);

    // Quoting is the agent's job, but only against its own mandate.
    const authorization = await app.deps.authorizations.findById(id);
    if (authorization === null) return reply.status(404).send({ error: 'AUTHORIZATION_NOT_FOUND' });
    if (authorization.userId !== principal.userId) {
      return reply.status(403).send({
        error: 'USER_MISMATCH',
        message: 'This authorization belongs to a different principal.',
      });
    }

    const result = await app.quoteService.issue({
      authorizationId: id,
      merchantId: body.merchantId,
      lines: body.lines,
      shipTo: body.shipTo,
      recurring: body.recurring,
    });

    switch (result.kind) {
      case 'ISSUED':
        return reply.status(201).send({
          snapshotId: result.snapshot.snapshotId,
          snapshotHash: result.snapshot.snapshotHash,
          // Every amount here is server-computed from the live merchant read.
          itemSubtotal: result.snapshot.itemSubtotal,
          feeTotal: result.snapshot.feeTotal,
          total: result.snapshot.total,
          observedAt: result.snapshot.observedAt,
          expiresAt: result.snapshot.expiresAt,
          cart: result.snapshot.cart,
        });
      case 'AUTHORIZATION_NOT_FOUND':
        return reply.status(404).send({ error: 'AUTHORIZATION_NOT_FOUND' });
      case 'ITEM_NOT_FOUND':
        return reply.status(422).send({ error: 'LIVE_ITEM_NOT_FOUND', sku: result.sku });
      case 'LIVE_STATE_UNAVAILABLE':
        return reply.status(503).send({
          error: 'LIVE_STATE_UNAVAILABLE',
          message: 'No quote is issued from a merchant we cannot currently read.',
          reason: result.reason,
        });
    }
  });

  // -------------------------------------------------------------- releases --
  // Gate 1. Creates the payable order. No money moves.
  server.post('/v1/releases', async (request, reply) => {
    const principal = principalOf(request);
    if (principal === null) return unauthenticated(reply);
    const body = CreateReleaseBody.parse(request.body);

    return withIdempotency(
      app.idempotency,
      reply,
      {
        key: body.idempotencyKey,
        route: 'POST /v1/releases',
        body,
        principal,
      },
      async () => {
        const outcome = await app.releaseService.requestOrderCreation({
          authorizationId: body.authorizationId,
          snapshotId: body.snapshotId as never,
          idempotencyKey: body.idempotencyKey,
          principal: principal as never,
        });

        request.log.info(
          {
            gate: 'ORDER_CREATION',
            authorizationId: body.authorizationId,
            releaseId: outcome.releaseId,
            verdict: outcome.verdict,
            reasonCodes: outcome.reasonCodes,
            state: outcome.state,
            providerOrderId: outcome.providerOrderId,
            evidenceEnvelopeId: outcome.evidenceEnvelopeId,
          },
          'order gate decided',
        );

        return { statusCode: statusForVerdict(outcome.verdict), body: outcome };
      },
    );
  });

  // Gate 2. THIS is where money moves, and only on an ALLOW.
  server.post('/v1/releases/:id/capture', async (request, reply) => {
    const principal = principalOf(request);
    if (principal === null) return unauthenticated(reply);
    const { id } = ReleaseIdParam.parse(request.params);
    const body = CaptureBody.parse(request.body);

    return withIdempotency(
      app.idempotency,
      reply,
      {
        key: body.idempotencyKey,
        route: 'POST /v1/releases/:id/capture',
        body: { ...body, releaseId: id },
        principal,
      },
      async () => {
        const outcome = await app.releaseService.requestCapture({
          releaseId: id,
          idempotencyKey: body.idempotencyKey,
          principal: principal as never,
        });

        request.log.info(
          {
            gate: 'CAPTURE',
            releaseId: id,
            verdict: outcome.verdict,
            reasonCodes: outcome.reasonCodes,
            state: outcome.state,
            moneyMoved: outcome.moneyMoved,
            providerPaymentId: outcome.providerPaymentId,
            evidenceEnvelopeId: outcome.evidenceEnvelopeId,
          },
          outcome.moneyMoved ? 'capture executed' : 'capture gate refused',
        );

        return { statusCode: statusForVerdict(outcome.verdict), body: outcome };
      },
    );
  });

  server.post('/v1/releases/:id/reconcile', async (request, reply) => {
    // Forcing reconciliation is an operations action. It cannot move money —
    // reconciliation holds a read-only provider — but it can change recorded
    // state, which is not something the party being checked should control.
    if (!hasAuthority(request, 'x-capturelock-operator-key', app.config.operatorApiKey)) {
      return forbidden(reply, 'Operator', 'reconciliation is an operations action');
    }
    const { id } = ReleaseIdParam.parse(request.params);
    const result = await app.reconciliationService.reconcileById(id);
    if (result === null) return reply.status(404).send({ error: 'NOT_FOUND' });
    return reply.send(result);
  });

  server.get('/v1/releases/:id', async (request, reply) => {
    const { id } = ReleaseIdParam.parse(request.params);
    const release = await app.deps.releases.findById(id);
    if (release === null) return reply.status(404).send({ error: 'NOT_FOUND' });
    const evaluations = await app.deps.evaluations.listByRelease(id);
    return reply.send({
      release,
      evaluations: evaluations.map(e => ({
        evaluationId: e.evaluationId,
        gate: e.gate,
        verdict: e.decision.verdict,
        reasonCodes: e.decision.reasonCodes,
        decisionHash: e.decisionHash,
        evaluatedAt: e.evaluatedAt,
      })),
    });
  });

  // --------------------------------------------------------------- reviews --
  server.post('/v1/reviews/:id/resolve', async (request, reply) => {
    // A PAUSE exists so a human looks. An agent able to resolve its own paused
    // release would make PAUSE indistinguishable from ALLOW.
    if (!hasAuthority(request, 'x-capturelock-operator-key', app.config.operatorApiKey)) {
      return forbidden(reply, 'Operator', 'only an operator may resolve a paused release');
    }
    const operator = request.headers['x-capturelock-operator'];
    if (typeof operator !== 'string' || operator.length === 0) {
      return reply.status(400).send({
        error: 'MALFORMED_REQUEST',
        message: 'x-capturelock-operator is required so the resolution is attributable.',
      });
    }

    const { id } = ReviewIdParam.parse(request.params);
    const body = ResolveReviewBody.parse(request.body);
    // Attribution comes from the authenticated header, not the body: a
    // self-declared approver name is not attribution.
    const result = await app.reviewService.resolve(id, body.resolution, operator);
    request.log.warn(
      { reviewId: id, resolution: body.resolution, resolvedBy: operator, disposition: result.kind },
      'paused release resolved by an operator',
    );
    if (result.kind === 'NOT_FOUND') return reply.status(404).send({ error: 'NOT_FOUND' });
    if (result.kind === 'ALREADY_RESOLVED') {
      return reply.status(409).send({ error: 'ALREADY_RESOLVED' });
    }
    return reply.send(result);
  });

  // -------------------------------------------------------------- webhooks --
  server.post('/v1/webhooks/razorpay', async (request, reply) => {
    const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
    const signature = request.headers[RAZORPAY_SIGNATURE_HEADER];

    if (app.webhookVerifier === null) {
      return reply.status(503).send({ error: 'WEBHOOKS_NOT_CONFIGURED' });
    }
    if (raw === undefined || typeof signature !== 'string') {
      return reply.status(400).send({ error: 'MALFORMED_REQUEST' });
    }

    // Signature is checked against the raw bytes BEFORE the payload is trusted
    // for anything.
    const verification = app.webhookVerifier.verify(raw, signature, {
      [RAZORPAY_EVENT_ID_HEADER]: String(request.headers[RAZORPAY_EVENT_ID_HEADER] ?? ''),
    });

    if (!verification.valid || verification.eventId === null) {
      // 401 rather than 400: an unverified sender learns only that it failed.
      return reply.status(401).send({ error: 'SIGNATURE_INVALID' });
    }

    const payload = request.body as Record<string, unknown> | undefined;
    const entity = readPaymentEntity(payload);

    const result = await app.webhookService.ingest({
      providerEventId: verification.eventId,
      eventType: verification.eventType ?? 'unknown',
      signatureValid: true,
      payload: payload ?? null,
      providerEventAt: null,
      paymentId: entity.paymentId,
      orderId: entity.orderId,
    });

    request.log.info(
      {
        providerEventId: verification.eventId,
        eventType: verification.eventType,
        disposition: result.kind,
      },
      'webhook processed',
    );

    // Always 200 for a verified event, including duplicates: the provider
    // retries anything else, and a duplicate is the expected steady state under
    // at-least-once delivery.
    return reply.status(200).send(result);
  });

  // -------------------------------------------------------------- evidence --
  server.get('/v1/evidence/public-key', async () => ({
    algorithm: 'Ed25519',
    format: 'spki-der-base64',
    publicKey: app.evidencePublicKey,
    publicKeyId: app.evidenceVerifier.publicKeyId,
  }));

  server.get('/v1/evidence/chain/:id/verify', async (request, reply) => {
    const { id } = AuthorizationIdParam.parse(request.params);
    const result = await app.deps.evidence.verifyChain(id);
    return reply.send(result);
  });

  server.get('/v1/evidence/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const envelope = await app.deps.evidence.findById(id);
    if (envelope === null) return reply.status(404).send({ error: 'NOT_FOUND' });

    // Replay: re-run the kernel over the stored context and report whether the
    // recorded decision reproduces. This is what makes the record a proof
    // rather than a claim.
    let replay: { reproduced: boolean; decisionHash: string | null } = {
      reproduced: false,
      decisionHash: null,
    };
    const body = envelope.body as { context?: unknown; decisionHash?: string } | null;
    if (body?.context !== undefined && typeof body.decisionHash === 'string') {
      try {
        const recomputed = computeDecisionHash(evaluate(deserializeContext(body.context)));
        replay = { reproduced: recomputed === body.decisionHash, decisionHash: recomputed };
      } catch {
        replay = { reproduced: false, decisionHash: null };
      }
    }

    return reply.send({ envelope, replay });
  });

  // Registered last so a development helper can never shadow a real route.
  registerDevRoutes(server, app);

  return server;
}

function unauthenticated(reply: FastifyReply): FastifyReply {
  return reply.status(401).send({
    error: 'UNAUTHENTICATED',
    message: 'x-capturelock-user and x-capturelock-session headers are required.',
  });
}

/**
 * PAUSE is 202 rather than 200: the request was accepted for review, and the
 * caller must not read it as an approval.
 */
function statusForVerdict(verdict: string): number {
  if (verdict === 'ALLOW') return 200;
  if (verdict === 'PAUSE') return 202;
  return 422;
}

function readPaymentEntity(payload: Record<string, unknown> | undefined): {
  paymentId: string | null;
  orderId: string | null;
} {
  const container = payload?.['payload'] as Record<string, unknown> | undefined;
  const payment = (container?.['payment'] as Record<string, unknown> | undefined)?.['entity'] as
    Record<string, unknown> | undefined;
  return {
    paymentId: typeof payment?.['id'] === 'string' ? payment['id'] : null,
    orderId: typeof payment?.['order_id'] === 'string' ? payment['order_id'] : null,
  };
}

export { asAuthorizationId, asReleaseId, asReviewId };
