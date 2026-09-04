/**
 * The API client.
 *
 * Most of these assert a *refusal* or a *shape*, not a happy path: the client's
 * job is to make failures loud and to keep the operator credential out of
 * everything except the two headers that need it.
 */

import { describe, it, expect, vi } from 'vitest';
import { ApiError, NetworkError, api } from '../src/api/client.js';

const OPERATOR = { name: 'operator_dev', key: 'super-secret-operator-key' };

function stubFetch(response: {
  status?: number;
  body?: unknown;
  text?: string;
}): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => {
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => response.text ?? JSON.stringify(response.body ?? {}),
    } as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('operator authentication', () => {
  it('sends the credential as headers, never in the URL or the body', async () => {
    const spy = stubFetch({ body: { items: [], count: 0, limit: 200 } });
    await api.queue(OPERATOR);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/v1/operator/queue');
    // The key in a URL would reach server logs, browser history and referrers.
    expect(url).not.toContain(OPERATOR.key);
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({
      'x-capturelock-operator-key': OPERATOR.key,
      'x-capturelock-operator': OPERATOR.name,
    });
  });

  it('does not attach the credential to reads that do not require it', async () => {
    const spy = stubFetch({ body: { release: {}, evaluations: [] } });
    await api.release('rel_abc');

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('x-capturelock-operator-key');
  });

  it('never puts resolvedBy in the body — attribution is the header', async () => {
    // A body-supplied approver name is a name the browser chose. The server
    // rejects it, and the client must not be the thing that sends it.
    const spy = stubFetch({ body: { kind: 'RESOLVED' } });
    await api.resolveReview('rev_1', 'APPROVED', OPERATOR);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/v1/reviews/rev_1/resolve');
    expect(JSON.parse(String(init.body))).toEqual({ resolution: 'APPROVED' });
    expect(init.headers).toMatchObject({ 'x-capturelock-operator': OPERATOR.name });
  });

  it('encodes identifiers into the path', async () => {
    const spy = stubFetch({ body: {} });
    await api.release('rel/../../etc');
    expect(spy.mock.calls[0]?.[0]).toBe('/v1/releases/rel%2F..%2F..%2Fetc');
  });
});

describe('failures never look like successes', () => {
  it('throws ApiError carrying the server error envelope', async () => {
    stubFetch({
      status: 403,
      body: { error: 'FORBIDDEN', message: 'Operator authority required' },
    });

    await expect(api.queue(OPERATOR)).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'FORBIDDEN',
    });
  });

  it('classifies 401 and 403 as auth failures and 404 as not-found', async () => {
    for (const status of [401, 403]) {
      stubFetch({ status, body: { error: 'X' } });
      const error = await api.queue(OPERATOR).catch((e: unknown) => e);
      expect((error as ApiError).isAuthFailure).toBe(true);
    }
    stubFetch({ status: 404, body: { error: 'NOT_FOUND' } });
    const notFound = await api.release('rel_missing').catch((e: unknown) => e);
    expect((notFound as ApiError).isNotFound).toBe(true);
  });

  it('treats an unparseable body as an error rather than as empty data', async () => {
    // Returning `{}` here would render an empty release as though it were real.
    stubFetch({ status: 200, text: '<html>gateway</html>' });
    await expect(api.release('rel_1')).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('reports a transport failure as a NetworkError, not as a refusal', async () => {
    // The distinction matters: "the API is down" and "the API said no" call for
    // different operator responses.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(api.queue(OPERATOR)).rejects.toBeInstanceOf(NetworkError);
  });

  it('does not leak the operator key into an error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const error = await api.queue(OPERATOR).catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain(OPERATOR.key);
  });

  it('lets an abort propagate instead of reporting it as a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    await expect(api.queue(OPERATOR)).rejects.toBeInstanceOf(DOMException);
  });
});
