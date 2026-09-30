import {
  BillingMonthComparison,
  BillingPeriodStatus,
  BillingSummary,
} from '@observability/core/domain/useCases/get-billing-summary-use-case.js';
import { BillListItem } from '@observability/core/domain/useCases/list-bills-use-case.js';
import {
  BillingSeriesDay,
  BillingSeriesMonth,
} from '@observability/core/domain/useCases/get-billing-series-use-case.js';
import {
  BillingProjection,
  PROJECTION_MIN_COMPLETE_DAYS,
} from '@observability/core/domain/useCases/get-billing-projection-use-case.js';
import {
  agentKey,
  StatementAgentModelMix,
  StatementLine,
  StatementModelShare,
  StatementProjection,
} from '@observability/core/domain/models/billing-snapshot-model.js';
import {
  TOKEN_TYPES,
  TokenType,
} from '@observability/core/domain/models/price-version-model.js';
import {
  formatBrlExactFromMicrocents,
  formatBrlFromCents,
  formatBrlFromMicrocents,
  microcentsToDisplayCents,
  reconcileDisplayCents,
} from '@observability/core/common/helpers/money/money.js';
import {
  formatBrlDisplay,
  formatDateTimeDisplay,
  formatIntDisplay,
  formatMonthLabel,
  formatClientDateDisplay,
  formatUtcDateDisplay,
} from '@observability/core/common/helpers/display/display.js';
import { clientUtcOffsetMs } from '@observability/core/common/helpers/clock/client-clock.js';
import {
  BillListView,
  BillingProjectionView,
  BillingSeriesView,
  BillingSummaryView,
} from './billing-view-schemas.js';

const TOKEN_TYPE_LABELS: Record<TokenType, string> = {
  input: 'input',
  output: 'output',
  cache_read: 'cache leitura',
  cache_write: 'cache escrita',
};

/**
 * The wire speaks three statuses; 'future' is INTERNAL (audit B-1): the
 * readers exclude/400/clamp future months upstream, so one reaching a
 * client-facing view is a bug — narrowed here with a throw, never
 * serialized. The response enums stay closed by construction.
 */
type WirePeriodStatus = Exclude<BillingPeriodStatus, 'future'>;

const wirePeriodStatus = (status: BillingPeriodStatus): WirePeriodStatus => {
  if (status === 'future') {
    throw new Error(
      'audit B-1: a FUTURE month must never reach a client-facing view — ' +
        'the billing readers exclude it upstream',
    );
  }

  return status;
};

const STATUS_LABELS: Record<WirePeriodStatus, string> = {
  closed: 'Fechado — final',
  in_progress: 'Em andamento — dados parciais',
  open: 'Aberto — aguardando fechamento',
};

const MONTHS_PT_SHORT = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
];

/** Chart GEOMETRY only (bar widths, donut angles) — never money: R$ values always go through the money helpers. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/** 4325 bp -> "43,25%" (trailing zeros trimmed to keep tables calm: "43,2%" never lies). */
const bpToPercentDisplay = (bp: number): string => {
  const whole = Math.trunc(bp / 100);
  const fraction = bp % 100;

  if (fraction === 0) return `${whole}%`;

  const fractionText = String(fraction).padStart(2, '0').replace(/0$/, '');

  return `${whole},${fractionText}%`;
};

/** One sign/format rule for every signed BRL — the money helpers stay non-negative by contract. */
const signedCentsDisplay = (negative: boolean, cents: number): string =>
  `${negative ? '−' : '+'} ${formatBrlDisplay(formatBrlFromCents(cents))}`;

/** Signed BRL for deltas: the sign comes from the exact µ¢, the magnitude rounds half-up. */
const signedBrlDisplay = (microcents: number): string =>
  signedCentsDisplay(
    microcents < 0,
    microcentsToDisplayCents(Math.abs(microcents)),
  );

/** Signed BRL from already-displayed cents. */
const signedBrlFromCentsDisplay = (cents: number): string =>
  signedCentsDisplay(cents < 0, Math.abs(cents));

