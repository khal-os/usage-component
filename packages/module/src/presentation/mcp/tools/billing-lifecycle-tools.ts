import { z } from 'zod';
import {
  BillingCloseBlockedError,
  BillingPeriodStateError,
  CloseBillingPeriodUseCase,
} from '@observability/core/domain/useCases/close-billing-period-use-case.js';
import { ReopenBillingPeriodUseCase } from '@observability/core/domain/useCases/reopen-billing-period-use-case.js';
import { clientCalendarOf } from '@observability/core/common/helpers/clock/client-clock.js';
import { formatBrlFromCents } from '@observability/core/common/helpers/money/money.js';
import { formatBrlDisplay } from '@observability/core/common/helpers/display/display.js';
import { BillingSummaryView } from '../../controllers/billing/billing-view-schemas.js';
import { Controller } from '../../interfaces/index.js';
import { callController } from '../controller-tool.js';
import {
  CONFIRMATION_FIELDS,
  ConfirmationCodec,
  ConfirmationField,
  ExpectedConfirmation,
  matchConfirmation,
  mintConfirmation,
  decodeConfirmation,
} from '../confirmation.js';
import { fromConfirmationFailure } from '../confirmation-error.js';
import {
  DESTRUCTIVE_WRITE,
  PREVIEW,
  ToolCaller,
  ToolDefinition,
  WRITE,
  toolFailed,
  toolOk,
} from '../tool-definition.js';
import { toolError } from '../tool-error.js';
import {
  BillRow,
  WriteClock,
  confirmationArg,
  earliestBill,
  findBill,
  hashOf,
  mintedAt,
  periodEtag,
  periodId,
  periodSummarySchema,
  previewEnvelope,
  toPeriodSummary,
} from './write-support.js';
import { monthArgs } from './read-args.js';

/**
 * The month lifecycle through MCP (decision 179): the SAME use cases the
 * operator jobs run, composed per call with trigger 'mcp' and the caller's
 * subject as `actor` — so the period's audit trail says who closed it.
 * There is still no REST mutation endpoint.
 */
export interface LifecycleDependencies {
  readonly listBills: Controller;
  readonly billingSummary: Controller;
  readonly closeForActor: (actor: string) => CloseBillingPeriodUseCase;
  readonly reopenForActor: (actor: string) => ReopenBillingPeriodUseCase;
  readonly codec: ConfirmationCodec;
  readonly clock: WriteClock;
}

const reasonArg = {
  reason: z
    .string()
    .min(3)
    .describe(
      'Why the month is being reopened. Mandatory and audited: it is stored with the period and shown on the statement.',
    ),
};

export const previewClosePeriodSchema = z.strictObject({
  action: z.literal('close_period'),
  period: periodSummarySchema,
  can_close: z.boolean(),
  blockers: z.array(z.string()),
  models_without_price: z.array(z.string()),
  ...previewEnvelope,
});

export const closePeriodResultSchema = z.strictObject({
  year: z.number().int(),
  month: z.number().int(),
  month_label: z.string(),
  snapshot_version: z.number().int(),
  total_cost_brl_display: z.string(),
  stamped_trace_count: z.number().int(),
  ingestion_watermark: z.string().nullable(),
  quarantine: z.strictObject({
    flagged_stragglers: z.number().int(),
    absorbed: z.number().int(),
  }),
  trigger: z.literal('mcp'),
  actor: z.string(),
});

export const previewReopenPeriodSchema = z.strictObject({
  action: z.literal('reopen_period'),
  period: periodSummarySchema,
  can_reopen: z.boolean(),
  blockers: z.array(z.string()),
  reason: z.string(),
  ...previewEnvelope,
});

export const reopenPeriodResultSchema = z.strictObject({
  year: z.number().int(),
  month: z.number().int(),
  month_label: z.string(),
  previous_snapshot_version: z.number().int(),
  next_snapshot_version: z.number().int(),
  reason: z.string(),
  trigger: z.literal('mcp'),
  actor: z.string(),
});

/** The etag is compared AFTER a fresh read, never against what the token claims. */
const FIELDS_BEFORE_READ: readonly ConfirmationField[] =
  CONFIRMATION_FIELDS.filter((field) => field !== 'etag');

const monthOf = (
  args: Record<string, unknown>,
): { year: number; month: number } => ({
  year: Number(args['year']),
  month: Number(args['month']),
});

