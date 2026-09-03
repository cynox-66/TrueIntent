/**
 * The advisory intent reviewer.
 *
 * The Phase 0 documents described a "spirit check": a semantic judgement that
 * could return ALIGNED, MARGINAL or DIVERGED and steer the verdict. Taken
 * literally that would put a probabilistic component inside the money path, and
 * would make a decision unreproducible — you cannot replay a model.
 *
 * The correction is a one-way valve. The advisory layer sits **outside** the
 * deterministic kernel and may only *restrict*:
 *
 *     ALIGNED   -> no change
 *     MARGINAL  -> ALLOW becomes PAUSE          (never raises PAUSE or DENY)
 *     DIVERGED  -> ALLOW or PAUSE becomes DENY
 *     unavailable -> no change, recorded as ADVISORY_UNAVAILABLE
 *
 * Three consequences worth stating plainly:
 *
 *  - A compromised or prompt-injected reviewer cannot approve anything. The
 *    worst it can do is refuse a legitimate transaction, which is a
 *    availability problem rather than a financial one.
 *  - The "fail open or fail closed on timeout?" question that Phase 0 left open
 *    dissolves. An advisory that can only restrict cannot fail open, so an
 *    unavailable reviewer simply applies no restriction.
 *  - Replay stays exact, because the deterministic decision and its hash are
 *    recorded separately from the advisory adjustment. An auditor can reproduce
 *    the deterministic half precisely and see the advisory half as what it is:
 *    a judgement, attributed and dated.
 */

import {
  SEVERITY_RANK,
  compareFindings,
  finding,
  type AuthorizedIntent,
  type Finding,
  type LiveItemState,
  type ProposedCart,
  type ReasonCode,
  type VerificationDecision,
  type Verdict,
} from '@capturelock/core';

export type AdvisoryJudgement = 'ALIGNED' | 'MARGINAL' | 'DIVERGED';

export interface AdvisoryInput {
  /** The user's original words. This is the one place free text is read. */
  readonly rawIntent: string;
  readonly cart: ProposedCart;
  readonly liveItems: readonly LiveItemState[];
}

export interface AdvisoryReviewer {
  readonly name: string;
  /**
   * Returns a judgement, or null if unavailable.
   *
   * Implementations must never throw: the caller treats an exception the same
   * as unavailability, but a reviewer that signals absence explicitly produces
   * a clearer record.
   */
  review(input: AdvisoryInput): Promise<AdvisoryJudgement | null>;
}

export interface AdvisoryOutcome {
  readonly reviewer: string;
  readonly judgement: AdvisoryJudgement | null;
  readonly deterministicVerdict: Verdict;
  readonly effectiveVerdict: Verdict;
  /** True when the advisory changed the outcome. It can only ever restrict it. */
  readonly restricted: boolean;
}

const RESTRICTION: Readonly<Record<AdvisoryJudgement, Verdict | null>> = Object.freeze({
  ALIGNED: null,
  MARGINAL: 'PAUSE',
  DIVERGED: 'DENY',
});

/**
 * Applies an advisory judgement to a deterministic decision.
 *
 * The floor is enforced by comparing severity ranks: the result is never less
 * severe than what the kernel decided, whatever the reviewer says.
 */
