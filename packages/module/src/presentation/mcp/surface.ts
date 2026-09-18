import { PromptDefinition } from './prompt-definition.js';
import { PROMPTS } from './prompts.js';
import { ResourceDefinition } from './resource-definition.js';
import { ResourceDependencies, resources } from './resources.js';
import { ToolDefinition } from './tool-definition.js';
import { BillingControllers, billingTools } from './tools/billing-tools.js';
import {
  LifecycleDependencies,
  billingLifecycleTools,
} from './tools/billing-lifecycle-tools.js';
import {
  DeploymentIdentity,
  OverviewControllers,
  overviewTool,
} from './tools/overview-tool.js';
import { PriceReadControllers, priceReadTools } from './tools/prices-tools.js';
import {
  PriceWriteDependencies,
  priceWriteTools,
} from './tools/price-write-tools.js';
import { SessionControllers, sessionTools } from './tools/sessions-tools.js';
import { TraceControllers, traceTools } from './tools/traces-tools.js';

/**
 * What the MCP surface is made of. One object, assembled by the
 * composition root (main/factories/mcp-factory.ts) — this layer never
 * reaches for config, a store or a framework.
 */
export interface McpSurfaceDependencies {
  readonly identity: DeploymentIdentity;
  readonly traces: TraceControllers;
  readonly sessions: SessionControllers;
  readonly billing: BillingControllers;
  readonly prices: PriceReadControllers;
  readonly overview: OverviewControllers;
  readonly priceWrites: PriceWriteDependencies;
  readonly lifecycle: LifecycleDependencies;
  readonly resources: ResourceDependencies;
}

export interface McpSurface {
  readonly tools: readonly ToolDefinition[];
  readonly prompts: readonly PromptDefinition[];
  readonly resources: readonly ResourceDefinition[];
}

/**
 * What the server tells a client LLM about itself before any tool runs.
 * It carries the invariants a reader cannot infer from the schemas (money
 * is stamped and immutable, a pending price is not zero, a closed month is
 * frozen) and the one rule that keeps a write honest: the person approves
 * the preview, not the model.
 */
export const SERVER_INSTRUCTIONS = [
  'This server is the usage archive of ONE client: the real executions of its AI agents (traces), the conversations those executions belong to (sessions), what they cost in R$ (billing), and the contracted price table.',
  'Start with get_overview: it says which client this is, the timezone its billing months are cut in, which months exist and where the current one is heading.',
  'Money rules that are not negotiable: every value is in R$; a cost is stamped when the execution is ingested and never changes; an execution with no applicable price is pending_price, which means its cost is OPEN, never R$ 0.00, and it is excluded from every total; a closed month is final and served from its frozen snapshot; the current month is always partial and must be labelled as such.',
  'Reads are free to call and never change anything.',
  'Writes are two tools: a preview that changes nothing and returns a confirmation_token, then a confirming tool that requires that token. Always show the preview to the person, get their explicit approval, and only then confirm. Never call a confirming tool with a token whose preview the person has not seen, and never change the arguments between the two calls.',
  'Failures come back as tool results with isError and a JSON body { code, message, hint }. Read the hint before retrying: a mismatched or expired token means preview again, not guess again.',
].join(' ');

export const buildMcpSurface = (deps: McpSurfaceDependencies): McpSurface => ({
  tools: [
    overviewTool(deps.overview, deps.identity),
    ...traceTools(deps.traces),
    ...sessionTools(deps.sessions),
    ...billingTools(deps.billing),
    ...priceReadTools(deps.prices),
    ...priceWriteTools(deps.priceWrites),
    ...billingLifecycleTools(deps.lifecycle),
  ],
  prompts: PROMPTS,
  resources: resources(deps.resources),
});
