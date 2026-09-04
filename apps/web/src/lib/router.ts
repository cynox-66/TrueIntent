/**
 * A hash router, in about eighty lines.
 *
 * There are two surfaces here and they have different audiences. The agent
 * routes are the buyer's: a person delegating a budget and watching what
 * happens to it. The operator routes are the control surface behind that, and
 * they require an operator credential. A routing library would be more code to
 * read than this is, and hash routing means the static build works from any
 * path without server rewrites.
 *
 * Ids appear in the hash, which is deliberate and safe: session, release and
 * authorization ids are already visible on screen and in the API's URLs. No
 * credential ever goes here — see the note in `OperatorSession`.
 */

import { useEffect, useState } from 'react';

export type Route =
  // ---- buyer-facing ----------------------------------------------------
  /** Start: express an intent and delegate a bounded session. */
  | { readonly name: 'agent' }
  /** Live: what the agent is doing, and what CaptureLock made of it. */
  | { readonly name: 'agent-session'; readonly sessionId: string }
  // ---- operator-facing -------------------------------------------------
  | { readonly name: 'queue' }
  | { readonly name: 'release'; readonly releaseId: string }
  | { readonly name: 'evidence'; readonly chainId: string };

/** Routes that require an operator credential. */
export function isOperatorRoute(route: Route): boolean {
  return route.name === 'queue' || route.name === 'release' || route.name === 'evidence';
}

export function parseRoute(hash: string): Route {
  // The query selects a narrative, not a resource, so it is stripped before the
  // path is read. Leaving it on made the session id `sess_…?s=drift`, which the
  // API correctly refused as a malformed identifier.
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const [head, tail] = path.split('/');

  if (head === 'agent') {
    return tail !== undefined && tail.length > 0
      ? { name: 'agent-session', sessionId: decodeURIComponent(tail) }
      : { name: 'agent' };
  }
  if (head === 'release' && tail !== undefined && tail.length > 0) {
    return { name: 'release', releaseId: decodeURIComponent(tail) };
  }
  if (head === 'evidence' && tail !== undefined && tail.length > 0) {
    return { name: 'evidence', chainId: decodeURIComponent(tail) };
  }
  if (head === 'operator') return { name: 'queue' };

  // The buyer experience is the default, because it is the one that explains
  // what this system is for. The operator console is reachable from it.
  return { name: 'agent' };
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'agent':
      return '#/agent';
    case 'agent-session':
      return `#/agent/${encodeURIComponent(route.sessionId)}`;
    case 'release':
      return `#/release/${encodeURIComponent(route.releaseId)}`;
    case 'evidence':
      return `#/evidence/${encodeURIComponent(route.chainId)}`;
    case 'queue':
      return '#/operator';
  }
}

export function navigate(route: Route): void {
  window.location.hash = hrefFor(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseRoute(window.location.hash));
      // A route change is a new screen; starting it scrolled halfway down is
      // disorienting when the previous screen was long.
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