export function applyAdvisory(
  decision: VerificationDecision,
  reviewer: string,
  judgement: AdvisoryJudgement | null,
): { decision: VerificationDecision; outcome: AdvisoryOutcome } {
  const deterministic = decision.verdict;

  if (judgement === null) {
    const findings = [
      ...decision.findings,
      finding(
        'INTENT',
        'ADVISORY_UNAVAILABLE',
        `Advisory reviewer ${reviewer} was unavailable. It can only restrict, so its absence changes nothing.`,
        { reviewer },
      ),
    ].sort(compareFindings);

    return {
      decision: Object.freeze({
        ...decision,
        findings: Object.freeze(findings),
        reasonCodes: Object.freeze(dedupe([...decision.reasonCodes, 'ADVISORY_UNAVAILABLE'])),
      }),
      outcome: {
        reviewer,
        judgement: null,
        deterministicVerdict: deterministic,
        effectiveVerdict: deterministic,
        restricted: false,
      },
    };
  }

  const proposed = RESTRICTION[judgement];
  if (proposed === null) {
    return {
      decision,
      outcome: {
        reviewer,
        judgement,
        deterministicVerdict: deterministic,
        effectiveVerdict: deterministic,
        restricted: false,
      },
    };
  }

  // Take the more severe of the two. A reviewer saying MARGINAL cannot soften
  // an existing DENY, and one saying ALIGNED cannot lift anything at all.
  const effective: Verdict =
    verdictRank(proposed) > verdictRank(deterministic) ? proposed : deterministic;

  const code: ReasonCode =
    judgement === 'DIVERGED' ? 'ADVISORY_INTENT_DIVERGED' : 'ADVISORY_INTENT_MARGINAL';

  const extra: Finding = finding(
    'INTENT',
    code,
    judgement === 'DIVERGED'
      ? 'The advisory reviewer judged the cart to have diverged from the stated intent.'
      : 'The advisory reviewer judged the cart a marginal fit for the stated intent.',
    { reviewer, judgement },
  );

  return {
    decision: Object.freeze({
      ...decision,
      verdict: effective,
      findings: Object.freeze([...decision.findings, extra].sort(compareFindings)),
      reasonCodes: Object.freeze(dedupe([...decision.reasonCodes, code])),
    }),
    outcome: {
      reviewer,
      judgement,
      deterministicVerdict: deterministic,
      effectiveVerdict: effective,
      restricted: effective !== deterministic,
    },
  };
}

function verdictRank(verdict: Verdict): number {
  return verdict === 'DENY'
    ? SEVERITY_RANK.DENY
    : verdict === 'PAUSE'
      ? SEVERITY_RANK.PAUSE
      : SEVERITY_RANK.INFO;
}

function dedupe(codes: readonly ReasonCode[]): ReasonCode[] {
  return [...new Set(codes)];
}

/**
 * A deterministic stand-in for a model-backed reviewer.
 *
 * It asks one crude question: do any of the meaningful words in what the user
 * asked for appear in what the merchant is actually selling? That catches the
 * canonical drift case — "dinner ingredients" answered with energy drinks —
 * without any inference, and it is completely reproducible.
 *
 * It is not a semantic judge and is not presented as one. It exists so the
 * advisory *pathway* is real, tested, and shown to be restriction-only; swapping
 * in a model-backed `AdvisoryReviewer` changes nothing about the guarantees,
 * which is the entire point of the interface.
 */
export class LexicalOverlapReviewer implements AdvisoryReviewer {
  public readonly name = 'lexical-overlap';

  constructor(private readonly minimumOverlap = 1) {}

  async review(input: AdvisoryInput): Promise<AdvisoryJudgement> {
    const wanted = significantWords(input.rawIntent);
    if (wanted.size === 0) return 'ALIGNED';

    const offered = new Set<string>();
    for (const item of input.liveItems) {
      for (const word of significantWords(`${item.name} ${item.category}`)) offered.add(word);
      for (const attribute of item.attributes) {
        for (const word of significantWords(attribute.value)) offered.add(word);
      }
    }

    let overlap = 0;
    for (const word of wanted) if (offered.has(word)) overlap += 1;

    return overlap >= this.minimumOverlap ? 'ALIGNED' : 'MARGINAL';
  }
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'best',
  'buy',
  'by',
  'cheap',
  'cheapest',
  'find',
  'for',
  'from',
  'get',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'pair',
  'please',
  'rupees',
  'some',
  'that',
  'the',
  'to',
  'under',
  'want',
  'with',
  'would',
]);

function significantWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word) && !/^\d+$/.test(word));
  return new Set(words);
}

export type { AuthorizedIntent };
