/**
 * issue #102 against a real replica set: running the batch in concurrent
 * session lanes must store exactly what the sequential loop stores. The
 * risks the design accepts are checked here, not assumed:
 *
 *  - facet counter $inc inside concurrent transactions conflicts on the
 *    same counter document; the driver's withTransaction must retry them
 *    with no lost or doubled increments;
 *  - session summaries are recomputed outside the insert transaction, so
 *    traces of one session must stay sequential or the summary goes stale;
 *  - prices resolved through the per-batch cache must equal the uncached
 *    resolution, including across the seed's mid-June price change.
 *
 * Duration and the server's aborted-transaction count are logged for both
 * runs. The memory server has near-zero latency, so the speedup measured
 * here is NOT the production one (production pays ~11ms per round trip to
 * Atlas); the production gain is read from the worker's batch timings.
 */
import { MongoDb } from '@observability/core/infrastructure/database/mongodb/mongo-db.js';
import {
  MIGRATIONS_COLLECTION,
  runMigrations,
} from '@observability/core/infrastructure/database/mongodb/helpers/migration-runner.js';
import { migrations } from '@observability/core/infrastructure/database/mongodb/migrations/index.js';
import {
  MongoDbPriceVersionRepository,
  PRICE_VERSIONS_COLLECTION,
} from '@observability/core/infrastructure/database/mongodb/priceVersion/mongodb-price-version-repository.js';
import { seedPocPrices } from '@observability/core/infrastructure/database/mongodb/priceVersion/poc-price-seed.js';
import { MongoDbTraceRepository } from '@observability/core/infrastructure/database/mongodb/trace/mongodb-trace-repository.js';
import {
  INGEST_FAILURES_COLLECTION,
  SESSION_SUMMARIES_COLLECTION,
  TRACES_COLLECTION,
  TRACE_FILTER_COUNTERS_COLLECTION,
} from '@observability/core/infrastructure/database/mongodb/collections.js';
import {
  BILLING_PERIODS_COLLECTION,
  MongoDbBillingPeriodRepository,
} from '@observability/core/infrastructure/database/mongodb/billing/mongodb-billing-period-repository.js';
import { MongoDbIngestFailureRepository } from '@observability/connector/infrastructure/database/mongodb/ingestFailures/mongodb-ingest-failure-repository.js';
import { estimateBsonBytes } from '@observability/connector/infrastructure/database/mongodb/ingestFailures/bson-size-estimator.js';
import { SyncBatchesDbUseCase } from '@observability/connector/application/useCases/syncBatches/sync-batches-db-use-case.js';
import {
  SyncCursor,
  SyncStateRepository,
  TraceBatch,
  TraceBatchSource,
} from '@observability/connector/application/useCases/syncBatches/sync-batches-protocols.js';
import { SourceTrace } from '@observability/connector/application/interfaces/trace-source-client.js';

const SESSIONS = 12;
const TRACES_PER_SESSION = 10;
const TOTAL = SESSIONS * TRACES_PER_SESSION;

/** Every trace shares agent, channel, type and day: they all hit ONE counter document, the worst case for conflicts. */
const makeTraces = (): SourceTrace[] =>
  Array.from({ length: TOTAL }, (_, index) => {
    const session = index % SESSIONS;
    // Half before and half after the seed's 2026-06-15 price change.
    const day = index % 2 === 0 ? '2026-06-10' : '2026-06-20';
    const minute = String(index % 60).padStart(2, '0');

    return {
      traceId: `trace-${String(index).padStart(4, '0')}`,
      sessionId: `session-${session}`,
      agent: { id: 'agent-atendimento' },
      model: 'openai/gpt-5-mini',
      type: 'chat',
      channel: { type: 'whatsapp' },
      startedAt: new Date(`${day}T12:${minute}:00.000Z`),
      finishedAt: new Date(`${day}T12:${minute}:04.000Z`),
      status: 'ok',
      tokens: { input: 1000 + index, output: 200 },
      input: 'entrada',
      output: 'saída',
      spans: [],
    };
  });

/** Hands out the whole set as one batch, then nothing. */
class OneBatchSource implements TraceBatchSource {
  private served = false;

  constructor(private readonly traces: SourceTrace[]) {}

  async fetchBatch(): Promise<TraceBatch> {
    if (this.served) return { traces: [], nextCursor: null, scanned: 0 };

    this.served = true;

    return {
      traces: this.traces,
      nextCursor: { updatedAt: new Date('2026-06-30T00:00:00Z'), traceId: 'z' },
      scanned: this.traces.length,
    };
  }

  async assertCompatibleSchema(): Promise<void> {}
}

