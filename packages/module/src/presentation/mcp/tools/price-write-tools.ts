import { z } from 'zod';
import {
  modelKey,
  parseModelRef,
} from '@observability/core/domain/models/model-ref.js';
import { clientCalendarOf } from '@observability/core/common/helpers/clock/client-clock.js';
import {
  listPriceVersionsResponseSchema,
  registerPriceVersionRequestSchema,
  registerPriceVersionResponseSchema,
} from '../../controllers/prices/price-view-schemas.js';
import { Controller } from '../../interfaces/index.js';
import { callController, jsonFromController } from '../controller-tool.js';
import {
  ConfirmationCodec,
  ExpectedConfirmation,
  mintConfirmation,
  verifyConfirmation,
} from '../confirmation.js';
import { fromConfirmationFailure } from '../confirmation-error.js';
import {
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
  findBill,
  hashOf,
  mintedAt,
  previewEnvelope,
} from './write-support.js';

const priceArgs = {
  model: z
    .string()
    .min(1)
    .describe(
      'Model the price applies to, ideally `provider/id` (e.g. openai/gpt-5-mini). A bare id is normalised to its canonical key — the preview shows the key that will be stored.',
    ),
  token_type: z
    .enum(['input', 'output', 'cache_read', 'cache_write'])
    .describe('Which token type this price covers.'),
  price_brl_per_million: z
    .string()
    .min(1)
    .describe(
      'Price in R$ per MILLION tokens, as a decimal STRING (e.g. "2.75") — never a JSON number, and never zero: a zero would stamp executions at R$ 0.00 forever.',
    ),
  effective_from: z
    .string()
    .min(1)
    .describe(
      'When the price starts to apply: ISO date (2026-06-01) or a datetime carrying its offset. Executions are priced with the version in force on THEIR date, so this is what decides which executions get this price.',
    ),
};

export const previewRegisterPriceSchema = z.strictObject({
  action: z.literal('register_price'),
  request: z.strictObject({
    model: z.string(),
    token_type: z.string(),
    price_brl_per_million: z.string(),
    effective_from: z.string(),
  }),
  canonical_model: z.string(),
  existing_versions: listPriceVersionsResponseSchema.shape.items,
  ...previewEnvelope,
});

export interface PriceWriteDependencies {
  readonly listPrices: Controller;
  readonly listBills: Controller;
  readonly registerPrice: Controller;
  readonly codec: ConfirmationCodec;
  readonly clock: WriteClock;
}

type ParsedRequest = {
  readonly canonicalModel: string;
  readonly tokenType: string;
  readonly price: string;
  readonly effectiveFrom: Date;
};

/**
 * The SAME border `POST /prices` parses (decision 178): the request schema
 * of the controller, not a second one. A bad value is refused here with the
 * field named, exactly as the HTTP door would refuse it.
 */
const parseRequest = (
  args: Record<string, unknown>,
): { ok: true; value: ParsedRequest } | { ok: false; field: string } => {
  const parsed = registerPriceVersionRequestSchema.safeParse({
    model: args['model'],
    token_type: args['token_type'],
    price_brl_per_million: args['price_brl_per_million'],
    effective_from: args['effective_from'],
  });

  if (!parsed.success) {
    return {
      ok: false,
      field: String(parsed.error.issues[0]?.path[0] ?? 'body'),
    };
  }

  return {
    ok: true,
    value: {
      canonicalModel: modelKey(parseModelRef(parsed.data.model)),
      tokenType: parsed.data.token_type,
      price: parsed.data.price_brl_per_million,
      effectiveFrom: parsed.data.effective_from,
    },
  };
};

/** What both sides of the pair hash: the request AFTER normalisation. */
const expectationOf = (
  caller: ToolCaller,
  request: ParsedRequest,
  codec: ConfirmationCodec,
): ExpectedConfirmation => ({
  tenant: caller.tenant,
  subject: caller.subject,
  action: 'register_price',
  kind: 'price',
  id: `${request.canonicalModel}#${request.tokenType}`,
  etag: '',
  hash: hashOf(codec, {
    model: request.canonicalModel,
    token_type: request.tokenType,
    price_brl_per_million: request.price,
    effective_from: request.effectiveFrom.toISOString(),
  }),
});