/** Delta as percent of the previous value; null when previous is zero. */
const deltaPercentDisplay = (
  delta: number,
  previous: number,
): string | null => {
  if (previous === 0) return null;

  const percentTimes10 = Math.round((Math.abs(delta) / previous) * 1000);
  const whole = Math.trunc(percentTimes10 / 10);
  const tenth = percentTimes10 % 10;
  const sign = delta < 0 ? '−' : '+';
  const body = tenth === 0 ? `${whole}` : `${whole},${tenth}`;

  return `${sign}${body}%`;
};

const direction = (delta: number): 'up' | 'down' | 'flat' =>
  delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';

/** "R$ 25,00 / M tokens" from a µ¢-per-million price. */
const unitPriceDisplay = (priceMicrocentsPerMillion: number): string =>
  `${formatBrlDisplay(formatBrlExactFromMicrocents(priceMicrocentsPerMillion))} / M tokens`;

type LineView = BillingSummaryView['lines'][number];

const toLineView = (line: StatementLine): LineView => ({
  agent_id: line.agentId,
  agent_version: line.agentVersion,
  model: line.model,
  model_label: line.model ?? '(sem modelo)',
  token_type: line.tokenType,
  token_type_label: TOKEN_TYPE_LABELS[line.tokenType],
  tokens: line.tokens,
  tokens_display: formatIntDisplay(line.tokens),
  unit_price_brl_per_million_display: unitPriceDisplay(
    line.appliedPriceMicrocentsPerMillion,
  ),
  unit_price_effective_from_display: formatUtcDateDisplay(
    new Date(line.appliedPriceEffectiveFrom),
  ),
  cost_brl_exact: formatBrlExactFromMicrocents(line.costMicrocents),
  cost_brl_exact_display: formatBrlDisplay(
    formatBrlExactFromMicrocents(line.costMicrocents),
  ),
  cost_brl_display: formatBrlFromCents(line.displayCents),
  cost_brl_display_brl: formatBrlDisplay(formatBrlFromCents(line.displayCents)),
});

/**
 * Agent groups with API-computed bar geometry (decision 51): the most
 * expensive agent's bar spans 100% of the track. Display cents come
 * reconciled FROM THE ENGINE (frozen in snapshots) — groups close with
 * the total exactly, forever (US6).
 */
const toAgentGroupViews = (
  statement: StatementProjection,
): BillingSummaryView['agents'] => {
  const maxCost = statement.agents[0]?.costMicrocents ?? 0;

  return statement.agents.map((group) => ({
    agent_id: group.agentId,
    agent_version: group.agentVersion,
    agent_label: group.agentId ?? '(sem agente)',
    version_label: group.agentVersion ? `v${group.agentVersion}` : null,
    tokens_total: group.tokens,
    tokens_total_display: formatIntDisplay(group.tokens),
    cost_brl_display: formatBrlDisplay(formatBrlFromCents(group.displayCents)),
    percent_of_total_display: bpToPercentDisplay(group.percentOfTotalBp),
    bar_width_percent:
      maxCost > 0 ? round2((group.costMicrocents / maxCost) * 100) : 0,
    segments: TOKEN_TYPES.filter(
      (tokenType) => (group.costByTokenTypeMicrocents[tokenType] ?? 0) > 0,
    ).map((tokenType) => ({
      token_type: tokenType,
      width_percent:
        maxCost > 0
          ? round2(
              ((group.costByTokenTypeMicrocents[tokenType] ?? 0) / maxCost) *
                100,
            )
          : 0,
      label: `${TOKEN_TYPE_LABELS[tokenType]} · ${formatBrlDisplay(
        formatBrlExactFromMicrocents(
          group.costByTokenTypeMicrocents[tokenType] ?? 0,
        ),
      )}`,
    })),
    lines: statement.lines
      .filter(
        (line) =>
          line.agentId === group.agentId &&
          line.agentVersion === group.agentVersion,
      )
      .map(toLineView),
  }));
};

/**
 * The agent share donut (pedido do Matheus, 31/07): ONE chart, each
 * agent's slice of the month cost. Versions merge (the per-version detail
 * stays in the breakdown table); shares are the engine's reconciled basis
 * points summed per agent — integer bp, so the slices still close at
 * exactly 100%.
 */
