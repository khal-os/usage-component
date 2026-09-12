import { GetBillingSummaryController } from '../../presentation/controllers/billing/get-billing-summary-controller.js';
import { ListBillsController } from '../../presentation/controllers/billing/list-bills-controller.js';
import { GetBillingSeriesController } from '../../presentation/controllers/billing/get-billing-series-controller.js';
import { GetBillingProjectionController } from '../../presentation/controllers/billing/get-billing-projection-controller.js';
import { ExportStatementController } from '../../presentation/controllers/billing/export-statement-controller.js';
import { GetBillingSummaryDbUseCase } from '../../application/useCases/billingSummary/get-billing-summary-db-use-case.js';
import { ListBillsDbUseCase } from '../../application/useCases/billingSummary/list-bills-db-use-case.js';
import { GetBillingSeriesDbUseCase } from '../../application/useCases/billingSeries/get-billing-series-db-use-case.js';
import { GetBillingProjectionDbUseCase } from '../../application/useCases/billingSeries/get-billing-projection-db-use-case.js';
import { CloseBillingPeriodDbUseCase } from '../../application/useCases/billingLifecycle/close-billing-period-db-use-case.js';
import { CloseDueBillingPeriodsDbUseCase } from '../../application/useCases/billingLifecycle/close-due-billing-periods-db-use-case.js';
import { ReopenBillingPeriodDbUseCase } from '../../application/useCases/billingLifecycle/reopen-billing-period-db-use-case.js';
import { config } from '../../infrastructure/index.js';
import { BillingLifecycleTrigger } from '@observability/core/domain/models/billing-period-model.js';
import { MongoDbBillingQueryRepository } from '@observability/core/infrastructure/database/mongodb/billing/mongodb-billing-query-repository.js';
import { MongoDbBillingPeriodRepository } from '@observability/core/infrastructure/database/mongodb/billing/mongodb-billing-period-repository.js';
import { MongoDbBillingSnapshotRepository } from '@observability/core/infrastructure/database/mongodb/billing/mongodb-billing-snapshot-repository.js';
import { MongoDbTraceRepository } from '@observability/core/infrastructure/database/mongodb/trace/mongodb-trace-repository.js';
import { makeLogger } from './logger-factory.js';

const billingLogger = makeLogger({ component: 'billing' });

const makeGetBillingSummaryUseCase = (): GetBillingSummaryDbUseCase =>
  new GetBillingSummaryDbUseCase({
    billingQueryRepository: new MongoDbBillingQueryRepository(),
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
    billingSnapshotRepository: new MongoDbBillingSnapshotRepository(),
  });

export const makeGetBillingSummaryController =
  (): GetBillingSummaryController =>
    new GetBillingSummaryController({
      getBillingSummary: makeGetBillingSummaryUseCase(),
    });

export const makeListBillsController = (): ListBillsController =>
  new ListBillsController({
    listBills: new ListBillsDbUseCase({
      billingQueryRepository: new MongoDbBillingQueryRepository(),
      billingPeriodRepository: new MongoDbBillingPeriodRepository(),
      billingSnapshotRepository: new MongoDbBillingSnapshotRepository(),
      logger: billingLogger,
    }),
  });

export const makeGetBillingSeriesController = (): GetBillingSeriesController =>
  new GetBillingSeriesController({
    getBillingSeries: new GetBillingSeriesDbUseCase({
      billingQueryRepository: new MongoDbBillingQueryRepository(),
      billingPeriodRepository: new MongoDbBillingPeriodRepository(),
      billingSnapshotRepository: new MongoDbBillingSnapshotRepository(),
    }),
  });

export const makeGetBillingProjectionController =
  (): GetBillingProjectionController =>
    new GetBillingProjectionController({
      getBillingProjection: new GetBillingProjectionDbUseCase({
        billingQueryRepository: new MongoDbBillingQueryRepository(),
      }),
    });

export const makeExportStatementController = (): ExportStatementController =>
  new ExportStatementController({
    getBillingSummary: makeGetBillingSummaryUseCase(),
  });

/**
 * The ONE close path (decisions 87 + 131 + 179): the runbook job composes it
 * with the default 'runbook' trigger, the auto-close scheduler with
 * 'scheduled', the MCP tool with 'mcp' plus the session subject as `actor`
 * — the trigger is the door's identity in the audit trail, never a per-call
 * choice.
 */
export const makeCloseBillingPeriodUseCase = (
  trigger: BillingLifecycleTrigger = 'runbook',
  actor?: string,
): CloseBillingPeriodDbUseCase =>
  new CloseBillingPeriodDbUseCase({
    billingQueryRepository: new MongoDbBillingQueryRepository(),
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
    billingSnapshotRepository: new MongoDbBillingSnapshotRepository(
      undefined,
      billingLogger,
    ),
    // Post-close quarantine reconciliation (audit B-1, decision 100).
    traceRepository: new MongoDbTraceRepository({ logger: billingLogger }),
    trigger,
    ...(actor !== undefined && { actor }),
  });

/** Same rule for the reopen door (decision 179): runbook by default, 'mcp' + actor from the tool. */
export const makeReopenBillingPeriodUseCase = (
  trigger: BillingLifecycleTrigger = 'runbook',
  actor?: string,
): ReopenBillingPeriodDbUseCase =>
  new ReopenBillingPeriodDbUseCase({
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
    trigger,
    ...(actor !== undefined && { actor }),
  });

/**
 * Decision 131 knobs, resolved once: env override or default — the same
 * dual-default convention as the connector's INGESTION_DEFAULTS (the
 * compose `:-` defaults must mirror these numbers).
 */
const SCHEDULER_DEFAULTS = {
  delayMinutes: 60,
  checkIntervalSeconds: 900,
} as const;

export const billingCloseSchedulerSettings = {
  delayMs:
    (config.billingAutoCloseDelayMinutes ?? SCHEDULER_DEFAULTS.delayMinutes) *
    60_000,
  checkIntervalMs:
    (config.billingAutoCloseCheckIntervalSeconds ??
      SCHEDULER_DEFAULTS.checkIntervalSeconds) * 1000,
} as const;

/** The scheduler's cycle runner (decision 131) — trigger 'scheduled'. */
export const makeCloseDueBillingPeriodsUseCase =
  (): CloseDueBillingPeriodsDbUseCase =>
    new CloseDueBillingPeriodsDbUseCase({
      billingPeriodRepository: new MongoDbBillingPeriodRepository(),
      billingQueryRepository: new MongoDbBillingQueryRepository(),
      closeBillingPeriod: makeCloseBillingPeriodUseCase('scheduled'),
      delayMs: billingCloseSchedulerSettings.delayMs,
    });
