/**
 * The console's behaviour.
 *
 * These assert what an operator would see and do, against stubbed API
 * responses. The responses are shaped by the same contract types the server is
 * annotated with, so a fixture that drifts from the real API is a type error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type {
  EvidenceEnvelope,
  EvidenceTimelineResponse,
  OperatorQueueItem,
  OperatorQueueResponse,
  ReleaseDetailResponse,
  ReleaseState,
  Timestamp,
} from '../src/api/types.js';
import { Queue } from '../src/views/Queue.js';
import { ReleaseDetail } from '../src/views/ReleaseDetail.js';
import { Evidence } from '../src/views/Evidence.js';
import { SignIn } from '../src/views/SignIn.js';

const OPERATOR = { name: 'operator_dev', key: 'k-operator' };

/**
 * Timestamps and states are branded in the domain, so a fixture has to assert
 * the brand. Doing it in one helper keeps the casts out of the test bodies and
 * out of production code, where the brands do their job.
 */
const ts = (iso: string): Timestamp => iso as unknown as Timestamp;
/** Same reason as `ts`: chain hashes are branded `Sha256Hex`. */
const sha = (value: string): EvidenceEnvelope['chainHash'] =>
  value as unknown as EvidenceEnvelope['chainHash'];
const AT = ts('2026-09-04T05:00:00.000Z');

/** Routes stubbed fetches by URL, so one test can serve several endpoints. */
function route(handlers: Record<string, { status?: number; body?: unknown }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const match = Object.keys(handlers).find(key => url.startsWith(key));
      if (match === undefined) {
        return { ok: false, status: 404, text: async () => '{"error":"NOT_FOUND"}' } as Response;
      }
      const handler = handlers[match]!;
      const status = handler.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(handler.body ?? {}),
      } as Response;
    }),
  );
}

function pausedItem(overrides: Partial<OperatorQueueItem> = {}): OperatorQueueItem {
  return {
    releaseId: 'rel_paused',
    authorizationId: 'auth_1',
    state: 'PAUSED',
    waitingOn: 'REVIEW',
    amount: { currency: 'INR', amountMinor: 494_900 },
    reasonCodes: ['TOTAL_EXCEEDS_LIMIT'],
    attemptCount: 1,
    providerOrderId: null,
    providerPaymentId: null,
    inFlightSince: null,
    createdAt: AT,
    updatedAt: AT,
    review: {
      reviewId: 'rev_paused',
      state: 'OPEN',
      reasonCodes: ['TOTAL_EXCEEDS_LIMIT'],
      createdAt: AT,
    },
    ...overrides,
  };
}

function queueBody(items: OperatorQueueItem[]): OperatorQueueResponse {
  return { items, count: items.length, limit: 200 };
}

function releaseBody(state: ReleaseState): ReleaseDetailResponse {
  return {
    release: {
      releaseId: 'rel_paused',
      authorizationId: 'auth_1',
      snapshotId: 'snap_1',
      state,
      amount: { currency: 'INR', amountMinor: 494_900 },
      receipt: 'cl_receipt',
      providerOrderId: null,
      providerPaymentId: null,
      attemptCount: 1,
      inFlightSince: null,
      lastReasonCodes: ['TOTAL_EXCEEDS_LIMIT'],
      createdAt: AT,
      updatedAt: AT,
    },
    evaluations: [
      {
        evaluationId: 'eval_1',
        gate: 'ORDER_CREATION',
        verdict: 'PAUSE',
        reasonCodes: ['TOTAL_EXCEEDS_LIMIT'],
        decisionHash: 'a'.repeat(64),
        evaluatedAt: AT,
      },
    ],
  };
}

const AUTHORIZATION = {
  authorizationId: 'auth_1',
  state: 'ACTIVE',
  intentHash: 'b'.repeat(64),
  policyHash: 'c'.repeat(64),
  constraints: {},
  rawIntent: 'Find me black running shoes',
  consumedByReleaseId: null,
};

beforeEach(() => {
  window.location.hash = '';
});

