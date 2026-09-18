import { z } from 'zod';
import {
  billListResponseSchema,
  billingProjectionResponseSchema,
} from '../../controllers/billing/billing-view-schemas.js';
import { listPriceVersionsResponseSchema } from '../../controllers/prices/price-view-schemas.js';
import { Controller } from '../../interfaces/index.js';
import { callController } from '../controller-tool.js';
import {
  READ_ONLY,
  ToolDefinition,
  toolFailed,
  toolOk,
} from '../tool-definition.js';

/** What the deployment knows about itself — injected, never read from env here. */
export interface DeploymentIdentity {
  readonly clientName?: string;
  readonly clientTimezone: string;
  readonly tenant: string;
}

export const overviewResponseSchema = z.strictObject({
  client: z.strictObject({
    name: z.string().nullable(),
    tenant: z.string(),
    timezone: z.string(),
  }),
  prices: z.strictObject({
    version_count: z.number().int(),
    models: z.array(z.string()),
  }),
  current_month: billingProjectionResponseSchema,
  bills: billListResponseSchema.shape.bills,
});

export interface OverviewControllers {
  readonly listBills: Controller;
  readonly billingProjection: Controller;
  readonly listPrices: Controller;
}

type PriceItems = z.infer<typeof listPriceVersionsResponseSchema>;

/**
 * The one tool that answers "what am I looking at": the deployment's
 * identity and business timezone (the boundary every month is cut on), the
 * months that exist with their status, where the current month is heading,
 * and how many price versions back the numbers. Composed from the SAME
 * controllers the HTTP routes use — no fourth calculation path.
 */
export const overviewTool = (
  controllers: OverviewControllers,
  identity: DeploymentIdentity,
): ToolDefinition => ({
  name: 'get_overview',
  title: 'Overview of this deployment',
  description:
    'Start here. Says which client this archive belongs to, the timezone its billing months are cut in, every month with its status (closed / in_progress / open) and total, the run-rate estimate of the current month, and how many contracted price versions exist. ' +
    'Every value in R$; costs are stamped at ingestion and immutable.',
  inputSchema: {},
  outputSchema: overviewResponseSchema,
  annotations: READ_ONLY,
  run: async () => {
    const bills = await callController(controllers.listBills, { query: {} });
    if (!bills.ok) return toolFailed(bills.error);

    const projection = await callController(controllers.billingProjection, {
      query: {},
    });
    if (!projection.ok) return toolFailed(projection.error);

    const prices = await callController(controllers.listPrices, { query: {} });
    if (!prices.ok) return toolFailed(prices.error);

    const priceItems = (prices.response.body as PriceItems).items;
    const models = [...new Set(priceItems.map((item) => item.model))].sort();

    return toolOk({
      client: {
        name: identity.clientName ?? null,
        tenant: identity.tenant,
        timezone: identity.clientTimezone,
      },
      prices: { version_count: priceItems.length, models },
      current_month: projection.response.body,
      bills: (bills.response.body as { bills: unknown[] }).bills,
    });
  },
});
