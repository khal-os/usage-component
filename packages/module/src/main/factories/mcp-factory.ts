import { config } from '../../infrastructure/index.js';
import { KhalAuthClaimsVerifier } from '../../infrastructure/auth/session-claims-verifier.js';
import { SessionClaimsVerifier } from '../../application/interfaces/session-claims-verifier.js';
import { buildMcpSurface } from '../../presentation/mcp/surface.js';
import { systemClock } from '../../presentation/mcp/tools/write-support.js';
import { ConfirmationCodec } from '../../presentation/mcp/confirmation.js';
import { apiVersion, buildOpenApiDocument } from '../docs/openapi.js';
import { McpRuntime } from '../mcp/mcp-routes.js';
import { makeNodeConfirmationCodec } from '../mcp/node-confirmation-codec.js';
import {
  makeCloseBillingPeriodUseCase,
  makeExportStatementController,
  makeGetBillingProjectionController,
  makeGetBillingSeriesController,
  makeGetBillingSummaryController,
  makeListBillsController,
  makeReopenBillingPeriodUseCase,
} from './billing-factory.js';
import {
  makeListPriceVersionsController,
  makeRegisterPriceVersionController,
} from './price-factory.js';
import {
  makeGetSessionDetailController,
  makeListSessionFilterOptionsController,
  makeListSessionsController,
} from './sessions-factory.js';
import {
  makeGetTraceDetailController,
  makeListTraceFilterOptionsController,
  makeListTracesController,
} from './traces-factory.js';
import { makeLogger } from './logger-factory.js';

/** Everything the endpoint needs, already resolved — no env reading below this line. */
export interface McpSettings {
  readonly canonicalUrl: string;
  readonly authUrl: string;
  readonly tenant: string;
  readonly audience: string;
  readonly confirmationKey: string;
  readonly clientTimezone: string;
  readonly clientName?: string;
  readonly allowedOrigins: string;
}

export interface McpOverrides {
  /** Injected by the integration suites; production verifies against khal-auth. */
  verifier?: SessionClaimsVerifier;
  codec?: ConfirmationCodec;
}

/**
 * Builds the endpoint from EXPLICIT settings. Everything the tools need is
 * built from the SAME factories the HTTP routes use: one controller per
 * endpoint, one validation, one view (decision 175).
 */
export const makeMcpRuntimeFrom = (
  settings: McpSettings,
  overrides: McpOverrides = {},
): McpRuntime => {
  const logger = makeLogger({ component: 'mcp' });
  const { canonicalUrl, authUrl, tenant, audience, confirmationKey } = settings;

  const listBills = makeListBillsController();
  const billingSummary = makeGetBillingSummaryController();
  const billingProjection = makeGetBillingProjectionController();
  const listPrices = makeListPriceVersionsController();
  const codec = overrides.codec ?? makeNodeConfirmationCodec(confirmationKey);

  const surface = buildMcpSurface({
    identity: {
      ...(settings.clientName !== undefined && {
        clientName: settings.clientName,
      }),
      clientTimezone: settings.clientTimezone,
      tenant,
    },
    traces: {
      listTraces: makeListTracesController(),
      traceFilterOptions: makeListTraceFilterOptionsController(),
      traceDetail: makeGetTraceDetailController(),
    },
    sessions: {
      listSessions: makeListSessionsController(),
      sessionFilterOptions: makeListSessionFilterOptionsController(),
      sessionDetail: makeGetSessionDetailController(),
    },
    billing: {
      listBills,
      billingSummary,
      billingSeries: makeGetBillingSeriesController(),
      billingProjection,
      statement: makeExportStatementController(),
    },
    prices: { listPrices },
    overview: { listBills, billingProjection, listPrices },
    priceWrites: {
      listPrices,
      listBills,
      registerPrice: makeRegisterPriceVersionController(),
      codec,
      clock: systemClock,
    },
    lifecycle: {
      listBills,
      billingSummary,
      // Composed PER CALL with the caller's subject: the audit trail of a
      // month closed through MCP names the person who confirmed it.
      closeForActor: (actor) => makeCloseBillingPeriodUseCase('mcp', actor),
      reopenForActor: (actor) => makeReopenBillingPeriodUseCase('mcp', actor),
      codec,
      clock: systemClock,
    },
    resources: {
      openApiJson: () =>
        JSON.stringify(buildOpenApiDocument(settings.clientName), null, 2),
      listBills,
      listPrices,
    },
  });

  logger.info('MCP endpoint is ON', {
    canonicalUrl,
    audience,
    tools: surface.tools.length,
    prompts: surface.prompts.length,
    resources: surface.resources.length,
  });

  return {
    surface,
    verifier:
      overrides.verifier ??
      new KhalAuthClaimsVerifier({ authUrl, audience, tenant }),
    canonicalUrl,
    authorizationServer: authUrl,
    resourceName: settings.clientName
      ? `${settings.clientName} usage archive`
      : 'Usage archive',
    allowedOrigins: settings.allowedOrigins,
    version: apiVersion(),
    logger,
  };
};

/**
 * The production door (decision 175). OPT-IN: with MCP_CANONICAL_URL unset
 * this returns undefined and no route is mounted, so every deployment that
 * does not configure it keeps its exact behavior. Set, the env schema has
 * already proven the rest of the contract exists — the guard below is the
 * belt to that braces, and it fails CLOSED.
 */
export const makeMcpRuntime = (
  overrides: McpOverrides = {},
): McpRuntime | undefined => {
  const logger = makeLogger({ component: 'mcp' });

  const canonicalUrl = config.mcpCanonicalUrl;
  if (!canonicalUrl) {
    logger.info(
      'MCP endpoint is OFF (MCP_CANONICAL_URL unset) — no /mcp route is mounted',
    );
    return undefined;
  }

  const authUrl = config.khalAuthUrl;
  const tenant = config.khalTenant;
  const audience = config.mcpAudience;
  const confirmationKey = config.mcpConfirmationKey;

  if (!authUrl || !tenant || !audience || !confirmationKey) {
    logger.error(
      'MCP_CANONICAL_URL is set but the rest of the contract is missing — the /mcp route is NOT mounted (fail closed)',
    );
    return undefined;
  }

  return makeMcpRuntimeFrom(
    {
      canonicalUrl,
      authUrl,
      tenant,
      audience,
      confirmationKey,
      clientTimezone: config.clientTimezone,
      ...(config.clientName !== undefined && { clientName: config.clientName }),
      allowedOrigins: config.corsAllowedOrigins ?? '',
    },
    overrides,
  );
};
