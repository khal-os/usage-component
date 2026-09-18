import { z } from 'zod';
import { billListItemSchema } from '../../controllers/billing/billing-view-schemas.js';
import {
  ConfirmationCodec,
  ConfirmationPayload,
  canonicalJson,
} from '../confirmation.js';

/** Ten minutes: long enough for a person to read a preview, short enough to be a window. */
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

export interface WriteClock {
  now(): Date;
}

export const systemClock: WriteClock = { now: () => new Date() };

export const confirmationArg = {
  confirmation_token: z
    .string()
    .min(1)
    .describe(
      'The confirmation_token returned by this action preview. Pass it verbatim; it is bound to the exact request the preview showed and expires in ten minutes.',
    ),
};

/** Every preview answers the same three things: what, that it wrote nothing, and the window. */
export const previewEnvelope = {
  writes_nothing: z.literal(true),
  confirmation_token: z.string().nullable(),
  expires_at: z.string().nullable(),
  warnings: z.array(z.string()),
};

export const mintedAt = (
  payload: Omit<ConfirmationPayload, 'expiresAtMs'>,
  now: Date,
  codec: ConfirmationCodec,
  mint: (payload: ConfirmationPayload, codec: ConfirmationCodec) => string,
): { confirmation_token: string; expires_at: string } => {
  const expiresAtMs = now.getTime() + CONFIRMATION_TTL_MS;

  return {
    confirmation_token: mint({ ...payload, expiresAtMs }, codec),
    expires_at: new Date(expiresAtMs).toISOString(),
  };
};

export const hashOf = (codec: ConfirmationCodec, value: unknown): string =>
  codec.sha256(canonicalJson(value));

export type BillRow = z.infer<typeof billListItemSchema>;

export const periodId = (year: number, month: number): string =>
  `${String(year)}-${String(month).padStart(2, '0')}`;

/**
 * The optimistic-lock stamp of a month — the same job `If-Match` does for a
 * manifest: a close previewed against an open month must refuse to run once
 * someone else closed it, and a reopen must refuse once the month was
 * re-closed.
 *
 * It covers the NUMBERS the preview showed, not just the lifecycle state, for
 * two reasons. `/bills` reports `snapshot_version` only while a month is
 * CLOSED, so a close → reopen cycle lands back on `open:v0` and a state-only
 * stamp would let a stale token through. And a total that moved between
 * preview and confirm (a straggler arriving in an open month) is exactly when
 * the person who approved "freeze R$ X" has to look again — closing is the
 * commitment, so the stamp is deliberately strict.
 */
export const periodEtag = (row: BillRow | undefined): string =>
  row === undefined
    ? 'absent:v0'
    : [
        row.period_status,
        `v${String(row.snapshot_version ?? 0)}`,
        row.total_cost_brl,
        `t${String(row.stamped_trace_count)}`,
        `p${String(row.pending_trace_count)}`,
      ].join(':');

/** The oldest month the archive knows about — the floor of what can be closed. */
export const earliestBill = (bills: readonly BillRow[]): BillRow | undefined =>
  [...bills].sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month))[0];

export const findBill = (
  bills: readonly BillRow[],
  year: number,
  month: number,
): BillRow | undefined =>
  bills.find((bill) => bill.year === year && bill.month === month);

export const periodSummarySchema = z.strictObject({
  year: z.number().int(),
  month: z.number().int(),
  month_label: z.string(),
  period_status: z.string(),
  snapshot_version: z.number().int().nullable(),
  total_cost_brl_display: z.string(),
  stamped_trace_count: z.number().int(),
  pending_trace_count: z.number().int(),
  quarantined_trace_count: z.number().int(),
});

export const toPeriodSummary = (
  row: BillRow | undefined,
  year: number,
  month: number,
): z.infer<typeof periodSummarySchema> =>
  row === undefined
    ? {
        year,
        month,
        month_label: periodId(year, month),
        period_status: 'absent',
        snapshot_version: null,
        total_cost_brl_display: 'R$ 0,00',
        stamped_trace_count: 0,
        pending_trace_count: 0,
        quarantined_trace_count: 0,
      }
    : {
        year: row.year,
        month: row.month,
        month_label: row.month_label,
        period_status: row.period_status,
        snapshot_version: row.snapshot_version,
        total_cost_brl_display: row.total_cost_brl_display,
        stamped_trace_count: row.stamped_trace_count,
        pending_trace_count: row.pending_trace_count,
        quarantined_trace_count: row.quarantined_trace_count,
      };
