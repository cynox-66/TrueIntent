/**
 * The API client.
 *
 * Two rules shape this file.
 *
 * **The operator credential never leaves memory.** It is passed in per call
 * from the session held in a React ref — never read from storage, never written
 * to storage, never placed in a URL, never logged, and never included in an
 * error. `ApiError` carries the status and the server's message; it does not
 * carry the request headers, because errors get printed, copied into issues and
 * pasted into chats.
 *
 * **A failure never looks like a success.** Every non-2xx becomes a thrown
 * `ApiError` with a status, and an unparseable body is itself an error rather
 * than an empty object. In a payment console the dangerous failure mode is a
 * request that quietly did nothing while the screen says it worked.
 */

import type {
  AgentContextResponse,
  AgentRunResponse,
  AgentSessionView,
  AgentTimelineResponse,
  AuthorizationView,
  CreateSessionRequest,
  DemoSessionResponse,
  EvaluationSummary,
  PurchaseOutcomeResponse,
  PurchaseRequestBody,
  ChainVerificationResponse,
  EvidenceDetailResponse,
  EvidenceTimelineResponse,
  HealthResponse,
  OperatorQueueResponse,
  ReconciliationResponse,
  ReleaseDetailResponse,
  ReviewResolution,
  ReviewResolutionResponse,
} from './types.js';

/** The operator's credential, held only for the lifetime of the page. */
export interface OperatorCredential {
  /** Sent as `x-capturelock-operator-key`. Never rendered back to the user. */
  readonly key: string;
  /** Sent as `x-capturelock-operator`; the server uses it for attribution. */
  readonly name: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * The parsed response body, when there was one.
     *
     * Kept because a refusal is not an empty failure: a 422 from a gate carries
     * the reason codes that explain it, and discarding them left the UI able to
     * say only "the API returned 422" about the most interesting thing the
     * system does.
     */
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the server refused the credential rather than the request. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

/** A transport failure. Distinct from a refusal: the API may not be running. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * The acting user and the session being spent.
 *
 * An agent holds this and nothing else. The session id must be the session the
 * request is against — the server refuses a mismatch, which is how a mandate
 * stays bound to the delegation that produced it.
 */
export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly operator?: OperatorCredential;
  readonly principal?: Principal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.operator !== undefined) {
    headers['x-capturelock-operator-key'] = options.operator.key;
    headers['x-capturelock-operator'] = options.operator.name;
  }
  if (options.principal !== undefined) {
    headers['x-capturelock-user'] = options.principal.userId;
    headers['x-capturelock-session'] = options.principal.sessionId;
  }
  for (const [key, value] of Object.entries(options.headers ?? {})) headers[key] = value;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    // Deliberately does not echo the request: a network error message can end
    // up in a screenshot.
    throw new NetworkError('Could not reach the CaptureLock API.');
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError(
        response.status,
        'MALFORMED_RESPONSE',
        'The API returned a body that is not JSON.',
      );
    }
  }

  if (!response.ok) {
    const envelope = (parsed ?? {}) as { error?: string; message?: string };
    throw new ApiError(
      response.status,
      envelope.error ?? 'UNKNOWN_ERROR',
      envelope.message ?? `The API returned ${String(response.status)}.`,
      parsed,
    );
  }

  return parsed as T;
}

/**
 * Like `request`, but returns a 422 body instead of throwing.
 *
 * A refusal is the most interesting answer this product gives, and it arrives
 * as a 422 carrying reason codes. Treating it as an exception would push the
 * story into a catch block and make "CaptureLock said no" look like "something
 * broke" — which is exactly the distinction the UI exists to draw. Every other
 * status still throws.
 */
async function requestAllowingRefusal<T>(path: string, options: RequestOptions): Promise<T> {
  try {
    return await request<T>(path, options);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 422 || error.status === 202)) {
      // The body is the answer, reason codes and all. The envelope fields are
      // filled in only where the server did not already provide them.
      const body = (error.body ?? {}) as Record<string, unknown>;
      return { moneyMoved: false, ...body, error: error.code, message: error.message } as T;
    }
    throw error;
  }
}

/**
 * The endpoints this console uses.
 *
 * Every call is a real request to the running API. There is no fixture path and
 * no fallback: if the API is unreachable the console says so rather than
 * rendering something plausible.
 */