const invalidInput = (field: string) =>
  toolFailed(
    toolError(
      'INVALID_INPUT',
      `Invalid parameter: ${field}`,
      'Prices are decimal strings greater than zero; the date is an ISO date or an offset-carrying datetime. Read the field description and fix that one value.',
    ),
  );

export const priceWriteTools = (
  deps: PriceWriteDependencies,
): ToolDefinition[] => [
  {
    name: 'preview_register_price',
    title: 'Preview a price registration',
    description:
      'Shows what registering this price would do and returns a confirmation_token. Writes NOTHING. ' +
      'It reports the canonical model key that will be stored, the versions that already exist for that model and token type, and warns when the date falls inside a month that is already closed (a closed month is never re-priced). ' +
      'Show this to the person and register only after they approve it.',
    inputSchema: priceArgs,
    outputSchema: previewRegisterPriceSchema,
    annotations: PREVIEW,
    run: async (args, caller) => {
      const parsed = parseRequest(args);
      if (!parsed.ok) return invalidInput(parsed.field);

      const request = parsed.value;

      const versions = await callController(deps.listPrices, {
        query: { model: request.canonicalModel, token_type: request.tokenType },
      });
      if (!versions.ok) return toolFailed(versions.error);

      const existing = (
        versions.response.body as z.infer<
          typeof listPriceVersionsResponseSchema
        >
      ).items;
      const effectiveFromIso = request.effectiveFrom.toISOString();

      if (existing.some((item) => item.effective_from === effectiveFromIso)) {
        return toolFailed(
          toolError(
            'CONFLICT',
            `A price version for ${request.canonicalModel} ${request.tokenType} effective from ${effectiveFromIso} already exists.`,
            'Versions are immutable. To change a price, register a NEW version with a later effective_from.',
          ),
        );
      }

      const bills = await callController(deps.listBills, { query: {} });
      if (!bills.ok) return toolFailed(bills.error);

      const month = clientCalendarOf(request.effectiveFrom);
      const row = findBill(
        (bills.response.body as { bills: BillRow[] }).bills,
        month.year,
        month.month,
      );

      const warnings: string[] = [];

      if (row?.period_status === 'closed') {
        warnings.push(
          `${row.month_label} is CLOSED: the price is registered, but executions of a closed month are never re-priced. Reopen the month first if that is what you need.`,
        );
      }

      if (existing.length === 0) {
        warnings.push(
          `No price exists yet for ${request.canonicalModel} ${request.tokenType} — registering this one will stamp the executions that were waiting for it.`,
        );
      }

      const token = mintedAt(
        expectationOf(caller, request, deps.codec),
        deps.clock.now(),
        deps.codec,
        mintConfirmation,
      );

      return toolOk({
        action: 'register_price',
        request: {
          model: String(args['model']),
          token_type: request.tokenType,
          price_brl_per_million: request.price,
          effective_from: effectiveFromIso,
        },
        canonical_model: request.canonicalModel,
        existing_versions: existing,
        writes_nothing: true,
        warnings,
        ...token,
      });
    },
  },
  {
    name: 'register_price',
    title: 'Register the previewed price',
    description:
      'Registers the price version the preview showed — same single path as the HTTP route and the operator job: canonical model key, immutable version, and an immediate re-stamp of the executions the new price unblocks. ' +
      'Requires the confirmation_token of a preview of the EXACT same request. Never call it with a token whose preview the person has not seen.',
    inputSchema: { ...priceArgs, ...confirmationArg },
    outputSchema: registerPriceVersionResponseSchema,
    annotations: WRITE,
    run: async (args, caller) => {
      const parsed = parseRequest(args);
      if (!parsed.ok) return invalidInput(parsed.field);

      // Verified BEFORE the store is touched: a refused token must never
      // have written anything.
      const verified = verifyConfirmation(
        typeof args['confirmation_token'] === 'string'
          ? args['confirmation_token']
          : undefined,
        expectationOf(caller, parsed.value, deps.codec),
        deps.clock.now().getTime(),
        deps.codec,
      );

      if (!verified.ok)
        return toolFailed(fromConfirmationFailure(verified.failure));

      return jsonFromController(deps.registerPrice, {
        body: {
          model: args['model'],
          token_type: args['token_type'],
          price_brl_per_million: args['price_brl_per_million'],
          effective_from: args['effective_from'],
        },
        query: {},
      });
    },
  },
];
