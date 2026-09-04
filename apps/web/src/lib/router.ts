/**
 * A hash router, in about forty lines.
 *
 * The console has three routes. A routing library would be more code to read
 * than this is, and hash routing means the static build works from any path
 * without server rewrites.
 *
 * Ids appear in the hash, which is deliberate and safe: release and
 * authorization ids are already visible on screen and in the API's URLs. The
 * operator credential never goes here — see the note in `OperatorSession`.
 */

import { useEffect, useState } from 'react';

export type Route =
  | { readonly name: 'queue' }
  | { readonly name: 'release'; readonly releaseId: string }
  | { readonly name: 'evidence'; readonly chainId: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [head, tail] = path.split('/');
  if (head === 'release' && tail !== undefined && tail.length > 0) {
    return { name: 'release', releaseId: decodeURIComponent(tail) };
  }
  if (head === 'evidence' && tail !== undefined && tail.length > 0) {
    return { name: 'evidence', chainId: decodeURIComponent(tail) };
  }
  return { name: 'queue' };
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'release':
      return `#/release/${encodeURIComponent(route.releaseId)}`;
    case 'evidence':
      return `#/evidence/${encodeURIComponent(route.chainId)}`;
    case 'queue':
      return '#/';
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
