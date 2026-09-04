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
  AuthorizationView,
  ChainVerificationResponse,
  EvidenceDetailResponse,
  EvidenceTimelineResponse,
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

interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly operator?: OperatorCredential;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.operator !== undefined) {
    headers['x-capturelock-operator-key'] = options.operator.key;
    headers['x-capturelock-operator'] = options.operator.name;
  }
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
    );
  }

  return parsed as T;
}

/**
 * The endpoints this console uses.
 *
 * Every call is a real request to the running API. There is no fixture path and
 * no fallback: if the API is unreachable the console says so rather than
 * rendering something plausible.
 */
export const api = {
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

  reconcile(releaseId: string, operator: OperatorCredential): Promise<ReconciliationResponse> {
    return request(`/v1/releases/${encodeURIComponent(releaseId)}/reconcile`, {
      method: 'POST',
      operator,
    });
  },
};