const toAgentMixViews = (
  statement: StatementProjection,
): BillingSummaryView['agent_mix'] => {
  // Merged on the agent ID (string | null) — the label exists only at
  // render time, so a real agent literally named '(sem agente)' never
  // merges with unattributed traffic.
  const merged = new Map<
    string | null,
    { displayCents: number; shareBp: number; costMicrocents: number }
  >();

  for (const group of statement.agents) {
    let entry = merged.get(group.agentId);

    if (!entry) {
      entry = { displayCents: 0, shareBp: 0, costMicrocents: 0 };
      merged.set(group.agentId, entry);
    }

    entry.displayCents += group.displayCents;
    entry.shareBp += group.percentOfTotalBp;
    entry.costMicrocents += group.costMicrocents;
  }

  let accumulatedBp = 0;

  return [...merged.entries()]
    .sort((a, b) => b[1].costMicrocents - a[1].costMicrocents)
    .map(([agentId, entry]) => {
      const start = accumulatedBp;
      accumulatedBp += entry.shareBp;

      return {
        agent_label: agentId ?? '(sem agente)',
        cost_brl_display: formatBrlDisplay(
          formatBrlFromCents(entry.displayCents),
        ),
        cost_share_percent_display: bpToPercentDisplay(entry.shareBp),
        donut_start_percent: round2(start / 100),
        donut_end_percent: round2(accumulatedBp / 100),
      };
    });
};

/**
 * Donut slices: cumulative start/end percents — the UI paints, never sums.
 * `partsCents` are the displayed cents per share, decided by the CALLER:
 * the totals donut reconciles against the statement total; the per-agent
 * mixes sum the engine's already-reconciled line cents (B-9) — never an
 * independent re-reconciliation that could contradict the agent card.
 */
const toModelShareViews = (
  shares: StatementModelShare[],
  partsCents: number[],
): BillingSummaryView['model_mix']['total'] => {
  let accumulatedBp = 0;

  return shares.map((share, index) => {
    const start = accumulatedBp;
    accumulatedBp += share.costShareBp;

    return {
      model: share.model,
      model_label: share.model ?? '(sem modelo)',
      cost_brl_display: formatBrlDisplay(
        formatBrlFromCents(partsCents[index] as number),
      ),
      cost_share_percent_display: bpToPercentDisplay(share.costShareBp),
      token_share_percent_display: bpToPercentDisplay(share.tokenShareBp),
      donut_start_percent: round2(start / 100),
      donut_end_percent: round2(accumulatedBp / 100),
    };
  });
};

/**
 * The totals donut: its target IS the displayed statement total, so the
 * model parts are largest-remainder reconciled against it (T5) —
 * independent per-model rounding once drifted a cent against the agent
 * donut.
 */
const toModelMixTotalViews = (
  shares: StatementModelShare[],
): BillingSummaryView['model_mix']['total'] =>
  toModelShareViews(
    shares,
    reconcileDisplayCents(shares.map((share) => share.costMicrocents))
      .partsCents,
  );

/**
 * Per-agent model cents (B-9): SUMS of the engine's already-reconciled
 * `line.displayCents` per agent × model — they close with the agent card
 * and with the statement total by construction. Re-reconciling the
 * agent's µ¢ independently once contradicted the agent's own card by one
 * cent in the half-cent case.
 */
const agentModelDisplayCents = (
  statement: StatementProjection,
  mix: StatementAgentModelMix,
): number[] => {
  const byModel = new Map<string | null, number>();
  const key = agentKey(mix.agentId, mix.agentVersion);

  for (const line of statement.lines) {
    // agentKey, not a hand-spelled field pair (audit B-3): one home for
    // the grouping rule.
    if (agentKey(line.agentId, line.agentVersion) !== key) {
      continue;
    }

    byModel.set(line.model, (byModel.get(line.model) ?? 0) + line.displayCents);
  }

  return mix.models.map((share) => byModel.get(share.model) ?? 0);
};