class MemorySyncState implements SyncStateRepository {
  cursor: SyncCursor | null = null;

  async getTraceCursor(): Promise<SyncCursor | null> {
    return this.cursor;
  }

  async setTraceCursor(cursor: SyncCursor): Promise<void> {
    this.cursor = cursor;
  }
}

interface RunResult {
  ms: number;
  aborted: number;
  traces: Array<Record<string, unknown>>;
  counterTotal: number;
  sessions: Array<{ _id: string; traceCount: number }>;
}

const abortedTransactions = async (): Promise<number> => {
  const status = await MongoDb.getClient()
    .db()
    .admin()
    .command({ serverStatus: 1 });

  return Number(status['transactions']?.['totalAborted'] ?? 0);
};

const reset = async (): Promise<void> => {
  for (const collection of [
    TRACES_COLLECTION,
    TRACE_FILTER_COUNTERS_COLLECTION,
    SESSION_SUMMARIES_COLLECTION,
    PRICE_VERSIONS_COLLECTION,
    MIGRATIONS_COLLECTION,
    BILLING_PERIODS_COLLECTION,
    INGEST_FAILURES_COLLECTION,
  ]) {
    await MongoDb.getCollection(collection).deleteMany({});
  }

  await runMigrations(MongoDb.getClient().db(), migrations);
  await seedPocPrices(MongoDb.getClient().db());
};

const run = async (concurrency: number): Promise<RunResult> => {
  await reset();

  const sut = new SyncBatchesDbUseCase({
    traceBatchSource: new OneBatchSource(makeTraces()),
    syncStateRepository: new MemorySyncState(),
    priceVersionRepository: new MongoDbPriceVersionRepository(),
    traceRepository: new MongoDbTraceRepository(),
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
    ingestFailureRepository: new MongoDbIngestFailureRepository(),
    estimateDocumentBytes: estimateBsonBytes,
    batchSize: TOTAL,
    quietPeriodMs: 0,
    concurrency,
  });

  const abortedBefore = await abortedTransactions();
  const started = Date.now();
  const report = await sut.syncNextBatch();
  const ms = Date.now() - started;
  const aborted = (await abortedTransactions()) - abortedBefore;

  expect(report.inserted).toBe(TOTAL);
  expect(report.failed).toBe(0);

  const traces = await MongoDb.getCollection(TRACES_COLLECTION)
    .find(
      {},
      {
        projection: {
          _id: 0,
          traceId: 1,
          sessionId: 1,
          pricingStatus: 1,
          totalCostMicrocents: 1,
          stampedCosts: 1,
        },
      },
    )
    .sort({ traceId: 1 })
    .toArray();

  const counters = await MongoDb.getCollection(TRACE_FILTER_COUNTERS_COLLECTION)
    .find({})
    .toArray();
  const sessions = (await MongoDb.getCollection(SESSION_SUMMARIES_COLLECTION)
    .find({}, { projection: { _id: 1, traceCount: 1 } })
    .sort({ _id: 1 })
    .toArray()) as unknown as Array<{ _id: string; traceCount: number }>;

  return {
    ms,
    aborted,
    traces,
    counterTotal: counters.reduce((sum, c) => sum + Number(c['count'] ?? 0), 0),
    sessions,
  };
};

describe('concurrent batch ingestion against Mongo (issue #102)', () => {
  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  it('MUST store the same traces, prices, counters and session summaries with 8 lanes as one at a time', async () => {
    const sequential = await run(1);
    const concurrent = await run(8);

    // Same documents, same stamps, including both sides of the price change.
    expect(concurrent.traces).toEqual(sequential.traces);
    expect(
      new Set(concurrent.traces.map((t) => t['totalCostMicrocents'])).size,
    ).toBeGreaterThan(1);

    // Every $inc landed exactly once, conflicts or not.
    expect(sequential.counterTotal).toBe(TOTAL);
    expect(concurrent.counterTotal).toBe(TOTAL);

    // Every session summary counts all of its traces.
    expect(concurrent.sessions).toEqual(sequential.sessions);
    expect(concurrent.sessions).toHaveLength(SESSIONS);
    for (const session of concurrent.sessions) {
      expect(session.traceCount).toBe(TRACES_PER_SESSION);
    }

    // The evidence the PR reports: conflicts retried by the driver and the local timing.
    process.stdout.write(
      `[#102] ${TOTAL} traces, ${SESSIONS} sessions, one counter document: ` +
        `sequential ${sequential.ms}ms (${sequential.aborted} aborted txns), ` +
        `8 lanes ${concurrent.ms}ms (${concurrent.aborted} aborted txns, retried)\n`,
    );
  });
});
