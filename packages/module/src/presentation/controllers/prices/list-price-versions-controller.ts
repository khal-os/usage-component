import { z } from 'zod';
import {
  TOKEN_TYPES,
  PriceVersionModel,
} from '@observability/core/domain/models/price-version-model.js';
import { ListPriceVersionsUseCase } from '@observability/core/domain/useCases/list-price-versions-use-case.js';
import { formatBrlFromMicrocents } from '@observability/core/common/helpers/money/money.js';
import { formatUtcDateDisplay } from '@observability/core/common/helpers/display/display.js';
import {
  Controller,
  HttpRequest,
  HttpResponse,
} from '../../interfaces/index.js';
import { buildSuccess } from '../../helpers/http-helper.js';
import { parseQuery } from '../../helpers/query-validation.js';

/**
 * GET /prices (US4 / audit D-3): the READ side of the price table an
 * operator checks the bill against — and the pending_price diagnostic
 * ("which (model, token_type, effective_from) rows exist?"), which used
 * to require mongosh while this route answered 405.
 */
/** Exported for the MCP tool of this endpoint (T12) — one parameter contract. */
export const priceListQueryShape = {
  model: z.string().min(1).optional(),
  token_type: z.enum(TOKEN_TYPES).optional(),
};

// Strict (C-3): an unknown param is a 400, never silently ignored.
const querySchema = z.strictObject(priceListQueryShape);

/** Explicit R$-only whitelist (invariant 4): no internal field ever rides along. */
const toPriceVersionView = (version: PriceVersionModel) => ({
  model: version.model,
  token_type: version.tokenType,
  pricing_type: version.pricingType,
  price_brl_per_million: formatBrlFromMicrocents(
    version.priceMicrocentsPerMillion,
  ),
  price_display: `R$ ${formatBrlFromMicrocents(version.priceMicrocentsPerMillion)}/M tokens`,
  effective_from: version.effectiveFrom.toISOString(),
  effective_from_display: formatUtcDateDisplay(version.effectiveFrom),
});

export class ListPriceVersionsController implements Controller {
  private readonly listPriceVersions: ListPriceVersionsUseCase;

  constructor(args: { listPriceVersions: ListPriceVersionsUseCase }) {
    this.listPriceVersions = args.listPriceVersions;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const parsed = parseQuery(querySchema, httpRequest.query);

    if (!parsed.ok) {
      return parsed.response;
    }

    const versions = await this.listPriceVersions.list({
      model: parsed.value.model,
      tokenType: parsed.value.token_type,
    });

    return buildSuccess({ items: versions.map(toPriceVersionView) });
  }
}