describe('sign-in', () => {
  it('verifies the credential against the API before admitting the operator', async () => {
    route({ '/v1/operator/queue': { status: 403, body: { error: 'FORBIDDEN' } } });
    const onSignedIn = vi.fn();
    render(<SignIn onSignedIn={onSignedIn} />);

    await userEvent.type(screen.getByLabelText(/operator identity/i), 'operator_dev');
    await userEvent.type(screen.getByLabelText(/operator key/i), 'wrong-key');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/operator authority refused/i)).toBeInTheDocument();
    // A rejected credential must not produce a signed-in console.
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('admits the operator when the API accepts the credential', async () => {
    route({ '/v1/operator/queue': { body: queueBody([]) } });
    const onSignedIn = vi.fn();
    render(<SignIn onSignedIn={onSignedIn} />);

    await userEvent.type(screen.getByLabelText(/operator identity/i), 'operator_dev');
    await userEvent.type(screen.getByLabelText(/operator key/i), 'right-key');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() =>
      expect(onSignedIn).toHaveBeenCalledWith({ name: 'operator_dev', key: 'right-key' }),
    );
  });

  it('masks the key input', async () => {
    route({ '/v1/operator/queue': { body: queueBody([]) } });
    render(<SignIn onSignedIn={vi.fn()} />);
    expect(screen.getByLabelText(/operator key/i)).toHaveAttribute('type', 'password');
  });
});

describe('the queue', () => {
  it('explains a paused release with the kernel’s own reason description', async () => {
    route({ '/v1/operator/queue': { body: queueBody([pausedItem()]) } });
    render(<Queue operator={OPERATOR} />);

    expect(await screen.findByText(/review required/i)).toBeInTheDocument();
    // The raw code and the kernel's description, never one without the other.
    expect(screen.getByText('TOTAL_EXCEEDS_LIMIT')).toBeInTheDocument();
    expect(screen.getByText(/cart total exceeds the policy ceiling/i)).toBeInTheDocument();
    expect(screen.getByText('₹4,949.00')).toBeInTheDocument();
  });

  it('distinguishes reconciliation from review by wording, not only colour', async () => {
    route({
      '/v1/operator/queue': {
        body: queueBody([
          pausedItem({
            releaseId: 'rel_stuck',
            state: 'CAPTURE_INDETERMINATE',
            waitingOn: 'RECONCILIATION',
            review: null,
          }),
        ]),
      },
    });
    render(<Queue operator={OPERATOR} />);

    expect(await screen.findByText(/reconciliation required/i)).toBeInTheDocument();
    expect(screen.queryByText(/review required/i)).not.toBeInTheDocument();
    expect(screen.getByText(/may or may not have taken effect/i)).toBeInTheDocument();
  });

  it('renders items in the order the API returned them', async () => {
    // The backend orders longest-waiting first with a total tiebreak; re-sorting
    // here would either duplicate that rule or contradict it.
    route({
      '/v1/operator/queue': {
        body: queueBody([
          pausedItem({ releaseId: 'rel_oldest', authorizationId: 'auth_a' }),
          pausedItem({ releaseId: 'rel_newer', authorizationId: 'auth_b' }),
        ]),
      },
    });
    render(<Queue operator={OPERATOR} />);

    // Asserted through the navigation links rather than list items: reason
    // codes are a nested list, so `listitem` would match those too.
    const links = await screen.findAllByRole('link', { name: /open release/i });
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      '#/release/rel_oldest',
      '#/release/rel_newer',
    ]);
  });

  it('says the queue is empty rather than showing a blank page', async () => {
    route({ '/v1/operator/queue': { body: queueBody([]) } });
    render(<Queue operator={OPERATOR} />);
    expect(await screen.findByText(/nothing is waiting/i)).toBeInTheDocument();
  });

  it('surfaces an unreachable API as an error, not as an empty queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    render(<Queue operator={OPERATOR} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/api is unreachable/i);
    expect(screen.queryByText(/nothing is waiting/i)).not.toBeInTheDocument();
  });
});

