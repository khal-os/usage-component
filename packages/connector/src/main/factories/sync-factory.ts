import { SyncTracesDbUseCase } from '../../application/useCases/syncTraces/sync-traces-db-use-case.js';
import { SyncBatchesDbUseCase } from '../../application/useCases/syncBatches/sync-batches-db-use-case.js';
import { ReprocessPendingDbUseCase } from '@observability/core/application/useCases/reprocessPending/reprocess-pending-db-use-case.js';
import { TraceSourceClient } from '../../application/interfaces/trace-source-client.js';
import { FakeTraceSourceClient } from '../../infrastructure/traceSource/fake-trace-source-client.js';
import { ClickHouseLangWatchClient } from '../../infrastructure/traceSource/langwatch/clickhouse/clickhouse-langwatch-client.js';
import { IngestFailureRepository } from '../../application/interfaces/ingest-failure-repository.js';
import { TraceBatchSource } from '../../application/interfaces/trace-batch-source.js';
import { MongoDbPriceVersionRepository } from '@observability/core/infrastructure/database/mongodb/priceVersion/mongodb-price-version-repository.js';
import { MongoDbTraceRepository } from '@observability/core/infrastructure/database/mongodb/trace/mongodb-trace-repository.js';
import { MongoDbSyncStateRepository } from '../../infrastructure/database/mongodb/syncState/mongodb-sync-state-repository.js';
import { MongoDbBillingPeriodRepository } from '@observability/core/infrastructure/database/mongodb/billing/mongodb-billing-period-repository.js';
import { MongoDbIngestFailureRepository } from '../../infrastructure/database/mongodb/ingestFailures/mongodb-ingest-failure-repository.js';
import { MongoDbPoisonRowRepository } from '../../infrastructure/database/mongodb/ingestFailures/mongodb-poison-row-repository.js';
import { estimateBsonBytes } from '../../infrastructure/database/mongodb/ingestFailures/bson-size-estimator.js';
import { config } from '../../infrastructure/index.js';
import { makeLogger } from './logger-factory.js';

const syncLogger = makeLogger({ component: 'sync' });

const INGESTION_DEFAULTS = {
  intervalSeconds: 60,
  batchSize: 1000,
  quietPeriodSeconds: 900, // decision 61: 15 min
  reprocessIntervalSeconds: 3600,
} as const;

// Decisão 59: com LANGWATCH_CLICKHOUSE_URL configurado, a fonte é o
// ClickHouse do próprio LangWatch (leitura direta, sem o teto de ~100 da
// busca HTTP). Nada fora deste factory sabe a diferença.
const quietPeriodMs = (): number =>
  (config.traceIngestionQuietPeriodSeconds ??
    INGESTION_DEFAULTS.quietPeriodSeconds) * 1000;

// BOTH the URL and a non-blank project id are required (audit G-1): in
// ECS the URL is always set and the project id arrives via SSM with a
// whitespace placeholder until onboarding — URL-without-project must land
// in the crash path below, because the alternatives are silent: a blank
// filter matches nothing (healthy-looking zero-ingest) and an absent
// tenantId drops the filter entirely (EVERY project ingested into a
// single-tenant archive). The schema already trims; the trim here guards
// direct config construction too.
const makeClickHouseClient = (): ClickHouseLangWatchClient | undefined => {
  const projectId = config.langwatchProjectId?.trim();

  return config.langwatchClickhouseUrl && projectId
    ? new ClickHouseLangWatchClient({
        url: config.langwatchClickhouseUrl,
        username: config.langwatchClickhouseUser ?? 'default',
        password: config.langwatchClickhousePassword ?? '',
        database: config.langwatchClickhouseDatabase ?? 'langwatch',
        tenantId: projectId,
        quietPeriodMs: quietPeriodMs(),
        // audit C-6.2: skipped rows leave a durable record, not just a log.
        poisonRowRepository: new MongoDbPoisonRowRepository(),
        logger: syncLogger,
      })
    : undefined;
};

/**
 * Decision 127: the source is DECLARED, never inferred. ClickHouse is the
 * only real source (the HTTP client is gone — no client will ever ingest
 * over HTTP), and the fixture fake exists only behind the explicit
 * `TRACE_SOURCE=fixtures` opt-in (or jest's test environment, where the
 * module's route harness seeds through it).
 *
 * "No source configured" is a CRASH, not a fall-through: the old
 * inference chain ended in `: new FakeTraceSourceClient()`, so one empty
 * env var made `make sync` "ingest" the shipped demo fixtures into a real
 * client's permanent archive — stamped, billed, and reported as success
 * (post-split audit A-1). Every branch logs its choice for the same
 * reason: the run's own output must say where the traces came from.
 */
