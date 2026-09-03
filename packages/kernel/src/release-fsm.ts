/**
 * The payment release state machine.
 *
 * Two design points carry most of the weight.
 *
 * **Write-ahead before every provider call.** `ORDER_IN_FLIGHT` and
 * `CAPTURE_IN_FLIGHT` are committed to the database *before* the request goes
 * out, and cleared only after a response comes back. A process that dies in
 * between wakes up in one of those states, which is the honest answer to "we
 * asked the provider to move money and never heard back". Without them the
 * system would either forget the request happened or retry it blindly.
 *
 * **Indeterminate is not failure.** From `*_INDETERMINATE` the only legal moves
 * are reached by *asking the provider what it knows* — never by retrying. This
 * matters concretely for Razorpay: order creation rejects a duplicate receipt
 * rather than returning the existing order, and capture is not idempotent at
 * all, so a blind retry after a lost response is how a payment gets captured
 * twice or wrongly recorded as failed. See ADR-005.
 *
 * Every transition is declared here as data. `nextState` is the only way to
 * compute a destination, so an undeclared transition is impossible to perform
 * rather than merely discouraged.
 */

import {
  CaptureLockError,
  RELEASE_STATES,
  isTerminalReleaseState,
  type ReleaseState,
} from '@capturelock/core';

export const TRANSITION_TRIGGERS = [
  'RELEASE_REQUESTED',
  'VERIFICATION_ALLOWED',
  'VERIFICATION_PAUSED',
  'VERIFICATION_DENIED',
  'ORDER_CALL_STARTED',
  'ORDER_CREATED',
  'ORDER_CALL_INDETERMINATE',
  'ORDER_REJECTED',
  'ORDER_RECONCILED_FOUND',
  'ORDER_RECONCILED_ABSENT',
  'PAYMENT_AUTHORIZED',
  'CAPTURE_REQUESTED',
  'CAPTURE_ALLOWED',
  'CAPTURE_CALL_STARTED',
  'CAPTURE_SUCCEEDED',
  'CAPTURE_CALL_INDETERMINATE',
  'CAPTURE_PROVIDER_REJECTED',
  'CAPTURE_RECONCILED_CAPTURED',
  'CAPTURE_RECONCILED_NOT_CAPTURED',
  'SETTLEMENT_CONFIRMED',
  'PAYMENT_FAILED',
  'REVIEW_APPROVED',
  'REVIEW_REJECTED',
  'ABORT',
] as const;

export type TransitionTrigger = (typeof TRANSITION_TRIGGERS)[number];

export interface TransitionRule {
  readonly trigger: TransitionTrigger;
  readonly from: readonly ReleaseState[];
  readonly to: ReleaseState;
  readonly description: string;
  /**
   * True when the destination means a provider request may already have taken
   * effect. Such a state must be committed before the call, not after.
   */
  readonly writeAhead: boolean;
}