const isBefore = (
  row: { year: number; month: number },
  target: { year: number; month: number },
): boolean => row.year * 12 + row.month < target.year * 12 + target.month;

const monthHasEnded = (
  target: { year: number; month: number },
  now: Date,
): boolean => {
  const current = clientCalendarOf(now);

  return target.year * 12 + target.month < current.year * 12 + current.month;
};

type BillsRead =
  | { readonly ok: true; readonly bills: BillRow[] }
  | { readonly ok: false; readonly outcome: ReturnType<typeof toolFailed> };

const readBills = async (listBills: Controller): Promise<BillsRead> => {
  const call = await callController(listBills, { query: {} });

  return call.ok
    ? { ok: true, bills: (call.response.body as { bills: BillRow[] }).bills }
    : { ok: false, outcome: toolFailed(call.error) };
};

const modelsWithoutPrice = async (
  summary: Controller,
  year: number,
  month: number,
): Promise<string[]> => {
  const call = await callController(summary, {
    query: { year: String(year), month: String(month) },
  });

  return call.ok
    ? (call.response.body as BillingSummaryView).pending_price.models
    : [];
};

const expectationOf = (
  caller: ToolCaller,
  action: 'close_period' | 'reopen_period',
  year: number,
  month: number,
  etag: string,
  hash: string,
): ExpectedConfirmation => ({
  tenant: caller.tenant,
  subject: caller.subject,
  action,
  kind: 'billing_period',
  id: periodId(year, month),
  etag,
  hash,
});