const toCacheSavingsView = (
  statement: StatementProjection,
): BillingSummaryView['cache_savings'] => {
  const cache = statement.cacheSavings;

  // Month aggregates are totals, so they get display rounding (T5), and the
  // panel shows its own arithmetic ("diferença entre os dois acima", "bruta
  // menos a gravação"). The three measured values round once; the two derived
  // ones come from those displayed cents, so the on-screen sums always close.
  const actualCents = microcentsToDisplayCents(
    cache.actualCacheReadCostMicrocents,
  );
  const counterfactualCents = microcentsToDisplayCents(
    cache.counterfactualInputCostMicrocents,
  );
  const writeCents = microcentsToDisplayCents(cache.cacheWriteCostMicrocents);
  const savingsCents = counterfactualCents - actualCents;
  const netSavingsCents = savingsCents - writeCents;

  return {
    cache_read_tokens: cache.cacheReadTokens,
    cache_read_tokens_display: formatIntDisplay(cache.cacheReadTokens),
    actual_cache_read_cost_brl_display: formatBrlDisplay(
      formatBrlFromCents(actualCents),
    ),
    counterfactual_input_cost_brl_display: formatBrlDisplay(
      formatBrlFromCents(counterfactualCents),
    ),
    savings_brl_display: signedBrlFromCentsDisplay(savingsCents),
    cache_write_cost_brl_display: formatBrlDisplay(
      formatBrlFromCents(writeCents),
    ),
    net_savings_brl_display: signedBrlFromCentsDisplay(netSavingsCents),
    net_positive: netSavingsCents >= 0,
    unpriceable_cache_read_traces: cache.unpriceableCacheReadTraces,
    basis_text:
      'Contrafactual: cada leitura de cache cobrada como se fosse input ' +
      'normal, ao preço contratado de input do próprio trace. Escrita de ' +
      'cache é custo real, mostrada à parte e descontada no líquido.',
  };
};

const toComparisonView = (
  comparison: BillingMonthComparison | null,
): BillingSummaryView['comparison'] => {
  if (!comparison) return null;

  return {
    previous_month_label: formatMonthLabel(
      comparison.previousYear,
      comparison.previousMonth,
    ),
    previous_period_status: wirePeriodStatus(comparison.previousPeriodStatus),
    previous_partial: comparison.previousPeriodStatus === 'in_progress',
    previous_total_cost_brl_display: formatBrlDisplay(
      formatBrlFromMicrocents(comparison.previousTotalCostMicrocents),
    ),
    delta_brl_display: signedBrlDisplay(comparison.totalDeltaMicrocents),
    delta_percent_display: deltaPercentDisplay(
      comparison.totalDeltaMicrocents,
      comparison.previousTotalCostMicrocents,
    ),
    direction: direction(comparison.totalDeltaMicrocents),
    by_agent: comparison.byAgent.map((agent) => ({
      agent_label: agent.agentId ?? '(sem agente)',
      version_label: agent.agentVersion ? `v${agent.agentVersion}` : null,
      current_cost_brl_display: formatBrlDisplay(
        formatBrlFromMicrocents(agent.currentCostMicrocents),
      ),
      previous_cost_brl_display: formatBrlDisplay(
        formatBrlFromMicrocents(agent.previousCostMicrocents),
      ),
      delta_brl_display: signedBrlDisplay(agent.deltaMicrocents),
      delta_percent_display: deltaPercentDisplay(
        agent.deltaMicrocents,
        agent.previousCostMicrocents,
      ),
      direction: direction(agent.deltaMicrocents),
    })),
  };
};

/**
 * Whitelist projection, R$ only by construction (invariant 4) — internal
 * fields and µ¢ integers never leave the API.
 *
 * Display rule (T5): each line keeps its exact cost; displayed cents come
 * reconciled from the engine (largest remainder), so the displayed parts
 * sum EXACTLY to the displayed total. Pending traces are reported apart —
 * the total never silently absorbs them as R$ 0 (invariant 2).
 */
