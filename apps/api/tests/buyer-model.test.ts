/**
 * Which model drives the agent, and what selecting one does not change.
 *
 * The first block covers the selection itself. The second is the one that
 * matters: whichever model is chosen, it reaches the same bounded tool
 * vocabulary and holds no payment authority. If selecting a real model could
 * widen what the agent may do, that would be the whole argument undone.
 *
 * Nothing here reaches the network. The Anthropic constructor is injected, so a
 * test asserts the *selection* without performing a live call.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buyerModelLabel, selectBuyerModel } from '../src/buyer-model.js';
import {
  AGENT_ACTION_KINDS,
  FORBIDDEN_TOOL_SUBSTRINGS,
  parseAgentAction,
  type BuyerModel,
} from '@capturelock/agent';

// Vitest runs from the workspace root, which is where the packages live.
const ROOT = process.cwd();

/** Stands in for the real adapter, so no test constructs something networked. */
function fakeAnthropic(options: { apiKey: string; model: string }): BuyerModel {
  return {
    name: `anthropic:${options.model}`,
    decide: async () => null,
  };
}

const BASE = {
  buyerModel: 'auto' as const,
  anthropicApiKey: undefined as string | undefined,
  anthropicModel: 'claude-sonnet-5',
};

describe('selecting the buyer model', () => {
  it('uses the live model when a key is configured', async () => {
    // The behaviour that was missing. Before this, a configured key did nothing
    // unless BUYER_MODEL=anthropic was set as well, so the live path had never
    // run in a shipped configuration.
    const selected = selectBuyerModel(
      { ...BASE, anthropicApiKey: 'sk-ant-not-a-real-key' },
      fakeAnthropic,
    );

    expect(selected.kind).toBe('ANTHROPIC');
    expect(selected.model.name).toBe('anthropic:claude-sonnet-5');
  });

  it('falls back to the planner when no key is configured', async () => {
    const selected = selectBuyerModel(BASE, fakeAnthropic);

    expect(selected.kind).toBe('DETERMINISTIC');
    expect(selected.model.name).toBe('deterministic-planner');
    expect(selected.reason).toMatch(/No ANTHROPIC_API_KEY/i);
  });

  it('honours an explicit request for the planner even when a key exists', async () => {
    // The offline suites and the scenario engine depend on this: a scenario is
    // evidence about TrueIntent only if the agent is predictable.
    const selected = selectBuyerModel(
      { ...BASE, buyerModel: 'deterministic', anthropicApiKey: 'sk-ant-not-a-real-key' },
      fakeAnthropic,
    );
    expect(selected.kind).toBe('DETERMINISTIC');
    expect(selected.reason).toMatch(/deterministic/i);
  });

  it('falls back rather than failing when anthropic is asked for without a key', async () => {
    // A misconfiguration must not take the service down. A model that cannot be
    // reached is never a reason to skip a check.
    const selected = selectBuyerModel({ ...BASE, buyerModel: 'anthropic' }, fakeAnthropic);
    expect(selected.kind).toBe('DETERMINISTIC');
  });

  it('falls back rather than failing when the adapter refuses its configuration', async () => {
    const selected = selectBuyerModel({ ...BASE, anthropicApiKey: '   ' }, () => {
      throw new Error('bad configuration');
    });
    expect(selected.kind).toBe('DETERMINISTIC');
  });

  it('never puts a key, a fragment of one, or a prompt in the reason', async () => {
    // The reason is rendered on a screen.
    const key = 'sk-ant-super-secret-value';
    const selected = selectBuyerModel({ ...BASE, anthropicApiKey: key }, fakeAnthropic);

    expect(selected.reason).not.toContain(key);
    expect(selected.reason).not.toContain('sk-ant');
    expect(selected.reason).not.toMatch(/api[_-]?key/i);
  });

  it('labels the two kinds distinguishably', () => {
    expect(buyerModelLabel('ANTHROPIC')).toMatch(/LLM/);
    expect(buyerModelLabel('DETERMINISTIC')).toMatch(/fallback/i);
    expect(buyerModelLabel('ANTHROPIC')).not.toBe(buyerModelLabel('DETERMINISTIC'));
  });
});

describe('selecting a model changes nothing about what it may do', () => {
  it('leaves the tool vocabulary without a word for moving money', () => {
    // Whichever model runs, this is the entire surface it can act through.
    const offenders: string[] = [];
    for (const kind of AGENT_ACTION_KINDS) {
      for (const forbidden of FORBIDDEN_TOOL_SUBSTRINGS) {
        if (kind.toLowerCase().includes(forbidden)) offenders.push(kind);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('refuses a payment demand from a live model exactly as from any other', () => {
    // A prompt-injected model saying "capture the payment" produces an action
    // that fails validation. There is no word for it to say.
    expect(parseAgentAction({ action: 'CAPTURE_PAYMENT', amount: 999 }).kind).toBe('INVALID');
    expect(parseAgentAction({ action: 'CHARGE_CARD', sku: 'SKU-A' }).kind).toBe('INVALID');
    expect(parseAgentAction({ action: 'REQUEST_PURCHASE', reason: 'x', amount: 100 }).kind).toBe(
      'INVALID',
    );
  });

  it('gives the agent package no route to a provider, repository or kernel', () => {
    // Asserted on source text rather than types, because the property being
    // protected is a dependency one. Selecting a live model does not widen it.
    const files = ['model.ts', 'anthropic-model.ts', 'runtime.ts', 'tools.ts', 'index.ts'];
    const source = files
      .map(file => readFileSync(join(ROOT, 'packages', 'agent', 'src', file), 'utf8'))
      .join('\n');

    for (const forbidden of [
      '@capturelock/kernel',
      '@capturelock/persistence',
      '@capturelock/integrations',
      'razorpay',
    ]) {
      expect(source).not.toContain(`from '${forbidden}`);
    }
  });
});
