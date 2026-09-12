import { listPriceVersionsResponseSchema } from '../../controllers/prices/price-view-schemas.js';
import { priceListQueryShape } from '../../controllers/prices/list-price-versions-controller.js';
import { Controller } from '../../interfaces/index.js';
import { jsonFromController } from '../controller-tool.js';
import { toQuery } from '../query-args.js';
import { READ_ONLY, ToolDefinition } from '../tool-definition.js';
import { priceFilterArgs } from './read-args.js';

export const PRICE_QUERY_SHAPES = { list_prices: priceListQueryShape } as const;

export interface PriceReadControllers {
  readonly listPrices: Controller;
}

export const priceReadTools = (
  controllers: PriceReadControllers,
): ToolDefinition[] => [
  {
    name: 'list_prices',
    title: 'Contracted price table',
    description:
      'The price versions in force, in R$ per million tokens, per model and token type with the date each one takes effect. Versions are immutable: a change is a new row with a later effective_from. ' +
      'Read this before registering a price and when diagnosing an execution stuck on pending_price — the missing row is the answer.',
    inputSchema: priceFilterArgs,
    outputSchema: listPriceVersionsResponseSchema,
    annotations: READ_ONLY,
    run: async (args) =>
      jsonFromController(controllers.listPrices, { query: toQuery(args) }),
  },
];