export const toBillingSummaryView = (
  summary: BillingSummary,
): BillingSummaryView => {
  const { statement } = summary;

  const pendingTokensTotal =
    (summary.pendingPrice.tokens.input ?? 0) +
    (summary.pendingPrice.tokens.output ?? 0) +
    (summary.pendingPrice.tokens.cache_read ?? 0) +
    (summary.pendingPrice.tokens.cache_write ?? 0);

  return {
    year: summary.year,
    month: summary.month,
    month_label: formatMonthLabel(summary.year, summary.month),
    period_status: wirePeriodStatus(summary.periodStatus),
    partial: summary.periodStatus === 'in_progress',
    final: summary.periodStatus === 'closed',
    status_label: STATUS_LABELS[wirePeriodStatus(summary.periodStatus)],
    watermark_display: summary.ingestionWatermark
      ? `dados até ${formatDateTimeDisplay(new Date(summary.ingestionWatermark))}`
      : null,
    closed_at_display: summary.closedAt
      ? formatDateTimeDisplay(new Date(summary.closedAt))
      : null,
    snapshot_version: summary.snapshotVersion ?? null,
    snapshot_versions: (summary.snapshotVersions ?? []).map((version) => ({
      version: version.version,
      created_at_display: formatDateTimeDisplay(new Date(version.createdAt)),
    })),
    reopen_notes: [...summary.reopenNotes]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .map((note) => ({
        at_display: formatDateTimeDisplay(new Date(note.at)),
        reason: note.reason,
      })),
    quarantined_trace_count: summary.quarantinedTraceCount,
    no_measured_usage_trace_count: summary.noMeasuredUsageTraceCount,
    total_cost_brl: formatBrlFromCents(statement.totalDisplayCents),
    total_cost_brl_display: formatBrlDisplay(
      formatBrlFromCents(statement.totalDisplayCents),
    ),
    stamped_trace_count: statement.stampedTraceCount,
    stamped_tokens_total: statement.stampedTokensTotal,
    stamped_tokens_total_display: formatIntDisplay(
      statement.stampedTokensTotal,
    ),
    agent_count: statement.agents.length,
    model_count: new Set(
      statement.lines.map((line) => line.model).filter(Boolean),
    ).size,
    lines: statement.lines.map(toLineView),
    agents: toAgentGroupViews(statement),
    agent_mix: toAgentMixViews(statement),
    model_mix: {
      total: toModelMixTotalViews(statement.modelMixTotal),
      by_agent: statement.modelMixByAgent.map((mix) => ({
        agent_label: mix.agentId ?? '(sem agente)',
        version_label: mix.agentVersion ? `v${mix.agentVersion}` : null,
        blended_price_brl_per_million_display:
          mix.blendedPricePerMillionMicrocents !== null
            ? unitPriceDisplay(mix.blendedPricePerMillionMicrocents)
            : null,
        models: toModelShareViews(
          mix.models,
          agentModelDisplayCents(statement, mix),
        ),
      })),
    },
    cache_savings: toCacheSavingsView(statement),
    comparison: toComparisonView(summary.comparison),
    pending_price: {
      trace_count: summary.pendingPrice.traceCount,
      tokens: {
        input: summary.pendingPrice.tokens.input ?? 0,
        output: summary.pendingPrice.tokens.output ?? 0,
        cache_read: summary.pendingPrice.tokens.cache_read ?? 0,
        cache_write: summary.pendingPrice.tokens.cache_write ?? 0,
      },
      tokens_total: pendingTokensTotal,
      tokens_total_display: formatIntDisplay(pendingTokensTotal),
      models: summary.pendingPrice.models,
      models_label: summary.pendingPrice.models.join(', '),
    },
  };
};