export const TRANSITIONS: readonly TransitionRule[] = Object.freeze([
  {
    trigger: 'RELEASE_REQUESTED',
    from: ['DRAFT'],
    to: 'VERIFYING',
    description: 'An agent asked for a release; verification begins.',
    writeAhead: false,
  },
  {
    trigger: 'VERIFICATION_ALLOWED',
    from: ['VERIFYING'],
    to: 'VERIFIED',
    description: 'The kernel approved order creation.',
    writeAhead: false,
  },
  {
    trigger: 'VERIFICATION_PAUSED',
    from: ['VERIFYING', 'CAPTURE_VERIFYING'],
    to: 'PAUSED',
    description: 'The kernel returned PAUSE at either gate; a human must decide.',
    writeAhead: false,
  },
  {
    trigger: 'VERIFICATION_DENIED',
    from: ['VERIFYING', 'CAPTURE_VERIFYING'],
    to: 'DENIED',
    description: 'The kernel refused at either gate. Terminal: no money moves.',
    writeAhead: false,
  },
  {
    trigger: 'ORDER_CALL_STARTED',
    from: ['VERIFIED'],
    to: 'ORDER_IN_FLIGHT',
    description: 'Committed before calling the provider, so a crash is recoverable.',
    writeAhead: true,
  },
  {
    trigger: 'ORDER_CREATED',
    from: ['ORDER_IN_FLIGHT'],
    to: 'ORDER_CREATED',
    description: 'The provider created the order. No money has moved yet.',
    writeAhead: false,
  },
  {
    trigger: 'ORDER_CALL_INDETERMINATE',
    from: ['ORDER_IN_FLIGHT'],
    to: 'ORDER_INDETERMINATE',
    description: 'No usable response. The order may or may not exist.',
    writeAhead: false,
  },
  {
    trigger: 'ORDER_REJECTED',
    from: ['ORDER_IN_FLIGHT'],
    to: 'FAILED',
    description: 'The provider refused the order outright.',
    writeAhead: false,
  },
  {
    trigger: 'ORDER_RECONCILED_FOUND',
    from: ['ORDER_INDETERMINATE', 'ORDER_IN_FLIGHT'],
    to: 'ORDER_CREATED',
    description: 'Lookup by receipt found the order; we adopt the provider truth.',
    writeAhead: false,
  },
  {
    trigger: 'ORDER_RECONCILED_ABSENT',
    from: ['ORDER_INDETERMINATE', 'ORDER_IN_FLIGHT'],
    to: 'FAILED',
    description: 'Lookup by receipt found nothing; the create never landed.',
    writeAhead: false,
  },
  {
    trigger: 'PAYMENT_AUTHORIZED',
    from: ['ORDER_CREATED'],
    to: 'PAYMENT_AUTHORIZED',
    description: 'The payer authorized. Funds are reserved but not taken.',
    writeAhead: false,
  },
  {
    trigger: 'CAPTURE_REQUESTED',
    from: ['PAYMENT_AUTHORIZED'],
    to: 'CAPTURE_VERIFYING',
    description: 'The capture gate begins: the kernel runs again against fresh live state.',
    writeAhead: false,
  },
  {
    trigger: 'CAPTURE_ALLOWED',
    from: ['CAPTURE_VERIFYING'],
    to: 'CAPTURE_APPROVED',
    description: 'The kernel approved capture. This is the decision that lets money move.',
    writeAhead: false,
  },
  {
    trigger: 'CAPTURE_CALL_STARTED',
    from: ['CAPTURE_APPROVED'],
    to: 'CAPTURE_IN_FLIGHT',
    description: 'Committed before the capture call. From here money may already have moved.',
    writeAhead: true,
  },
  {
    trigger: 'CAPTURE_SUCCEEDED',
    from: ['CAPTURE_IN_FLIGHT'],
    to: 'CAPTURED',
    description: 'The provider captured the payment.',
    writeAhead: false,
  },
  {
    trigger: 'CAPTURE_CALL_INDETERMINATE',
    from: ['CAPTURE_IN_FLIGHT'],
    to: 'CAPTURE_INDETERMINATE',
    description: 'No usable response to a capture. Money may or may not have moved.',
    writeAhead: false,
  },
  {
    trigger: 'CAPTURE_PROVIDER_REJECTED',
    from: ['CAPTURE_IN_FLIGHT'],
    to: 'CAPTURE_REJECTED',
    description: 'The provider refused the capture and said so definitively.',
    writeAhead: false,
  },
  {
    trigger: 'CAPTURE_RECONCILED_CAPTURED',
    from: ['CAPTURE_INDETERMINATE', 'CAPTURE_IN_FLIGHT'],
    to: 'CAPTURED',
    description: 'Asking the provider showed the payment is captured; we adopt that.',
    writeAhead: false,
  },
  {
    trigger: 'CAPTURE_RECONCILED_NOT_CAPTURED',
    from: ['CAPTURE_INDETERMINATE', 'CAPTURE_IN_FLIGHT'],
    to: 'CAPTURE_REJECTED',
    description: 'Asking the provider showed the payment was never captured.',
    writeAhead: false,
  },
  {
    trigger: 'SETTLEMENT_CONFIRMED',
    from: ['CAPTURED'],
    to: 'SETTLED',
    description: 'A verified webhook confirmed capture. Terminal.',
    writeAhead: false,
  },
  {
    trigger: 'PAYMENT_FAILED',
    from: ['ORDER_CREATED', 'PAYMENT_AUTHORIZED'],
    to: 'FAILED',
    description: 'A verified webhook reported the payment failed before capture.',
    writeAhead: false,
  },
  {
    trigger: 'REVIEW_APPROVED',
    from: ['PAUSED'],
    to: 'CAPTURE_VERIFYING',
    description:
      'An operator approved a paused release. Verification runs again rather than being skipped.',
    writeAhead: false,
  },
  {
    trigger: 'REVIEW_REJECTED',
    from: ['PAUSED'],
    to: 'ABORTED',
    description: 'An operator rejected a paused release.',
    writeAhead: false,
  },
  {
    trigger: 'ABORT',
    from: [
      'DRAFT',
      'VERIFYING',
      'VERIFIED',
      'ORDER_CREATED',
      'PAUSED',
      // The two transient capture states. A release sitting in either of them
      // provably never reached the provider: the write-ahead commit that
      // precedes a capture moves out of CAPTURE_APPROVED, so if we are still
      // in it, that commit did not happen. Aborting is therefore safe, and it
      // frees the authorization from the one-active-release index. See ADR-011.
      'CAPTURE_VERIFYING',
      'CAPTURE_APPROVED',
    ],
    to: 'ABORTED',
    description: 'Cancelled or abandoned before any money could move.',
    writeAhead: false,
  },
]);