export const makeTraceSourceClient = (): TraceSourceClient => {
  if (config.traceSource === 'fixtures') {
    syncLogger.info(
      'Trace source: FIXTURE FAKE (TRACE_SOURCE=fixtures — demo/offline)',
    );

    return new FakeTraceSourceClient();
  }

  const clickHouse = makeClickHouseClient();

  if (clickHouse) {
    syncLogger.info('Trace source: ClickHouse (direct read, decision 59)');

    return clickHouse;
  }

  if (config.Environment === 'test') {
    return new FakeTraceSourceClient();
  }

  throw new Error(
    'No trace source configured: set LANGWATCH_PROJECT_ID (onboarding fills ' +
      'it — scripts/3-onboard-langwatch.sh) so the direct-ClickHouse source ' +
      'is enabled, or TRACE_SOURCE=fixtures for an offline fixture demo. ' +
      'Refusing to guess (decision 127): a backfill that silently syncs ' +
      'fixture data into the permanent archive is worse than a crash.',
  );
};

export const makeSyncTracesUseCase = (): SyncTracesDbUseCase =>
  new SyncTracesDbUseCase({
    traceSourceClient: makeTraceSourceClient(),
    priceVersionRepository: new MongoDbPriceVersionRepository(),
    traceRepository: new MongoDbTraceRepository({ logger: syncLogger }),
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
    // audit B-3: dead-letter trail + pre-insert size guard.
    ingestFailureRepository: new MongoDbIngestFailureRepository(),
    estimateDocumentBytes: estimateBsonBytes,
    logger: syncLogger,
  });

export const makeReprocessPendingUseCase = (): ReprocessPendingDbUseCase => {
  const logger = makeLogger({ component: 'reprocess' });

  return new ReprocessPendingDbUseCase({
    priceVersionRepository: new MongoDbPriceVersionRepository(),
    traceRepository: new MongoDbTraceRepository({ logger }),
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
    logger,
  });
};

/**
 * The dead-letter trail, for the worker's per-cycle count (re-audit
 * 2026-08, sync item 3). Exposed HERE because main may only reach storage
 * through the composition root (architecture boundary) — the alternative
 * was a pass-through `countDeadLetters()` on the batch-sync use case,
 * which has nothing to do with syncing one batch.
 */
export const makeIngestFailureRepository = (): IngestFailureRepository =>
  new MongoDbIngestFailureRepository();

export const traceIngestionWorkerSettings = {
  intervalMs:
    (config.traceIngestionIntervalSeconds ??
      INGESTION_DEFAULTS.intervalSeconds) * 1000,
  reprocessIntervalMs:
    (config.reprocessIntervalSeconds ??
      INGESTION_DEFAULTS.reprocessIntervalSeconds) * 1000,
} as const;

/**
 * Continuous sync exists ONLY with a ClickHouse source (decisions 59/127):
 * the fixture fake has no cursor to page on. `undefined` → the worker
 * idles (pre-onboarding / offline demo stacks, where `make sync` with
 * TRACE_SOURCE=fixtures remains the demo path).
 */
export const makeSyncBatchesUseCase = ():
  { useCase: SyncBatchesDbUseCase; source: TraceBatchSource } | undefined => {
  const source = makeClickHouseClient();

  if (!source) {
    return undefined;
  }

  return {
    source,
    useCase: new SyncBatchesDbUseCase({
      traceBatchSource: source,
      syncStateRepository: new MongoDbSyncStateRepository({
        logger: syncLogger,
      }),
      priceVersionRepository: new MongoDbPriceVersionRepository(),
      traceRepository: new MongoDbTraceRepository({ logger: syncLogger }),
      billingPeriodRepository: new MongoDbBillingPeriodRepository(),
      // audit B-3: dead-letter trail + pre-insert size guard.
      ingestFailureRepository: new MongoDbIngestFailureRepository(),
      estimateDocumentBytes: estimateBsonBytes,
      batchSize: config.traceIngestionBatchSize ?? INGESTION_DEFAULTS.batchSize,
      quietPeriodMs: quietPeriodMs(),
      logger: syncLogger,
    }),
  };
};
