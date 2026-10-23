import { z } from 'zod';
import {
  tokenCountsViewSchema,
  tokenTypeSchema,
} from '../../helpers/docs-schemas.js';

const periodStatusSchema = z.enum(['closed', 'in_progress', 'open']);

/**
 * US8 line: quantity × contracted unit price = line cost, literally. A
 * mid-month price change yields separate lines (decision 90), so the
 * displayed price is always THE price of that line's tokens.
 */
const billingLineSchema = z.strictObject({
  agent_id: z.string().nullable(),
  agent_version: z.string().nullable(),
  model: z.string().nullable(),
  model_label: z.string(),
  token_type: tokenTypeSchema,
  token_type_label: z.string(),
  tokens: z.number().int(),
  tokens_display: z.string(),
  /** Contracted price, R$ per million tokens (US8/US4 conversation). */
  unit_price_brl_per_million_display: z.string(),
  unit_price_effective_from_display: z.string(),
  cost_brl_exact: z.string(),
  cost_brl_exact_display: z.string(),
  cost_brl_display: z.string(),
  cost_brl_display_brl: z.string(),
});

/**
 * Bar geometry is API-computed (decision 51): segment widths are percents
 * of the full track, where the most expensive agent spans 100%. The
 * front-end lays segments out sequentially — zero client-side math.
 */
const billingAgentSegmentSchema = z.strictObject({
  token_type: tokenTypeSchema,
  width_percent: z.number(),
  label: z.string(),
});

const billingAgentGroupSchema = z.strictObject({
  agent_id: z.string().nullable(),
  agent_version: z.string().nullable(),
  agent_label: z.string(),
  version_label: z.string().nullable(),
  tokens_total: z.number().int(),
  tokens_total_display: z.string(),
  cost_brl_display: z.string(),
  /** Share of the month total (US7) — reconciled, groups sum to 100,0%. */
  percent_of_total_display: z.string(),
  bar_width_percent: z.number(),
  segments: z.array(billingAgentSegmentSchema),
  lines: z.array(billingLineSchema),
});

/** US15: one model's slice — donut geometry (start/end percent) API-computed. */
const modelShareSchema = z.strictObject({
  model: z.string().nullable(),
  model_label: z.string(),
  cost_brl_display: z.string(),
  cost_share_percent_display: z.string(),
  token_share_percent_display: z.string(),
  donut_start_percent: z.number(),
  donut_end_percent: z.number(),
});

const agentModelMixSchema = z.strictObject({
  agent_label: z.string(),
  version_label: z.string().nullable(),
  /** Blended R$ per million tokens across the agent's whole mix (US15). */
  blended_price_brl_per_million_display: z.string().nullable(),
  models: z.array(modelShareSchema),
});

/** T9/QA7: counterfactual in plain sight — including the explicit write cost. */
const cacheSavingsSchema = z.strictObject({
  cache_read_tokens: z.number().int(),
  cache_read_tokens_display: z.string(),
  actual_cache_read_cost_brl_display: z.string(),
  counterfactual_input_cost_brl_display: z.string(),
  savings_brl_display: z.string(),
  cache_write_cost_brl_display: z.string(),
  /** Signed — heavy cache writes can eat the read savings. */
  net_savings_brl_display: z.string(),
  /** Sign of the DISPLAYED net (derived from displayed cents, #111), so it never contradicts the string. */
  net_positive: z.boolean(),
  unpriceable_cache_read_traces: z.number().int(),
  basis_text: z.string(),
});

/** US10: side-by-side with the previous month — informative only in v1. */
const comparisonSchema = z.strictObject({
  previous_month_label: z.string(),
  previous_period_status: periodStatusSchema,
  previous_partial: z.boolean(),
  previous_total_cost_brl_display: z.string(),
  delta_brl_display: z.string(),
  delta_percent_display: z.string().nullable(),
  direction: z.enum(['up', 'down', 'flat']),
  by_agent: z.array(
    z.strictObject({
      agent_label: z.string(),
      version_label: z.string().nullable(),
      current_cost_brl_display: z.string(),
      previous_cost_brl_display: z.string(),
      delta_brl_display: z.string(),
      delta_percent_display: z.string().nullable(),
      direction: z.enum(['up', 'down', 'flat']),
    }),
  ),
});

