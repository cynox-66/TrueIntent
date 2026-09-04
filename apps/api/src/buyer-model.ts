/**
 * Which model drives the buyer agent, and why.
 *
 * Its own module because the answer is shown to a person watching a payment
 * happen, and "which model chose this cart?" deserves one definition rather
 * than a condition inlined at the call site.
 *
 * The selection is deliberately forgiving in one direction only. A missing or
 * broken model configuration falls back to the deterministic planner and says
 * so — the service still starts, the agent still shops, and the fallback is
 * labelled rather than hidden. It is never forgiving in the other direction:
 * nothing here can grant the model authority it does not have. Whichever model
 * is selected reaches the same bounded tool vocabulary, and every action it
 * proposes is validated against the session authority server-side.
 *
 * Before this existed, the live path required `BUYER_MODEL=anthropic` to be set
 * *explicitly*: a configured `ANTHROPIC_API_KEY` alone did nothing, so the
 * shipped agent was always the planner. That was the whole reason the live path
 * had never run.
 */

import { AnthropicBuyerModel, DeterministicBuyerModel, type BuyerModel } from '@capturelock/agent';
import type { AppConfig } from './config.js';

export type BuyerModelKind = 'ANTHROPIC' | 'DETERMINISTIC';

export interface SelectedBuyerModel {
  readonly model: BuyerModel;
  readonly kind: BuyerModelKind;
  /**
   * Why this model is the one running, in words a screen can show.
   *
   * Never contains a key, a key fragment, or a prompt. It exists so a viewer is
   * told they are watching the fallback rather than left to infer it from a
   * model name they may not recognise.
   */
  readonly reason: string;
}

/**
 * Chooses the buyer model from configuration.
 *
 * `makeAnthropic` is injectable so a test can assert the selection without
 * constructing something that would reach the network.
 */
export function selectBuyerModel(
  config: Pick<AppConfig, 'buyerModel' | 'anthropicApiKey' | 'anthropicModel'>,
  makeAnthropic: (options: { apiKey: string; model: string }) => BuyerModel = options =>
    new AnthropicBuyerModel(options),
): SelectedBuyerModel {
  const deterministic = (reason: string): SelectedBuyerModel => ({
    model: new DeterministicBuyerModel(),
    kind: 'DETERMINISTIC',
    reason,
  });

  if (config.buyerModel === 'deterministic') {
    return deterministic('BUYER_MODEL is set to deterministic.');
  }

  const key = config.anthropicApiKey;
  if (key === undefined || key.trim().length === 0) {
    // Includes the case where someone asked for `anthropic` explicitly. Refusing
    // to start would punish a misconfiguration by taking the whole service
    // down, and the agent has a working fallback — so it says what happened and
    // keeps going.
    return deterministic(
      'No ANTHROPIC_API_KEY is configured, so the agent is running on the deterministic planner.',
    );
  }

  try {
    return {
      model: makeAnthropic({ apiKey: key, model: config.anthropicModel }),
      kind: 'ANTHROPIC',
      reason: `Reasoning with ${config.anthropicModel} through the bounded tool vocabulary.`,
    };
  } catch {
    // The adapter validates its own configuration. A throw here is a
    // misconfiguration, not a reason to have no agent at all.
    return deterministic(
      'The configured model could not be initialised, so the agent fell back to the deterministic planner.',
    );
  }
}

/** A short label for the badge. Distinguishable at a glance, no version noise. */
export function buyerModelLabel(kind: BuyerModelKind): string {
  return kind === 'ANTHROPIC' ? 'LLM · Anthropic' : 'Deterministic fallback';
}