/** Same whitelist discipline as the summary: R$ only, display rounding half-up. */
export const toBillListView = (bills: BillListItem[]): BillListView => ({
  bills: bills.map((bill) => ({
    year: bill.year,
    month: bill.month,
    month_label: formatMonthLabel(bill.year, bill.month),
    period_status: wirePeriodStatus(bill.periodStatus),
    partial: bill.periodStatus === 'in_progress',
    final: bill.periodStatus === 'closed',
    status_label: STATUS_LABELS[wirePeriodStatus(bill.periodStatus)],
    closed_at_display: bill.closedAt
      ? formatDateTimeDisplay(new Date(bill.closedAt))
      : null,
    snapshot_version: bill.snapshotVersion ?? null,
    quarantined_trace_count: bill.quarantinedTraceCount,
    total_cost_brl: formatBrlFromMicrocents(bill.totalCostMicrocents),
    total_cost_brl_display: formatBrlDisplay(
      formatBrlFromMicrocents(bill.totalCostMicrocents),
    ),
    stamped_trace_count: bill.stampedTraceCount,
    pending_trace_count: bill.pendingTraceCount,
    tokens: bill.tokens,
    tokens_display: formatIntDisplay(bill.tokens),
    stamped_tokens: bill.stampedTokens,
    stamped_tokens_display: formatIntDisplay(bill.stampedTokens),
  })),
});

const shortMonthLabel = (year: number, month: number): string =>
  `${MONTHS_PT_SHORT[month - 1]}/${String(year).slice(2)}`;

/**
 * Stacked-bar geometry (decision 97): segments in statement-line order,
 * each with its share OF THE BAR — the UI stacks them bottom-up inside a
 * bar whose height is the point's `height_percent` of the chart.
 */
const toSegments = (
  byTokenType: { tokenType: TokenType; costMicrocents: number }[],
  totalCostMicrocents: number,
): BillingSeriesView['series'][number]['points'][number]['segments'] =>
  TOKEN_TYPES.flatMap((tokenType) => {
    const entry = byTokenType.find(
      (candidate) => candidate.tokenType === tokenType,
    );

    if (!entry || entry.costMicrocents <= 0 || totalCostMicrocents <= 0) {
      return [];
    }

    return [
      {
        token_type: tokenType,
        stack_percent: round2(
          (entry.costMicrocents / totalCostMicrocents) * 100,
        ),
        label: `${TOKEN_TYPE_LABELS[tokenType]} · ${formatBrlDisplay(
          formatBrlExactFromMicrocents(entry.costMicrocents),
        )}`,
      },
    ];
  });

/**
 * US11: one shared scale — every series' heights are percents of the
 * tallest bar in the response, so toggling total/agent/model series never
 * re-scales the chart (small agents honestly look small).
 */
export const toBillingSeriesView = (
  months: BillingSeriesMonth[],
): BillingSeriesView => {
  const maxTotal = Math.max(
    0,
    ...months.map((month) => month.totalCostMicrocents),
  );

  const heightOf = (costMicrocents: number): number =>
    maxTotal > 0 ? round2((costMicrocents / maxTotal) * 100) : 0;

  const pointBase = (month: BillingSeriesMonth) => ({
    year: month.year,
    month: month.month,
    month_label: formatMonthLabel(month.year, month.month),
    short_label: shortMonthLabel(month.year, month.month),
    period_status: wirePeriodStatus(month.periodStatus),
    partial: month.periodStatus === 'in_progress',
  });

  const totalSeries = {
    key: 'total',
    label: 'Total',
    kind: 'total' as const,
    points: months.map((month) => ({
      ...pointBase(month),
      cost_brl_display: formatBrlDisplay(
        formatBrlFromMicrocents(month.totalCostMicrocents),
      ),
      height_percent: heightOf(month.totalCostMicrocents),
      segments: toSegments(month.byTokenType, month.totalCostMicrocents),
    })),
  };

  const agentIds = new Map<string | null, number>();
  const modelIds = new Map<string | null, number>();

  for (const month of months) {
    for (const agent of month.byAgent) {
      agentIds.set(
        agent.agentId,
        (agentIds.get(agent.agentId) ?? 0) + agent.costMicrocents,
      );
    }
    for (const model of month.byModel) {
      modelIds.set(
        model.model,
        (modelIds.get(model.model) ?? 0) + model.costMicrocents,
      );
    }
  }

  const seriesOf = (
    kind: 'agent' | 'model',
    id: string | null,
  ): BillingSeriesView['series'][number] => ({
    key: `${kind}:${id ?? '(nulo)'}`,
    label: id ?? (kind === 'agent' ? '(sem agente)' : '(sem modelo)'),
    kind,
    points: months.map((month) => {
      const entry =
        kind === 'agent'
          ? month.byAgent.find((agent) => agent.agentId === id)
          : month.byModel.find((model) => model.model === id);
      const cost = entry?.costMicrocents ?? 0;

      return {
        ...pointBase(month),
        cost_brl_display: formatBrlDisplay(formatBrlFromMicrocents(cost)),
        height_percent: heightOf(cost),
        segments: toSegments(entry?.byTokenType ?? [], cost),
      };
    }),
  });

  const byCostDesc = (a: [string | null, number], b: [string | null, number]) =>
    b[1] - a[1];

  return {
    granularity: 'month',
    months: months.map((month) => ({
      ...pointBase(month),
      total_cost_brl_display: formatBrlDisplay(
        formatBrlFromMicrocents(month.totalCostMicrocents),
      ),
    })),
    series: [
      totalSeries,
      ...[...agentIds.entries()]
        .sort(byCostDesc)
        .map(([agentId]) => seriesOf('agent', agentId)),
      ...[...modelIds.entries()]
        .sort(byCostDesc)
        .map(([model]) => seriesOf('model', model)),
    ],
  };
};