export class InvalidTransitionError extends CaptureLockError {
  constructor(from: ReleaseState, trigger: TransitionTrigger) {
    super('INVALID_TRANSITION', `Cannot apply ${trigger} from state ${from}`, { from, trigger });
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Resolves the destination state, or null if the move is not declared.
 *
 * Note that a terminal source always yields null: an approval arriving after a
 * release has already settled cannot reopen it.
 */
export function nextState(from: ReleaseState, trigger: TransitionTrigger): ReleaseState | null {
  if (isTerminalReleaseState(from)) return null;
  const rule = TRANSITIONS.find(t => t.trigger === trigger && t.from.includes(from));
  return rule?.to ?? null;
}

export function requireNextState(from: ReleaseState, trigger: TransitionTrigger): ReleaseState {
  const to = nextState(from, trigger);
  if (to === null) throw new InvalidTransitionError(from, trigger);
  return to;
}

/** Source states from which a trigger is legal, for use in a compare-and-set. */
export function sourceStatesFor(trigger: TransitionTrigger): readonly ReleaseState[] {
  return TRANSITIONS.filter(t => t.trigger === trigger).flatMap(t => [...t.from]);
}

export function isWriteAheadTrigger(trigger: TransitionTrigger): boolean {
  return TRANSITIONS.some(t => t.trigger === trigger && t.writeAhead);
}

/**
 * Structural invariants over the graph, asserted by the test suite.
 *
 * Checking the shape of the machine rather than only its individual edges
 * catches the class of mistake where a state becomes unreachable or a terminal
 * state quietly grows an exit.
 */
export function graphInvariants(): {
  readonly unreachable: readonly ReleaseState[];
  readonly deadEnds: readonly ReleaseState[];
  readonly terminalWithExits: readonly ReleaseState[];
} {
  const reachable = new Set<ReleaseState>(['DRAFT']);
  let grew = true;
  while (grew) {
    grew = false;
    for (const rule of TRANSITIONS) {
      if (rule.from.some(state => reachable.has(state)) && !reachable.has(rule.to)) {
        reachable.add(rule.to);
        grew = true;
      }
    }
  }

  const unreachable = RELEASE_STATES.filter(state => !reachable.has(state));
  const deadEnds = RELEASE_STATES.filter(
    state => !isTerminalReleaseState(state) && !TRANSITIONS.some(t => t.from.includes(state)),
  );
  const terminalWithExits = RELEASE_STATES.filter(
    state => isTerminalReleaseState(state) && TRANSITIONS.some(t => t.from.includes(state)),
  );

  return { unreachable, deadEnds, terminalWithExits };
}