describe('release detail', () => {
  it('offers review resolution only for a paused release', async () => {
    route({
      '/v1/releases/rel_paused': { body: releaseBody('PAUSED') },
      '/v1/authorizations/auth_1': { body: AUTHORIZATION },
      '/v1/operator/queue': { body: queueBody([pausedItem()]) },
    });
    render(<ReleaseDetail releaseId="rel_paused" operator={OPERATOR} />);

    expect(await screen.findByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reconcile now/i })).not.toBeInTheDocument();
  });

  it('offers reconciliation only for an indeterminate release', async () => {
    route({
      '/v1/releases/rel_paused': { body: releaseBody('CAPTURE_INDETERMINATE') },
      '/v1/authorizations/auth_1': { body: AUTHORIZATION },
    });
    render(<ReleaseDetail releaseId="rel_paused" operator={OPERATOR} />);

    expect(await screen.findByRole('button', { name: /reconcile now/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('offers no action at all for a settled release', async () => {
    route({
      '/v1/releases/rel_paused': { body: releaseBody('CAPTURED') },
      '/v1/authorizations/auth_1': { body: AUTHORIZATION },
    });
    render(<ReleaseDetail releaseId="rel_paused" operator={OPERATOR} />);

    expect(await screen.findByText(/nothing to do/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reconcile now/i })).not.toBeInTheDocument();
  });

  it('requires a second explicit confirmation before resolving', async () => {
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      const bodies: Record<string, unknown> = {
        '/v1/releases/rel_paused': releaseBody('PAUSED'),
        '/v1/authorizations/auth_1': AUTHORIZATION,
        '/v1/operator/queue': queueBody([pausedItem()]),
        '/v1/reviews/rev_paused/resolve': { kind: 'RESOLVED' },
      };
      const key = Object.keys(bodies).find(k => url.startsWith(k));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(bodies[key ?? ''] ?? {}),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<ReleaseDetail releaseId="rel_paused" operator={OPERATOR} />);
    await userEvent.click(await screen.findByRole('button', { name: /approve/i }));

    // Arming must not have submitted anything: this is the click that lets
    // money move, and it should not be reachable by one stray press.
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/resolve'))).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: /confirm approved/i }));
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/resolve'))).toBe(true),
    );

    const call = fetchSpy.mock.calls.find(([url]) => String(url).includes('/resolve'));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ resolution: 'APPROVED' });
  });

  it('shows a failed resolution as an error and not as a success', async () => {
    route({
      '/v1/releases/rel_paused': { body: releaseBody('PAUSED') },
      '/v1/authorizations/auth_1': { body: AUTHORIZATION },
      '/v1/operator/queue': { body: queueBody([pausedItem()]) },
      '/v1/reviews/rev_paused/resolve': { status: 409, body: { error: 'ALREADY_RESOLVED' } },
    });
    render(<ReleaseDetail releaseId="rel_paused" operator={OPERATOR} />);

    await userEvent.click(await screen.findByRole('button', { name: /approve/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm approved/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/ALREADY_RESOLVED/);
    expect(screen.queryByText(/resolution recorded/i)).not.toBeInTheDocument();
  });

  it('makes a reconciliation that moved money impossible to miss', async () => {
    route({
      '/v1/releases/rel_paused': { body: releaseBody('CAPTURE_INDETERMINATE') },
      '/v1/authorizations/auth_1': { body: AUTHORIZATION },
      '/v1/releases/rel_paused/reconcile': {
        body: {
          releaseId: 'rel_paused',
          before: 'CAPTURE_INDETERMINATE',
          after: 'CAPTURED',
          moneyMoved: true,
        },
      },
    });
    render(<ReleaseDetail releaseId="rel_paused" operator={OPERATOR} />);

    await userEvent.click(await screen.findByRole('button', { name: /reconcile now/i }));
    expect(await screen.findByText(/money moved/i)).toBeInTheDocument();
  });

  it('states plainly when reconciliation found that no money moved', async () => {
    route({
      '/v1/releases/rel_paused': { body: releaseBody('ORDER_INDETERMINATE') },
      '/v1/authorizations/auth_1': { body: AUTHORIZATION },
      '/v1/releases/rel_paused/reconcile': {
        body: {
          releaseId: 'rel_paused',
          before: 'ORDER_INDETERMINATE',
          after: 'FAILED',
          moneyMoved: false,
        },
      },
    });
    render(<ReleaseDetail releaseId="rel_paused" operator={OPERATOR} />);

    await userEvent.click(await screen.findByRole('button', { name: /reconcile now/i }));
    expect(await screen.findByText(/no money moved/i)).toBeInTheDocument();
  });
});

