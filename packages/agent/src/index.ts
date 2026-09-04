/**
 * @capturelock/agent
 *
 * The bounded buyer agent: a tool vocabulary, a model port, and a loop that
 * validates every proposed action against the delegated authority.
 *
 * This package depends on `@capturelock/core` and nothing else. It holds no
 * payment provider, no repository, and no kernel reference, so the strongest
 * thing it can produce is a request to verify a cart of SKUs and quantities.
 * Whether money may move is decided elsewhere, on data this package never sees.
 */

export {
  AGENT_ACTION_KINDS,
  AgentActionSchema,
  FORBIDDEN_TOOL_SUBSTRINGS,
  MAX_QUERY_LENGTH,
  MAX_REASON_LENGTH,
  TOOL_DESCRIPTIONS,
  parseAgentAction,
  type AgentAction,
  type AgentActionKind,
  type ParseActionResult,
} from './tools.js';

export {
  DeterministicBuyerModel,
  MalformedBuyerModel,
  UnavailableBuyerModel,
  type BuyerModel,
  type BuyerModelInput,
  type DraftCartLine,
} from './model.js';

export {
  BuyerAgentRuntime,
  DEFAULT_MAX_STEPS,
  MAX_DRAFT_CART_LINES,
  SEARCH_RESULT_LIMIT,
  type AgentRunOutcome,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRuntimeDependencies,
  type AgentStep,
} from './runtime.js';

export {
  AnthropicBuyerModel,
  DEFAULT_ANTHROPIC_MODEL,
  type AnthropicBuyerModelOptions,
} from './anthropic-model.js';
