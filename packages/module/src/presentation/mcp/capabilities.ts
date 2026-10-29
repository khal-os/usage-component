import { BILLING_LEDGER, TRACING_SESSIONS } from '../capabilities.js';
import { PromptDefinition } from './prompt-definition.js';
import { ResourceDefinition } from './resource-definition.js';
import { ToolCaller, ToolDefinition } from './tool-definition.js';

/** What one tool, prompt or resource needs of the caller (decision 184). */
export interface McpNeed {
  /** The data it reads: every capability listed must be held. */
  readonly capabilities: readonly string[];
  /** A write the Khal team makes (a price, the month's lifecycle). */
  readonly masterOnly?: true;
}

const BILLING: McpNeed = { capabilities: [BILLING_LEDGER] };
const TRACING: McpNeed = { capabilities: [TRACING_SESSIONS] };
const BILLING_WRITE: McpNeed = {
  capabilities: [BILLING_LEDGER],
  masterOnly: true,
};
const EVERYONE: McpNeed = { capabilities: [] };

/**
 * Each tool belongs to the data it reads. A name missing here is reached by
 * nobody: a new tool is invisible until someone says whose data it serves
 * (the spec holds the table and the surface equal).
 */
export const TOOL_NEEDS: Readonly<Record<string, McpNeed>> = {
  get_overview: BILLING,
  list_bills: BILLING,
  get_billing_summary: BILLING,
  get_billing_series: BILLING,
  get_billing_projection: BILLING,
  export_statement: BILLING,
  list_prices: BILLING,
  preview_close_billing_period: BILLING_WRITE,
  close_billing_period: BILLING_WRITE,
  preview_reopen_billing_period: BILLING_WRITE,
  reopen_billing_period: BILLING_WRITE,
  preview_register_price: BILLING_WRITE,
  register_price: BILLING_WRITE,
  list_traces: TRACING,
  get_trace_filter_options: TRACING,
  get_trace: TRACING,
  list_sessions: TRACING,
  get_session_filter_options: TRACING,
  get_session: TRACING,
};

export const PROMPT_NEEDS: Readonly<Record<string, McpNeed>> = {
  'explain-bill': BILLING,
  // cost AND the executions behind it
  'find-cost-driver': { capabilities: [BILLING_LEDGER, TRACING_SESSIONS] },
  'register-price': BILLING_WRITE,
  'close-month': BILLING_WRITE,
};

export const RESOURCE_NEEDS: Readonly<Record<string, McpNeed>> = {
  // the HTTP contract, not data
  openapi: EVERYONE,
  bills: BILLING,
  prices: BILLING,
};

/**
 * With the claim, only what it names; without it (Permissões off or shadow)
 * the door admitted the master alone, and nothing more is restricted.
 */
export const reaches = (
  caller: ToolCaller,
  need: McpNeed | undefined,
): boolean => {
  if (need === undefined) return false;
  if (need.masterOnly === true && !caller.master) return false;
  const held = caller.capabilities;
  return (
    held === undefined ||
    need.capabilities.every((capability) => held.has(capability))
  );
};

export interface CallerSurface {
  readonly tools: readonly ToolDefinition[];
  readonly prompts: readonly PromptDefinition[];
  readonly resources: readonly ResourceDefinition[];
}

/** The part of the surface this caller reaches — the only part the server registers. */
export const surfaceFor = (
  surface: CallerSurface,
  caller: ToolCaller,
): CallerSurface => ({
  tools: surface.tools.filter((tool) => reaches(caller, TOOL_NEEDS[tool.name])),
  prompts: surface.prompts.filter((prompt) =>
    reaches(caller, PROMPT_NEEDS[prompt.name]),
  ),
  resources: surface.resources.filter((resource) =>
    reaches(caller, RESOURCE_NEEDS[resource.name]),
  ),
});
