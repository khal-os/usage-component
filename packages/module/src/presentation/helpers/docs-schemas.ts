import { z } from 'zod';
import { TOKEN_TYPES } from '@observability/core/domain/models/price-version-model.js';

/**
 * Shared response-contract schemas. Every response schema in the API is a
 * STRICT object: it is the same whitelist the view-models implement
 * (invariant 4 — internal fields absent by construction), stated once and
 * enforced twice — contract tests parse real responses with these schemas,
 * and the OpenAPI document is generated from them (single source of truth).
 */
export const apiErrorSchema = z.strictObject({
  name: z.string(),
  msg: z.string(),
});

/**
 * GET /health (decision 172) — the platform-wide liveness shape
 * (khal-platform http-kit `healthRoute`): literals, not free strings, so
 * the Catalog Console reads ONE contract across the fleet.
 */
export const healthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  component: z.literal('usage-module'),
});

export const paginatedSchema = <Item extends z.ZodType>(item: Item) =>
  z.strictObject({
    page: z.number().int(),
    page_size: z.number().int(),
    total: z.number().int(),
    total_pages: z.number().int(),
    items: z.array(item),
  });

export const tokenCountsViewSchema = z.strictObject({
  input: z.number().int(),
  output: z.number().int(),
  cache_read: z.number().int(),
  cache_write: z.number().int(),
});

export const executionStatusSchema = z.enum(['ok', 'error']);
export const pricingStatusSchema = z.enum([
  'stamped',
  'pending_price',
  // Decision 128: model present, zero measured tokens — cost unknown,
  // never billed as R$ 0,00, never blocks the close.
  'no_measured_usage',
]);
export const tokenTypeSchema = z.enum(TOKEN_TYPES);
