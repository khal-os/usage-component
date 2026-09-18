import { z } from 'zod';
import {
  billListResponseSchema,
  billingProjectionResponseSchema,
  billingSeriesResponseSchema,
  billingSummaryResponseSchema,
} from '../../controllers/billing/billing-view-schemas.js';
import { seriesQueryShape } from '../../controllers/billing/get-billing-series-controller.js';
import { statementQueryShape } from '../../controllers/billing/export-statement-controller.js';
import { yearMonthQueryShape } from '../../helpers/query-validation.js';
import { Controller } from '../../interfaces/index.js';
import { callController, jsonFromController } from '../controller-tool.js';
import { toQuery } from '../query-args.js';
import {
  READ_ONLY,
  ToolDefinition,
  toolFailed,
  toolOk,
} from '../tool-definition.js';
import { monthArgs, seriesArgs, statementArgs } from './read-args.js';

export const BILLING_QUERY_SHAPES = {
  list_bills: {},
  get_billing_summary: yearMonthQueryShape,
  get_billing_series: seriesQueryShape,
  get_billing_projection: {},
  export_statement: statementQueryShape,
} as const;

export interface BillingControllers {
  readonly listBills: Controller;
  readonly billingSummary: Controller;
  readonly billingSeries: Controller;
  readonly billingProjection: Controller;
  readonly statement: Controller;
}

const MEDIA_TYPES = { csv: 'text/csv', html: 'text/html' } as const;

export const exportStatementResultSchema = z.strictObject({
  year: z.number().int(),
  month: z.number().int(),
  format: z.enum(['csv', 'html']),
  media_type: z.string(),
  filename: z.string(),
  /** The uri of the document returned alongside this result. */
  uri: z.string(),
});

/** `attachment; filename="extrato-2026-06.csv"` → the name, when the route sent one. */
const filenameFromHeaders = (
  headers: Record<string, string> | undefined,
  fallback: string,
): string =>
  headers?.['Content-Disposition']?.match(/filename="([^"]+)"/)?.[1] ??
  fallback;

export const billingTools = (
  controllers: BillingControllers,
): ToolDefinition[] => [
  {
    name: 'list_bills',
    title: 'List the months and their bills',
    description:
      'One row per calendar month in the client timezone, most recent first. Status: closed means final and served from the frozen snapshot; in_progress is the current month and is partial; open is a past month still waiting to be closed. ' +
      'The total is the sum of the stamped costs (open) or the frozen number of the snapshot (closed); executions without a price are counted apart, never inside the total. Start here to know what exists.',
    inputSchema: {},
    outputSchema: billListResponseSchema,
    annotations: READ_ONLY,
    run: async () => jsonFromController(controllers.listBills, { query: {} }),
  },
  {
    name: 'get_billing_summary',
    title: 'Statement of one month',
    description:
      'The month statement: total, share per agent, drill-down lines (agent x version x model x token type x applied price — a price change inside the month yields separate lines), model mix, cache savings, comparison with the previous month, data watermark and audited reopen notes. ' +
      'A CLOSED month is served exclusively from its snapshot and never recomputed; an open month is computed live by the SAME engine over the same stamps. Displayed parts add up exactly to the displayed total.',
    inputSchema: monthArgs,
    outputSchema: billingSummaryResponseSchema,
    annotations: READ_ONLY,
    run: async (args) =>
      jsonFromController(controllers.billingSummary, { query: toQuery(args) }),
  },
  {
    name: 'get_billing_series',
    title: 'Cost over time',
    description:
      'Ready-to-plot series: monthly history (up to 24 months) or the last days (up to 90, today included and marked partial), split by token type, agent and model. ' +
      'Pass the window size that belongs to the granularity — `months` with granularity month, `days` with granularity day. The other one is refused, not ignored.',
    inputSchema: seriesArgs,
    outputSchema: billingSeriesResponseSchema,
    annotations: READ_ONLY,
    run: async (args) =>
      jsonFromController(controllers.billingSeries, { query: toQuery(args) }),
  },
  {
    name: 'get_billing_projection',
    title: 'Run-rate estimate of the current month',
    description:
      'What the current month is heading for, from the days already complete. An ESTIMATE and labeled as one — never persisted, never a bill. With fewer than three complete days it answers insufficient_data instead of a number.',
    inputSchema: {},
    outputSchema: billingProjectionResponseSchema,
    annotations: READ_ONLY,
    run: async () =>
      jsonFromController(controllers.billingProjection, { query: {} }),
  },
  {
    name: 'export_statement',
    title: 'Export the statement as a file',
    description:
      'The month statement as a document: csv with the drill-down lines (opens in a spreadsheet) or a standalone printable html page. The document comes back as an embedded resource — hand it to the user verbatim. ' +
      'A month still in progress is watermarked PARCIAL inside the document; check get_billing_summary for the period status before presenting it as final.',
    inputSchema: statementArgs,
    outputSchema: exportStatementResultSchema,
    annotations: READ_ONLY,
    run: async (args) => {
      const format = args['format'] === 'html' ? 'html' : 'csv';
      const call = await callController(controllers.statement, {
        query: toQuery(args),
      });

      if (!call.ok) return toolFailed(call.error);

      const year = Number(args['year']);
      const month = Number(args['month']);
      const stem = `extrato-${String(year)}-${String(month).padStart(2, '0')}`;
      const filename = filenameFromHeaders(
        call.response.headers,
        `${stem}.${format}`,
      );
      const uri = `usage://statement/${filename}`;
      // The csv body carries a UTF-8 BOM for spreadsheets; an embedded
      // resource is text the client renders, so it leaves here without it.
      const text = String(call.response.body).replace(/^\uFEFF/, '');

      return toolOk(
        {
          year,
          month,
          format,
          media_type: MEDIA_TYPES[format],
          filename,
          uri,
        },
        {
          text: `Statement ${stem} exported as ${format} (${filename}).`,
          document: { uri, mimeType: MEDIA_TYPES[format], text },
        },
      );
    },
  },
];