export const api = {
  /**
   * Which adapter the API is wired to, among other things.
   *
   * Unauthenticated, because it is the one thing a viewer should be able to
   * establish before trusting anything else on screen.
   */
  health(signal?: AbortSignal): Promise<HealthResponse> {
    return request('/health', { signal });
  },

  /** Operator authority required. Doubles as the credential check at sign-in. */
  queue(operator: OperatorCredential, signal?: AbortSignal): Promise<OperatorQueueResponse> {
    return request('/v1/operator/queue', { operator, signal });
  },

  release(releaseId: string, signal?: AbortSignal): Promise<ReleaseDetailResponse> {
    return request(`/v1/releases/${encodeURIComponent(releaseId)}`, { signal });
  },

  authorization(authorizationId: string, signal?: AbortSignal): Promise<AuthorizationView> {
    return request(`/v1/authorizations/${encodeURIComponent(authorizationId)}`, { signal });
  },

  evidenceChain(chainId: string, signal?: AbortSignal): Promise<EvidenceTimelineResponse> {
    return request(`/v1/evidence/chain/${encodeURIComponent(chainId)}`, { signal });
  },

  /** Replay happens on the server; this only reads the result. */
  evidence(envelopeId: string, signal?: AbortSignal): Promise<EvidenceDetailResponse> {
    return request(`/v1/evidence/${encodeURIComponent(envelopeId)}`, { signal });
  },

  verifyChain(chainId: string, signal?: AbortSignal): Promise<ChainVerificationResponse> {
    return request(`/v1/evidence/chain/${encodeURIComponent(chainId)}/verify`, { signal });
  },

  /**
   * Resolves a paused release.
   *
   * The body carries the resolution and nothing else. Attribution comes from
   * the `x-capturelock-operator` header the server reads — a `resolvedBy` in
   * the body would be a name the browser chose, which is not attribution, and
   * the server rejects it.
   */
  resolveReview(
    reviewId: string,
    resolution: ReviewResolution,
    operator: OperatorCredential,
  ): Promise<ReviewResolutionResponse> {
    return request(`/v1/reviews/${encodeURIComponent(reviewId)}/resolve`, {
      method: 'POST',
      operator,
      body: { resolution },
    });
  },

  // ---- the buyer surface -------------------------------------------------
  // Principal authority: the user's own session, on the screen they are
  // standing in front of. No operator credential is involved.

  /**
   * Starts the demo session.
   *
   * Delegating a budget is issuer authority. Rather than ship an issuer key to
   * a browser — which would hand the agent-facing surface the exact key the
   * architecture exists to keep away from it — this asks a dev-only route to
   * perform the delegation server-side and returns only the principal, which
   * confers nothing an unauthenticated caller could not claim.
   */
  startDemoSession(): Promise<DemoSessionResponse> {
    return request('/v1/dev/demo-session', { method: 'POST' });
  },

  /** The committed evaluation result. Unauthenticated; discloses no user data. */
  evaluationSummary(signal?: AbortSignal): Promise<EvaluationSummary> {
    return request('/v1/evaluation/summary', { signal });
  },

  /** Simulates the payer authorizing at the provider. Dev-only, fake provider. */
  simulatePayerAuthorization(releaseId: string): Promise<unknown> {
    return request('/v1/dev/simulate-authorization', { method: 'POST', body: { releaseId } });
  },

  /**
   * Moves the merchant's world, not CaptureLock's copy of it.
   *
   * This is what makes the drift scenario a real one: the restaurant changes
   * its price, nothing in CaptureLock is touched, and the capture gate finds
   * out on its next live read.
   */
  setCatalogPrice(sku: string, unitPriceMinor: number): Promise<unknown> {
    return request('/v1/dev/catalog', {
      method: 'POST',
      body: { kind: 'SET_PRICE', sku, unitPriceMinor },
    });
  },

  /** Delegates a bounded session. Issuer authority, held by this application. */
  createSession(body: CreateSessionRequest, issuerKey: string): Promise<AgentSessionView> {
    return request('/v1/sessions', {
      method: 'POST',
      body,
      headers: { 'x-capturelock-issuer-key': issuerKey },
    });
  },

  /** Runs the bounded agent. It shops; it does not buy. */
  runAgent(
    sessionId: string,
    body: { merchantId: string; goal: string },
    principal: Principal,
  ): Promise<AgentRunResponse> {
    return request(`/v1/sessions/${encodeURIComponent(sessionId)}/agent`, {
      method: 'POST',
      body,
      principal,
    });
  },

  /**
   * Asks CaptureLock to verify a purchase.
   *
   * Note what the body cannot carry: no amount, no currency, no total, no
   * verdict. The server derives every one of those. A 422 here is a refusal,
   * not a transport failure, so it is returned rather than thrown.
   */
  requestPurchase(
    sessionId: string,
    body: PurchaseRequestBody,
    principal: Principal,
  ): Promise<PurchaseOutcomeResponse> {
    return requestAllowingRefusal(`/v1/sessions/${encodeURIComponent(sessionId)}/purchase`, {
      method: 'POST',
      body,
      principal,
    });
  },

  requestCapture(
    sessionId: string,
    body: { authorizationId: string; idempotencyKey: string },
    principal: Principal,
  ): Promise<PurchaseOutcomeResponse> {
    return requestAllowingRefusal(`/v1/sessions/${encodeURIComponent(sessionId)}/capture`, {
      method: 'POST',
      body,
      principal,
    });
  },

  /** The whole story of a session, assembled server-side. */
  timeline(
    sessionId: string,
    principal: Principal,
    signal?: AbortSignal,
  ): Promise<AgentTimelineResponse> {
    return request(`/v1/sessions/${encodeURIComponent(sessionId)}/timeline`, {
      principal,
      signal,
    });
  },

  /**
   * The agentic context behind a release, if it has one.
   *
   * Operator authority, because it discloses the user's stated intent and the
   * agent's reasoning about it — which is more than the rest of this console
   * shows about any single release.
   */
  agentContext(
    releaseId: string,
    operator: OperatorCredential,
    signal?: AbortSignal,
  ): Promise<AgentContextResponse> {
    return request(`/v1/releases/${encodeURIComponent(releaseId)}/agent-context`, {
      operator,
      signal,
    });
  },

  reconcile(releaseId: string, operator: OperatorCredential): Promise<ReconciliationResponse> {
    return request(`/v1/releases/${encodeURIComponent(releaseId)}/reconcile`, {
      method: 'POST',
      operator,
    });
  },
};
