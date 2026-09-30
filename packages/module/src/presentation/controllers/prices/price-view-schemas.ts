import { z } from 'zod';
import { tokenTypeSchema } from '../../helpers/docs-schemas.js';
import { brlToMicrocents } from '@observability/core/common/helpers/money/money.js';
import { isoDateRule } from '@observability/core/common/helpers/iso-date-rule.js';

const convertsToMicrocents = (value: string): boolean => {
  try {
    brlToMicrocents(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Request contract of POST /prices (T4 write). STRICT on purpose: a typoed
 * optional key silently ignored is how a wrong price gets registered —
 * unknown fields are a 400, not a shrug. R$ only by construction
 * (invariant 4). Registration always declares a fixed R$ price
 * ('fixed_brl' — decision 96); a future computed pricing type (e.g.
 * USD × PTAX × markup) arrives as a NEW contract with its own declared
 * inputs, never as extra optional fields here.
 *
 * Money arrives as a DECIMAL STRING (never a JSON float — the same "never
 * float" rule as storage): up to 8 integer digits (≤ R$ 99.999.999/M — far
 * above any real price; beyond that brlToMicrocents would overflow into a
 * 500) and up to 8 decimal places, converted to integer µ¢ at this border.
 * Zero is REJECTED (C-2): an accidental "0" would stamp every pending
 * trace at R$ 0,00 immutably — invariant 2's exact nightmare. If free-tier
 * models ever become real, that is a new decision-log entry, not a silent
 * default.
 *
 * effective_from accepts date-only or OFFSET-CARRYING datetimes — never a
 * timezone-less local datetime (B-8): "2026-07-01T00:00:00" would read in
 * the SERVER's timezone and shift the immutable stamp boundary.
 */
export const registerPriceVersionRequestSchema = z.strictObject({
  model: z.string().min(1),
  token_type: tokenTypeSchema,
  price_brl_per_million: z
    .string()
    .regex(/^\d{1,8}(\.\d{1,8})?$/, 'decimal string, e.g. "2.75"')
    .refine((value) => Number(value) > 0, {
      message: 'price_brl_per_million must be greater than zero',
    })
    // The regex bounds the FORMAT; this bounds the VALUE: an amount the
    // µ¢ conversion cannot represent as a safe integer answers 400 at the
    // border, never a 500 in the controller.
    .refine(convertsToMicrocents, {
      message: 'price_brl_per_million exceeds the representable range',
    }),
  effective_from: isoDateRule,
});

export const registerPriceVersionResponseSchema = z.strictObject({
  model: z.string(),
  token_type: tokenTypeSchema,
  price_brl_per_million: z.string(),
  price_display: z.string(),
  effective_from: z.string(),
  effective_from_display: z.string(),
  // Decision 57: what the new price immediately unblocked. Decision 183:
  // examined/stamped/still_pending cover ONLY the registered model's traces.
  reprocess: z.strictObject({
    examined: z.number().int(),
    stamped: z.number().int(),
    still_pending: z.number().int(),
    failed: z.number().int(),
    /** T6: pending traces of CLOSED months — untouched until an audited reopen. */
    blocked_closed_month: z.number().int(),
    /** audit B-5: the WHOLE pending queue after this run, every model — not just this price's. */
    pending_remaining: z.number().int(),
  }),
});

export type RegisterPriceVersionRequest = z.infer<
  typeof registerPriceVersionRequestSchema
>;
export type RegisterPriceVersionResponse = z.infer<
  typeof registerPriceVersionResponseSchema
>;

/** GET /prices (US4 / audit D-3) — R$-only by construction (invariant 4). */
export const listPriceVersionsResponseSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      model: z.string(),
      token_type: tokenTypeSchema,
      pricing_type: z.literal('fixed_brl'),
      price_brl_per_million: z.string(),
      price_display: z.string(),
      effective_from: z.string(),
      effective_from_display: z.string(),
    }),
  ),
});
