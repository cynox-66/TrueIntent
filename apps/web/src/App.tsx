/**
 * The shell.
 *
 * Two surfaces with different audiences, and the gate between them is the point
 * of this file. The agent routes are the buyer's: a person delegating a budget
 * and watching what happens to it, holding no credential at all. The operator
 * routes are the control surface behind that, and they require an operator key.
 *
 * Putting the buyer experience behind the operator sign-in would have been one
 * line shorter and would have said something false about who this is for.
 */

import type { ReactNode } from 'react';
import { OperatorSessionProvider, useOperatorSession } from './session/OperatorSession.js';
import { isOperatorRoute, useRoute, hrefFor, navigate, type Route } from './lib/router.js';
import { useAsync } from './lib/useAsync.js';
import { api } from './api/client.js';
import type { HealthResponse } from './api/types.js';
import { SignIn } from './views/SignIn.js';
import { Queue } from './views/Queue.js';
import { ReleaseDetail } from './views/ReleaseDetail.js';
import { Evidence } from './views/Evidence.js';
import { AgentStart, type ScenarioId } from './views/AgentStart.js';
import { AgentSession } from './views/AgentSession.js';

export function App(): ReactNode {
  return (
    <OperatorSessionProvider>
      <Shell />
    </OperatorSessionProvider>
  );
}

function Shell(): ReactNode {
  const { operator, signIn, signOut } = useOperatorSession();
  const route = useRoute();
  const operatorSurface = isOperatorRoute(route);

  return (
    <div className="shell">
      <header className="topbar">
        <a
          className="brand"
          href={hrefFor({ name: 'agent' })}
          onClick={event => {
            event.preventDefault();
            navigate({ name: 'agent' });
          }}
        >
          <span className="brand-mark">◆</span>
          <span>CaptureLock</span>
          <span className="brand-sub">
            {operatorSurface ? 'Operator Console' : 'Agentic Commerce'}
          </span>
        </a>
        <div className="topbar-spacer" />
        <ProviderBadge />
        {operatorSurface && operator !== null && (
          <>
            <span className="operator-chip">
              <span className="glyph" aria-hidden="true">
                ●
              </span>
              Acting as <strong>{operator.name}</strong>
            </span>
            <button type="button" className="btn btn-quiet btn-sm" onClick={signOut}>
              Sign out
            </button>
          </>
        )}
      </header>

      <main className="main">
        <Screen route={route} operator={operator} onSignedIn={signIn} />
      </main>
    </div>
  );
}

function Screen({
  route,
  operator,
  onSignedIn,
}: {
  route: Route;
  operator: { name: string; key: string } | null;
  onSignedIn: (credential: { name: string; key: string }) => void;
}): ReactNode {
  // The buyer surface, which needs no credential.
  if (route.name === 'agent') return <AgentStart />;
  if (route.name === 'agent-session') {
    return <AgentSession sessionId={route.sessionId} scenario={scenarioFromHash()} />;
  }

  // Everything below here is operator authority.
  if (operator === null) return <SignIn onSignedIn={onSignedIn} />;
  if (route.name === 'release')
    return <ReleaseDetail releaseId={route.releaseId} operator={operator} />;
  if (route.name === 'evidence') return <Evidence chainId={route.chainId} />;
  return <Queue operator={operator} />;
}

/**
 * Which scenario the session screen should run.
 *
 * Carried in the hash query rather than in the path, so it stays out of the
 * route union — it selects a narrative, not a resource, and a stale or absent
 * value falls back to the one that ends in a capture.
 */
function scenarioFromHash(): ScenarioId {
  const query = window.location.hash.split('?')[1] ?? '';
  const value = new URLSearchParams(query).get('s');
  return value === 'drift' || value === 'overreach' ? value : 'happy';
}

/**
 * Which payment adapter is actually wired, stated on every screen.
 *
 * The default adapter is a deterministic fake, and a fake run looks exactly
 * like a real one in every other part of this UI — same states, same evidence,
 * same refusals. Someone watching a demonstration cannot be expected to infer
 * which they are seeing, and letting them assume the stronger reading would be
 * the most consequential thing this interface could get wrong. So the answer is
 * on screen, taken from `/health` on the running API rather than from build
 * configuration, and the fake is the one that gets the louder treatment.
 *
 * A failed or pending read says so instead of guessing. "We could not establish
 * which provider is wired" is a true statement; picking a default would not be.
 */
function ProviderBadge(): ReactNode {
  const { state } = useAsync<HealthResponse>(signal => api.health(signal), []);

  if (state.status !== 'ready') {
    return (
      <span className="provider-badge is-unknown" title="Reading /health from the API">
        <span className="glyph" aria-hidden="true">
          ?
        </span>
        provider unknown
      </span>
    );
  }

  const provider = state.data.paymentProvider;
  const isFake = provider === 'fake';
  return (
    <span
      className={`provider-badge ${isFake ? 'is-fake' : 'is-test'}`}
      title={
        isFake
          ? 'The deterministic in-process fake. No request reaches Razorpay; nothing here is a real payment.'
          : `Razorpay TEST MODE (${provider}). Test-mode keys only — a live-mode key is refused at boot.`
      }
    >
      <span className="glyph" aria-hidden="true">
        {isFake ? '◇' : '◆'}
      </span>
      {isFake ? 'SIMULATED PROVIDER' : 'RAZORPAY TEST MODE'}
    </span>
  );
}
