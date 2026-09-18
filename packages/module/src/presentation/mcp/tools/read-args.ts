import { z } from 'zod';
import { TOKEN_TYPES } from '@observability/core/domain/models/price-version-model.js';

/**
 * Tool arguments in the types JSON actually has (a page is the number 2, a
 * flag is a boolean), described for a reader that has never seen this API.
 * `query-args.ts` turns them back into the query strings the controllers
 * validate, so these shapes name the SAME parameters as the HTTP routes and
 * nothing more — an unknown one is refused by the controller, not ignored.
 */
const isoInstant =
  'ISO date (2026-06-01) or a datetime CARRYING its offset (2026-06-01T00:00:00Z). A timezone-less datetime is refused.';

export const periodArgs = {
  from: z
    .string()
    .optional()
    .describe(`Start of the period, inclusive. ${isoInstant}`),
  to: z
    .string()
    .optional()
    .describe(`End of the period, exclusive. ${isoInstant}`),
};

export const paginationArgs = {
  page: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Page number, 1-based. Default 1.'),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Items per page, at most 100. Default 20.'),
};

export const traceFilterArgs = {
  ...periodArgs,
  agent: z
    .array(z.string().min(1))
    .optional()
    .describe('Agent ids. Several values mean OR; different fields mean AND.'),
  status: z
    .enum(['ok', 'error'])
    .optional()
    .describe('Execution status: error means at least one span failed.'),
  type: z.array(z.string().min(1)).optional().describe('Trace types (OR).'),
  channel: z
    .array(z.string().min(1))
    .optional()
    .describe('Channel types the execution arrived through (OR).'),
  domain: z
    .array(z.string().min(1))
    .optional()
    .describe('Domains, exact match (OR).'),
  subdomain: z
    .array(z.string().min(1))
    .optional()
    .describe('Subdomains, exact match (OR).'),
  search: z
    .string()
    .min(1)
    .optional()
    .describe('Exact match on a trace id OR a session id.'),
  quarantined: z
    .boolean()
    .optional()
    .describe(
      'true lists only the executions that arrived after their month closed and are still unresolved (the count a bill reports); false lists everything else.',
    ),
};

export const sessionFilterArgs = {
  ...periodArgs,
  agent: z.string().min(1).optional().describe('Agent id of the session.'),
  status: z
    .enum(['ok', 'error'])
    .optional()
    .describe('error when ANY execution of the session failed.'),
};

export const monthArgs = {
  year: z
    .number()
    .int()
    .min(1970)
    .max(9999)
    .describe('Calendar year, e.g. 2026.'),
  month: z.number().int().min(1).max(12).describe('Calendar month, 1-12.'),
};

export const idArg = (what: string) => ({
  id: z.string().min(1).describe(`Id of the ${what}.`),
});

export const seriesArgs = {
  granularity: z
    .enum(['month', 'day'])
    .optional()
    .describe(
      'month (default) walks whole months; day walks the last days, today included. Each window size belongs to ITS granularity — see months and days.',
    ),
  months: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe(
      'How many months, up to 24. ONLY with granularity month (the default); sending it with granularity day is refused rather than ignored, because a silently dropped window would answer a different question than the one asked. Default 12.',
    ),
  days: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .describe(
      'How many days, up to 90. ONLY with granularity day; sending it with granularity month is refused rather than ignored. Default 30.',
    ),
};

export const statementArgs = {
  ...monthArgs,
  format: z
    .enum(['csv', 'html'])
    .optional()
    .describe(
      'csv (default) for the drill-down lines; html for a printable page.',
    ),
};

export const priceFilterArgs = {
  model: z
    .string()
    .min(1)
    .optional()
    .describe('Filter by model key, e.g. openai/gpt-5-mini.'),
  token_type: z.enum(TOKEN_TYPES).optional().describe('Filter by token type.'),
};