describe('evidence', () => {
  function timeline(): EvidenceTimelineResponse {
    return {
      chainId: 'auth_1',
      head: { sequence: 1, chainHash: 'h1'.repeat(32) },
      envelopes: [
        {
          envelopeId: 'env_0',
          chainId: 'auth_1',
          sequence: 0,
          prevChainHash: sha('0'.repeat(64)),
          chainHash: sha('h0'.repeat(32)),
          signature: 'sig0',
          publicKeyId: 'key_1',
          recordedAt: AT,
          kind: 'DECISION',
          body: { gate: 'ORDER_CREATION' },
        },
        {
          envelopeId: 'env_1',
          chainId: 'auth_1',
          sequence: 1,
          prevChainHash: sha('h0'.repeat(32)),
          chainHash: sha('h1'.repeat(32)),
          signature: 'sig1',
          publicKeyId: 'key_1',
          recordedAt: ts('2026-09-04T05:01:00.000Z'),
          kind: 'PROVIDER_OUTCOME',
          body: {},
        },
      ],
    };
  }

  it('renders a valid chain as verified', async () => {
    route({
      '/v1/evidence/chain/auth_1/verify': {
        body: { valid: true, defects: [], verifiedCount: 2, headChainHash: 'h1'.repeat(32) },
      },
      '/v1/evidence/chain/auth_1': { body: timeline() },
    });
    render(<Evidence chainId="auth_1" />);

    expect(await screen.findByText(/chain verified/i)).toBeInTheDocument();
  });

  it('raises an invalid chain as a failure and names the defects', async () => {
    route({
      '/v1/evidence/chain/auth_1/verify': {
        body: {
          valid: false,
          defects: ['SEQUENCE_GAP at 1'],
          verifiedCount: 1,
          headChainHash: null,
        },
      },
      '/v1/evidence/chain/auth_1': { body: timeline() },
    });
    render(<Evidence chainId="auth_1" />);

    expect(await screen.findByText(/chain verification failed/i)).toBeInTheDocument();
    expect(screen.getByText('SEQUENCE_GAP at 1')).toBeInTheDocument();
  });

  it('lists envelopes in sequence order', async () => {
    route({
      '/v1/evidence/chain/auth_1/verify': {
        body: { valid: true, defects: [], verifiedCount: 2, headChainHash: 'h1'.repeat(32) },
      },
      '/v1/evidence/chain/auth_1': { body: timeline() },
    });
    render(<Evidence chainId="auth_1" />);

    const entries = await screen.findAllByRole('listitem');
    expect(within(entries[0]!).getByText('DECISION')).toBeInTheDocument();
    expect(within(entries[1]!).getByText('PROVIDER_OUTCOME')).toBeInTheDocument();
    // Sequence numbers are rendered zero-padded, oldest first.
    expect(within(entries[0]!).getByText('00')).toBeInTheDocument();
    expect(within(entries[1]!).getByText('01')).toBeInTheDocument();
  });

  it('reports a reproduced decision when the envelope is expanded', async () => {
    route({
      '/v1/evidence/chain/auth_1/verify': {
        body: { valid: true, defects: [], verifiedCount: 2, headChainHash: 'h1'.repeat(32) },
      },
      '/v1/evidence/chain/auth_1': { body: timeline() },
      '/v1/evidence/env_0': {
        body: {
          envelope: timeline().envelopes[0],
          replay: { reproduced: true, decisionHash: 'd'.repeat(64) },
        },
      },
    });
    render(<Evidence chainId="auth_1" />);

    await userEvent.click((await screen.findAllByRole('button', { expanded: false }))[0]!);
    expect(await screen.findByText(/decision reproduced/i)).toBeInTheDocument();
  });

  it('reports a divergent replay without calling it tampering', async () => {
    // A changed kernel and an undeserializable context look identical from
    // here. Claiming tampering would be a conclusion this screen cannot reach.
    route({
      '/v1/evidence/chain/auth_1/verify': {
        body: { valid: true, defects: [], verifiedCount: 2, headChainHash: 'h1'.repeat(32) },
      },
      '/v1/evidence/chain/auth_1': { body: timeline() },
      '/v1/evidence/env_0': {
        body: {
          envelope: timeline().envelopes[0],
          replay: { reproduced: false, decisionHash: 'e'.repeat(64) },
        },
      },
    });
    render(<Evidence chainId="auth_1" />);

    await userEvent.click((await screen.findAllByRole('button', { expanded: false }))[0]!);
    const banner = await screen.findByText(/decision did not reproduce/i);
    expect(banner).toBeInTheDocument();
    expect(screen.queryByText(/tampering detected/i)).not.toBeInTheDocument();
  });

  it('treats an empty chain as a valid state rather than an error', async () => {
    route({
      '/v1/evidence/chain/auth_1/verify': {
        body: { valid: true, defects: [], verifiedCount: 0, headChainHash: null },
      },
      '/v1/evidence/chain/auth_1': { body: { chainId: 'auth_1', head: null, envelopes: [] } },
    });
    render(<Evidence chainId="auth_1" />);

    expect(await screen.findByText(/no evidence recorded/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('reason codes', () => {
  it('shows an unrecognised code verbatim instead of inventing prose for it', async () => {
    route({
      '/v1/operator/queue': {
        body: queueBody([pausedItem({ reasonCodes: ['NOT_A_REAL_CODE'], review: null })]),
      },
    });
    render(<Queue operator={OPERATOR} />);

    expect(await screen.findByText('NOT_A_REAL_CODE')).toBeInTheDocument();
    expect(screen.getByText(/not in the kernel’s reason vocabulary/i)).toBeInTheDocument();
  });
});

/** Keeps the JSX pragma honest for the type-only import above. */
export type _Unused = ReactNode;