/** The daily lens (decision 97): total series only, same stacked geometry. */
export const toBillingDailySeriesView = (
  days: BillingSeriesDay[],
): BillingSeriesView => {
  const maxTotal = Math.max(0, ...days.map((day) => day.totalCostMicrocents));

  return {
    granularity: 'day',
    months: [],
    series: [
      {
        key: 'total',
        label: 'Total',
        kind: 'total',
        points: days.map((day) => {
          // $dateTrunc returns the client-midnight INSTANT (decision 130);
          // shifting by the zone offset recovers the calendar day it names
          // (raw getUTC* would drift for zones east of UTC).
          const instant = new Date(day.date);
          const date = new Date(instant.getTime() + clientUtcOffsetMs(instant));

          return {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            month_label: formatClientDateDisplay(instant),
            short_label: `${String(date.getUTCDate()).padStart(2, '0')}/${String(
              date.getUTCMonth() + 1,
            ).padStart(2, '0')}`,
            period_status: wirePeriodStatus(day.periodStatus),
            partial: day.partial,
            cost_brl_display: formatBrlDisplay(
              formatBrlFromMicrocents(day.totalCostMicrocents),
            ),
            height_percent:
              maxTotal > 0
                ? round2((day.totalCostMicrocents / maxTotal) * 100)
                : 0,
            segments: toSegments(day.byTokenType, day.totalCostMicrocents),
          };
        }),
      },
    ],
  };
};

export const toBillingProjectionView = (
  projection: BillingProjection,
): BillingProjectionView => ({
  year: projection.year,
  month: projection.month,
  month_label: formatMonthLabel(projection.year, projection.month),
  is_estimate: true,
  insufficient_data: projection.insufficientData,
  accrued_cost_brl_display: formatBrlDisplay(
    formatBrlFromMicrocents(projection.accruedCostMicrocents),
  ),
  projected_cost_brl_display:
    projection.projectedCostMicrocents !== null
      ? formatBrlDisplay(
          formatBrlFromMicrocents(projection.projectedCostMicrocents),
        )
      : null,
  complete_days: projection.completeDays,
  days_in_month: projection.daysInMonth,
  basis_text: projection.insufficientData
    ? `Dados insuficientes: só ${projection.completeDays} dia(s) completo(s) ` +
      `no mês — a projeção aparece a partir de ` +
      `${PROJECTION_MIN_COMPLETE_DAYS} dias completos.`
    : `Conta simples: os ${projection.completeDays} dias completos custaram ` +
      `${formatBrlDisplay(formatBrlFromMicrocents(projection.accruedCostMicrocents))}; ` +
      `dividido por ${projection.completeDays} e multiplicado pelos ` +
      `${projection.daysInMonth} dias do mês. Estimativa — não é fatura.`,
});
