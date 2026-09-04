/**
 * The agentic context panel.
 *
 * The rest of this console answers "what did CaptureLock decide, and why?" from
 * evidence that replays exactly. This panel answers the question an operator
 * asks first and the ledger could not previously address: *why did an agent
 * think the user wanted this?*
 *
 * Two labelling decisions carry weight, because an operator reading this is
 * deciding whether to approve a payment:
 *
 *  - The agent's rationale is shown as a **judgement**, visually separated from
 *    everything else on the panel. It is the one thing here that no check read
 *    and nothing verified.
 *  - Line prices are labelled as server-priced. They come from the snapshot,
 *    which came from a live merchant read — not from anything the agent said —
 *    and an operator who mistook them for the agent's numbers would draw the
 *    wrong conclusion about who to trust.
 *
 * A release created through the plain API has no agentic context. That is not
 * an error, and the panel says so rather than showing a failure.
 */

import type { AgentContextCapsuleView, AgentContextResponse } from '../api/types.js';
import { api, type OperatorCredential } from '../api/client.js';
import { useAsync } from '../lib/useAsync.js';
import { formatAbsolute, formatMoney } from '../lib/format.js';
import { ErrorBlock, Field, Panel, Pill, RawJson, Skeleton } from '../components/primitives.js';
import type { ReactNode } from 'react';

interface AgentContextPanelProps {
  readonly releaseId: string;
  readonly operator: OperatorCredential;
}

function money(currency: string, amountMinor: number): string {
  return formatMoney({ currency, amountMinor } as Parameters<typeof formatMoney>[0]);
}

export function AgentContextPanel({ releaseId, operator }: AgentContextPanelProps): ReactNode {
  const { state, reload } = useAsync<AgentContextResponse>(
    signal => api.agentContext(releaseId, operator, signal),
    [releaseId, operator],
  );

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <Panel title="Agentic context">
        <Skeleton rows={4} />
      </Panel>
    );
  }

  if (state.status === 'failed') {
    return (
      <Panel title="Agentic context">
        <ErrorBlock error={state.error} onRetry={reload} />
      </Panel>
    );
  }

  const context = state.data;

  if (!context.agentic || context.capsule === null) {
    return (
      <Panel title="Agentic context">
        <p className="muted">
          This release was created directly through the API, not by a bounded buyer agent. There is
          no delegated session or agent decision behind it.
        </p>
      </Panel>
    );
  }

  const capsule = context.capsule;
  const session = context.session;

  return (
    <Panel title="Agentic context">
      {/* What the user actually asked for, in their own words. */}
      <div className="agent-intent">
        <div className="agent-intent-label">The user asked for</div>
        <div className="agent-intent-text">{capsule.intentText}</div>
      </div>

      <dl className="fields">
        <Field label="Session">
          <span className="mono">{capsule.sessionId}</span>
        </Field>
        {session !== null && (
          <>
            <Field label="Session state">
              <Pill tone={session.state === 'ACTIVE' ? 'safe' : 'danger'}>{session.state}</Pill>
            </Field>
            {/* Across every purchase in this session, not just this one. */}
            <Field label="Delegated budget (whole session)">
              {money(session.remaining.currency, session.spentMinor)} spent ·{' '}
              {money(session.remaining.currency, session.reservedMinor)} held ·{' '}
              {money(session.remaining.currency, session.remaining.amountMinor)} remaining
            </Field>
            <Field label="Session expires">
              <span className="mono">{formatAbsolute(session.expiresAt)}</span>
            </Field>
          </>
        )}
        {/* Recorded for attribution. The model proposed; it decided nothing. */}
        <Field label="Model">
          <span className="mono">{capsule.agentDecision.model}</span>
        </Field>
        <Field label="Agent steps">
          {capsule.agentDecision.steps} taken, {capsule.agentDecision.refusedSteps} refused
        </Field>
        {/* Which version of the merchant's world the agent was looking at. */}
        <Field label="Catalogue version">
          <span className="mono">{capsule.catalogVersion}</span>
        </Field>
        <Field label="Budget hold">
          <Pill tone={context.settlementState === 'SETTLED' ? 'safe' : 'attention'}>
            {context.settlementState ?? 'UNKNOWN'}
          </Pill>
        </Field>
      </dl>

      {/* The cart, as the SERVER priced it. */}
      <div className="table-scroll" style={{ marginTop: '1rem' }}>
        <table className="agent-cart">
          <caption className="agent-cart-caption">
            What the agent selected — priced by the server from a live merchant read, never from
            anything the agent claimed
          </caption>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Item</th>
              <th>Category</th>
              <th className="nowrap">Qty</th>
              <th className="nowrap">Unit price</th>
            </tr>
          </thead>
          <tbody>
            {capsule.lines.map((line: AgentContextCapsuleView['lines'][number]) => (
              <tr key={line.sku}>
                <td className="mono nowrap">{line.sku}</td>
                <td>{line.name}</td>
                <td>{line.category}</td>
                <td className="nowrap">{line.quantity}</td>
                <td className="mono nowrap">{money(capsule.currency, line.unitPriceMinor)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>Total, as verified</td>
              <td className="mono nowrap">{money(capsule.currency, capsule.totalMinor)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/*
        Set apart deliberately. Everything above is a fact the server resolved;
        this is the agent's own account of itself, and an operator should weigh
        it as such.
      */}
      <div className="agent-rationale">
        <div className="agent-rationale-label">
          The agent&rsquo;s reasoning — a judgement, not a verified fact
        </div>
        <div className="agent-rationale-text">{capsule.agentDecision.rationale}</div>
      </div>

      <dl className="fields" style={{ marginTop: '1rem' }}>
        {/* Recorded in the evidence chain before either gate ran. */}
        <Field label="Capsule hash">
          <span className="mono">{context.capsuleHash ?? '—'}</span>
        </Field>
        <Field label="Bound policy">
          <span className="mono">
            {capsule.policyId}@{capsule.policyVersion}
          </span>
        </Field>
      </dl>

      <RawJson label="Raw context capsule" value={context} />
    </Panel>
  );
}