export const billingLifecycleTools = (
  deps: LifecycleDependencies,
): ToolDefinition[] => [
  {
    name: 'preview_close_billing_period',
    title: 'Preview closing a month',
    description:
      'Explains what closing this month would do and returns a confirmation_token. Writes NOTHING. ' +
      'Closing freezes the month into an immutable, audited snapshot that becomes THE bill — from then on the month is served from that snapshot and never recomputed. ' +
      'It lists every reason the close would be refused: the month has not ended, an older month with executions is still open, executions are waiting for a price (with the models that lack one), or the month is already closed.',
    inputSchema: monthArgs,
    outputSchema: previewClosePeriodSchema,
    annotations: PREVIEW,
    run: async (args, caller) => {
      const { year, month } = monthOf(args);
      const bills = await readBills(deps.listBills);
      if (!bills.ok) return bills.outcome;

      const row = findBill(bills.bills, year, month);
      const blockers: string[] = [];

      // A month BEFORE the archive begins has no row, so every blocker below
      // would skip and the preview would happily mint a token to "close"
      // 2019-03 on a store whose data starts in 2026 — writing a snapshot for
      // a month that never existed, and moving the live-scan anchor with it. A
      // gap month INSIDE the archive stays closable: closing it is how the
      // bound advances past a month that genuinely had no traffic.
      const earliest = earliestBill(bills.bills);

      if (
        row === undefined &&
        earliest &&
        isBefore({ year, month }, earliest)
      ) {
        blockers.push(
          `The archive has no data before ${earliest.month_label} — there is nothing to close in ${periodId(year, month)}.`,
        );
      }

      if (!monthHasEnded({ year, month }, deps.clock.now())) {
        blockers.push(
          `${periodId(year, month)} has not ended yet in the client timezone — only a fully past month can close (a current month is partial by definition).`,
        );
      }

      if (row?.period_status === 'closed') {
        blockers.push(
          `${row.month_label} is already closed (snapshot v${String(row.snapshot_version ?? 0)}). Reopen it first if it has to change.`,
        );
      }

      // Presence in /bills IS the signal, not the trace counts: an execution
      // with a model and zero measured tokens (decision 128,
      // `no_measured_usage`) counts in NEITHER stamped nor pending, so a
      // count-based test called such a month trace-free and the preview
      // promised a close the use case then refused.
      const olderOpen = bills.bills
        .filter(
          (bill) =>
            isBefore(bill, { year, month }) && bill.period_status === 'open',
        )
        .sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month))[0];

      if (olderOpen) {
        blockers.push(
          `${olderOpen.month_label} is open and still has executions of its own — months close oldest first, so close ${periodId(olderOpen.year, olderOpen.month)} before this one.`,
        );
      }

      const pending = row?.pending_trace_count ?? 0;
      const models =
        pending > 0
          ? await modelsWithoutPrice(deps.billingSummary, year, month)
          : [];

      if (pending > 0) {
        blockers.push(
          `${String(pending)} execution(s) of the month are waiting for a price — the bill never silently drops open costs. Register the missing price(s) and let the re-stamp run, then close.`,
        );
      }

      const canClose = blockers.length === 0;
      const token = canClose
        ? mintedAt(
            expectationOf(
              caller,
              'close_period',
              year,
              month,
              periodEtag(row),
              '',
            ),
            deps.clock.now(),
            deps.codec,
            mintConfirmation,
          )
        : { confirmation_token: null, expires_at: null };

      return toolOk({
        action: 'close_period',
        period: toPeriodSummary(row, year, month),
        can_close: canClose,
        blockers,
        models_without_price: models,
        writes_nothing: true,
        warnings: canClose
          ? [
              'Closing is the commitment: the frozen statement becomes the bill, and undoing it means an audited reopen.',
            ]
          : [],
        ...token,
      });
    },
  },
  {
    name: 'close_billing_period',
    title: 'Close the previewed month',
    description:
      'Closes the month the preview showed, through the SAME use case the operator job runs, and records in the period audit that it was closed through MCP by this user. Requires the confirmation_token of a preview of the same month. ' +
      'Refuses when the month changed since the preview (someone else closed or reopened it).',
    inputSchema: { ...monthArgs, ...confirmationArg },
    outputSchema: closePeriodResultSchema,
    annotations: WRITE,
    run: async (args, caller) => {
      const { year, month } = monthOf(args);
      const token =
        typeof args['confirmation_token'] === 'string'
          ? args['confirmation_token']
          : undefined;

      const decoded = decodeConfirmation(token, deps.codec);
      if (!decoded.ok)
        return toolFailed(fromConfirmationFailure(decoded.failure));

      const matched = matchConfirmation(
        decoded.payload,
        expectationOf(
          caller,
          'close_period',
          year,
          month,
          decoded.payload.etag,
          '',
        ),
        deps.clock.now().getTime(),
        FIELDS_BEFORE_READ,
      );
      if (!matched.ok)
        return toolFailed(fromConfirmationFailure(matched.failure));

      const bills = await readBills(deps.listBills);
      if (!bills.ok) return bills.outcome;

      const row = findBill(bills.bills, year, month);
      const currentEtag = periodEtag(row);

      if (currentEtag !== decoded.payload.etag) {
        return toolFailed(
          toolError(
            'STALE_PERIOD',
            `${periodId(year, month)} changed after the preview (${decoded.payload.etag} → ${currentEtag}).`,
            'Someone else closed or reopened this month. Preview again, show the person what the month looks like now, and confirm only then.',
            { current: toPeriodSummary(row, year, month) },
          ),
        );
      }

      try {
        const result = await deps
          .closeForActor(caller.subject)
          .close(year, month);

        return toolOk(
          {
            year: result.year,
            month: result.month,
            month_label: periodId(result.year, result.month),
            snapshot_version: result.snapshotVersion,
            total_cost_brl_display: formatBrlDisplay(
              formatBrlFromCents(result.totalDisplayCents),
            ),
            stamped_trace_count: result.stampedTraceCount,
            ingestion_watermark:
              result.ingestionWatermark?.toISOString() ?? null,
            quarantine: {
              flagged_stragglers: result.quarantine.flaggedStragglers,
              absorbed: result.quarantine.absorbed,
            },
            trigger: 'mcp',
            actor: caller.subject,
          },
          {
            text: `${periodId(result.year, result.month)} closed — snapshot v${String(result.snapshotVersion)}.`,
          },
        );
      } catch (error) {
        if (error instanceof BillingCloseBlockedError) {
          return toolFailed(
            toolError(
              'BLOCKED',
              error.message,
              'Resolve what the message names, then preview and close again.',
              {
                pending_trace_count: error.pendingTraceCount,
                models_without_price: error.modelsWithoutPrice,
              },
            ),
          );
        }

        if (error instanceof BillingPeriodStateError) {
          return toolFailed(
            toolError(
              'INVALID_STATE',
              error.message,
              'Check list_bills for the month status before trying again.',
            ),
          );
        }

        throw error;
      }
    },
  },
  {
    name: 'preview_reopen_billing_period',
    title: 'Preview reopening a closed month',
    description:
      'Explains what reopening this closed month would do and returns a confirmation_token. Writes NOTHING. ' +
      'A reopen is audited with the reason, keeps every snapshot version, makes the month live again and unblocks pricing of its executions; the next close writes the next snapshot version. Reserved for correcting a bill.',
    inputSchema: { ...monthArgs, ...reasonArg },
    outputSchema: previewReopenPeriodSchema,
    annotations: PREVIEW,
    run: async (args, caller) => {
      const { year, month } = monthOf(args);
      const reason = String(args['reason'] ?? '').trim();
      const bills = await readBills(deps.listBills);
      if (!bills.ok) return bills.outcome;

      const row = findBill(bills.bills, year, month);
      const blockers: string[] = [];

      if (row?.period_status !== 'closed') {
        blockers.push(
          `${periodId(year, month)} is not closed — there is nothing to reopen.`,
        );
      }

      if (reason.length < 3) {
        blockers.push('A reason is mandatory: the reopen is audited.');
      }

      const canReopen = blockers.length === 0;
      const token = canReopen
        ? mintedAt(
            expectationOf(
              caller,
              'reopen_period',
              year,
              month,
              periodEtag(row),
              hashOf(deps.codec, reason),
            ),
            deps.clock.now(),
            deps.codec,
            mintConfirmation,
          )
        : { confirmation_token: null, expires_at: null };

      return toolOk({
        action: 'reopen_period',
        period: toPeriodSummary(row, year, month),
        can_reopen: canReopen,
        blockers,
        reason,
        writes_nothing: true,
        warnings: canReopen
          ? [
              `Snapshot v${String(row?.snapshot_version ?? 0)} is preserved; the next close writes v${String((row?.snapshot_version ?? 0) + 1)}. The bill this month already produced stops being the current one.`,
            ]
          : [],
        ...token,
      });
    },
  },
  {
    name: 'reopen_billing_period',
    title: 'Reopen the previewed month',
    description:
      'Reopens the closed month the preview showed, with the SAME audited use case the operator job runs, recording that it was reopened through MCP by this user with this reason. Requires the confirmation_token of a preview of the same month AND the same reason.',
    inputSchema: { ...monthArgs, ...reasonArg, ...confirmationArg },
    outputSchema: reopenPeriodResultSchema,
    annotations: DESTRUCTIVE_WRITE,
    run: async (args, caller) => {
      const { year, month } = monthOf(args);
      const reason = String(args['reason'] ?? '').trim();
      const token =
        typeof args['confirmation_token'] === 'string'
          ? args['confirmation_token']
          : undefined;

      const decoded = decodeConfirmation(token, deps.codec);
      if (!decoded.ok)
        return toolFailed(fromConfirmationFailure(decoded.failure));

      const matched = matchConfirmation(
        decoded.payload,
        expectationOf(
          caller,
          'reopen_period',
          year,
          month,
          decoded.payload.etag,
          hashOf(deps.codec, reason),
        ),
        deps.clock.now().getTime(),
        FIELDS_BEFORE_READ,
      );
      if (!matched.ok)
        return toolFailed(fromConfirmationFailure(matched.failure));

      const bills = await readBills(deps.listBills);
      if (!bills.ok) return bills.outcome;

      const row = findBill(bills.bills, year, month);
      const currentEtag = periodEtag(row);

      if (currentEtag !== decoded.payload.etag) {
        return toolFailed(
          toolError(
            'STALE_PERIOD',
            `${periodId(year, month)} changed after the preview (${decoded.payload.etag} → ${currentEtag}).`,
            'Someone else closed or reopened this month. Preview again and show the person the current state before confirming.',
            { current: toPeriodSummary(row, year, month) },
          ),
        );
      }

      try {
        const result = await deps
          .reopenForActor(caller.subject)
          .reopen(year, month, reason);

        return toolOk(
          {
            year: result.year,
            month: result.month,
            month_label: periodId(result.year, result.month),
            previous_snapshot_version: result.previousSnapshotVersion,
            next_snapshot_version: result.previousSnapshotVersion + 1,
            reason,
            trigger: 'mcp',
            actor: caller.subject,
          },
          {
            text: `${periodId(result.year, result.month)} reopened — snapshot v${String(result.previousSnapshotVersion)} preserved.`,
          },
        );
      } catch (error) {
        if (error instanceof BillingPeriodStateError) {
          return toolFailed(
            toolError(
              'INVALID_STATE',
              error.message,
              'Check list_bills for the month status before trying again.',
            ),
          );
        }

        throw error;
      }
    },
  },
];