export const billingSummaryResponseSchema = z.strictObject({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  month_label: z.string(),
  period_status: periodStatusSchema,
  /** US6: never let a provisional number pass for a final one. */
  partial: z.boolean(),
  final: z.boolean(),
  status_label: z.string(),
  /** US2/US6: "dados até ..." — null when the month has no traces. */
  watermark_display: z.string().nullable(),
  /** Present only when closed (T6). */
  closed_at_display: z.string().nullable(),
  snapshot_version: z.number().int().nullable(),
  snapshot_versions: z.array(
    z.strictObject({
      version: z.number().int(),
      created_at_display: z.string(),
    }),
  ),
  /** US5: audit note of every reopen, newest first. */
  reopen_notes: z.array(
    z.strictObject({ at_display: z.string(), reason: z.string() }),
  ),
  quarantined_trace_count: z.number().int(),
  /** Decision 128 — live context count, never part of any R$ total. */
  no_measured_usage_trace_count: z.number().int(),
  total_cost_brl: z.string(),
  total_cost_brl_display: z.string(),
  stamped_trace_count: z.number().int(),
  stamped_tokens_total: z.number().int(),
  stamped_tokens_total_display: z.string(),
  agent_count: z.number().int(),
  model_count: z.number().int(),
  lines: z.array(billingLineSchema),
  agents: z.array(billingAgentGroupSchema),
  /**
   * ONE donut: each agent's share of the month cost (versions merged),
   * geometry API-computed like every chart. Slices sum to 100%.
   */
  agent_mix: z.array(
    z.strictObject({
      agent_label: z.string(),
      cost_brl_display: z.string(),
      cost_share_percent_display: z.string(),
      donut_start_percent: z.number(),
      donut_end_percent: z.number(),
    }),
  ),
  model_mix: z.strictObject({
    total: z.array(modelShareSchema),
    by_agent: z.array(agentModelMixSchema),
  }),
  cache_savings: cacheSavingsSchema,
  comparison: comparisonSchema.nullable(),
  pending_price: z.strictObject({
    trace_count: z.number().int(),
    tokens: tokenCountsViewSchema,
    tokens_total: z.number().int(),
    tokens_total_display: z.string(),
    models: z.array(z.string()),
    models_label: z.string(),
  }),
});

export type BillingSummaryView = z.infer<typeof billingSummaryResponseSchema>;

export const billListItemSchema = z.strictObject({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  month_label: z.string(),
  period_status: periodStatusSchema,
  partial: z.boolean(),
  final: z.boolean(),
  status_label: z.string(),
  closed_at_display: z.string().nullable(),
  snapshot_version: z.number().int().nullable(),
  quarantined_trace_count: z.number().int(),
  total_cost_brl: z.string(),
  total_cost_brl_display: z.string(),
  stamped_trace_count: z.number().int(),
  pending_trace_count: z.number().int(),
  /**
   * audit B-10.4 — tokens: stamped + pending volume (open-month live
   * meaning); stamped_tokens: billed volume only. On a closed month both
   * come from the snapshot and are equal (the frozen bill knows only
   * billed volume).
   */
  tokens: z.number().int(),
  tokens_display: z.string(),
  stamped_tokens: z.number().int(),
  stamped_tokens_display: z.string(),
});

export const billListResponseSchema = z.strictObject({
  bills: z.array(billListItemSchema),
});

export type BillListView = z.infer<typeof billListResponseSchema>;

/**
 * US11/T8: chart geometry is API-computed — every series carries its bar
 * heights as percents of ONE shared scale (the tallest bar of the
 * response), so toggling series never re-scales the chart and the UI does
 * zero math. Bars STACK by token type (decision 97): `segments` split the
 * bar bottom-up in statement-line colors; `stack_percent` is each
 * segment's share OF THE BAR, `height_percent` remains the whole bar's
 * share of the chart.
 */
const seriesSegmentSchema = z.strictObject({
  token_type: tokenTypeSchema,
  stack_percent: z.number(),
  label: z.string(),
});

const seriesPointSchema = z.strictObject({
  year: z.number().int(),
  month: z.number().int(),
  /** Present only in the daily granularity. */
  day: z.number().int().optional(),
  month_label: z.string(),
  short_label: z.string(),
  period_status: periodStatusSchema,
  partial: z.boolean(),
  cost_brl_display: z.string(),
  height_percent: z.number(),
  segments: z.array(seriesSegmentSchema),
});

const seriesSchema = z.strictObject({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['total', 'agent', 'model']),
  points: z.array(seriesPointSchema),
});

export const billingSeriesResponseSchema = z.strictObject({
  granularity: z.enum(['month', 'day']),
  months: z.array(
    z.strictObject({
      year: z.number().int(),
      month: z.number().int(),
      month_label: z.string(),
      short_label: z.string(),
      period_status: periodStatusSchema,
      partial: z.boolean(),
      total_cost_brl_display: z.string(),
    }),
  ),
  series: z.array(seriesSchema),
});

export type BillingSeriesView = z.infer<typeof billingSeriesResponseSchema>;

/**
 * US12: the estimate, labeled as such, with its basis in plain words.
 * Never persisted; only ever answers for the current month.
 */
export const billingProjectionResponseSchema = z.strictObject({
  year: z.number().int(),
  month: z.number().int(),
  month_label: z.string(),
  is_estimate: z.literal(true),
  insufficient_data: z.boolean(),
  accrued_cost_brl_display: z.string(),
  projected_cost_brl_display: z.string().nullable(),
  complete_days: z.number().int(),
  days_in_month: z.number().int(),
  basis_text: z.string(),
});

export type BillingProjectionView = z.infer<
  typeof billingProjectionResponseSchema
>;
