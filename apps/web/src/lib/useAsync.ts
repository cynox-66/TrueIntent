/**
 * Loading one thing from the API.
 *
 * A deliberately small replacement for a data-fetching library. It exists to
 * enforce three properties the console cannot be correct without:
 *
 *  - **Four explicit states.** `idle | loading | ready | failed`, never a
 *    "data is undefined so it must still be loading" inference. An error must
 *    be able to render as an error rather than as an empty screen.
 *  - **Stale responses are discarded.** Every run gets an `AbortController` and
 *    the previous one is aborted, so a slow first request cannot land after a
 *    fast second and repaint the screen with older state. On a payment console
 *    that would mean showing a release as still paused after it was resolved.
 *  - **Refresh is explicit.** `reload` re-runs on demand; there is no polling,
 *    so the console cannot generate request storms and what is on screen is
 *    always something the operator asked for.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type AsyncState<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'failed'; readonly error: unknown };

export interface AsyncResult<T> {
  readonly state: AsyncState<T>;
  readonly reload: () => void;
  /** True while a refresh runs over data already on screen. */
  readonly refreshing: boolean;
}

export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  enabled = true,
): AsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'idle' });
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);
  const inFlight = useRef<AbortController | null>(null);
  // Read inside the effect only, so a changing callback identity does not
  // re-trigger the fetch; `deps` is what decides that.
  const loadRef = useRef(load);
  loadRef.current = load;
  const hasData = state.status === 'ready';

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle' });
      return;
    }

    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    // A refresh keeps the previous data visible; a first load shows a skeleton.
    if (hasData) setRefreshing(true);
    else setState({ status: 'loading' });

    void (async () => {
      try {
        const data = await loadRef.current(controller.signal);
        if (controller.signal.aborted) return;
        setState({ status: 'ready', data });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ status: 'failed', error });
      } finally {
        if (!controller.signal.aborted) setRefreshing(false);
      }
    })();

    return () => controller.abort();
    // `hasData` is intentionally excluded: including it would re-run the fetch
    // the moment data arrives, which is an infinite loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  const reload = useCallback(() => setNonce(n => n + 1), []);

  return { state, reload, refreshing };
}
