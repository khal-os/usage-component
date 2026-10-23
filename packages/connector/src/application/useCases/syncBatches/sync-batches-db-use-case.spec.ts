import {
  EffectivePrices,
  IngestFailureRecord,
  IngestFailureRepository,
  IngestTruncationRecord,
  InsertIfAbsentResult,
  PendingStamp,
  PriceVersionRepository,
  SourceTrace,
  SyncCursor,
  SyncStateRepository,
  TraceAttribution,
  TraceBatch,
  TraceBatchSource,
  TraceRepository,
} from './sync-batches-protocols.js';
import {
  PriceVersionModel,
  TokenType,
} from '@observability/core/domain/models/price-version-model.js';
import { TraceModel } from '@observability/core/domain/models/trace-model.js';
import { SyncBatchesDbUseCase } from './sync-batches-db-use-case.js';
import { RecordingLogger } from '@observability/core/common/logging/logging-test-fakes.js';
import { InMemoryBillingPeriodRepository } from '@observability/core/application/testSupport/billing-test-fakes.js';

const NOW = new Date('2026-07-23T15:00:00.000Z');
const QUIET_MS = 900_000;

/**
 * An infra-class store failure, in the SHAPE the driver produces (the
 * classifier is duck-typed on purpose — see isSystemicStoreError).
 */
const mongoNetworkError = (): Error => {
  const error = new Error('connection 4 to mongo:27017 closed');

  error.name = 'MongoNetworkError';

  return error;
};

const makeTrace = (traceId: string): SourceTrace => ({
  traceId,
  sessionId: 'sess-001',
  agent: { id: 'agent-atendimento' },
  model: 'openai/gpt-5-mini',
  type: 'chat',
  channel: { type: 'whatsapp' },
  startedAt: new Date('2026-07-23T14:00:00.000Z'),
  finishedAt: new Date('2026-07-23T14:00:04.000Z'),
  status: 'ok',
  tokens: { input: 1200, output: 350 },
  input: 'entrada',
  output: 'saída',
  spans: [],
});

const cursorOf = (traceId: string): SyncCursor => ({
  updatedAt: new Date('2026-07-23T14:30:00.000Z'),
  traceId,
});

class TraceBatchSourceStub implements TraceBatchSource {
  batch: TraceBatch = {
    traces: [makeTrace('trace-001')],
    nextCursor: cursorOf('trace-001'),
    scanned: 1,
  };
  calls: { after: SyncCursor | null; limit: number; updatedBefore: Date }[] =
    [];

  async fetchBatch(args: {
    after: SyncCursor | null;
    limit: number;
    updatedBefore: Date;
  }): Promise<TraceBatch> {
    this.calls.push(args);

    return this.batch;
  }

  async assertCompatibleSchema(): Promise<void> {
    // No-op stub — the schema tripwire is the real adapter's business.
  }
}

/** audit C-6.4: a source that CAN serve its own clock (skewed from the worker's). */
class ClockedTraceBatchSourceStub extends TraceBatchSourceStub {
  sourceClock = new Date(NOW.getTime() + 120_000);

  async sourceNow(): Promise<Date> {
    return this.sourceClock;
  }
}

class SyncStateRepositoryStub implements SyncStateRepository {
  cursor: SyncCursor | null = null;
  writes: SyncCursor[] = [];

  async getTraceCursor(): Promise<SyncCursor | null> {
    return this.cursor;
  }

  async setTraceCursor(cursor: SyncCursor): Promise<void> {
    this.writes.push(cursor);
    this.cursor = cursor;
  }
}

class PriceVersionRepositoryStub implements PriceVersionRepository {
  async findEffectivePrices(
    model: string,
    _atDate: Date,
  ): Promise<EffectivePrices> {
    const price = (tokenType: TokenType): PriceVersionModel => ({
      model,
      tokenType,
      pricingType: 'fixed_brl',
      priceMicrocentsPerMillion: 275_000_000,
      effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
    });

    return { input: price('input'), output: price('output') };
  }

  async insertVersion(): Promise<void> {}

  async listAllVersions(): Promise<PriceVersionModel[]> {
    return [];
  }
}

class TraceRepositoryStub implements TraceRepository {
  inserted: TraceModel[] = [];
  attributionUpdates: { traceId: string; attribution: TraceAttribution }[] = [];
  insertResult: InsertIfAbsentResult = 'inserted';
  failOn = new Set<string>();
  /** What a failOn trace throws — the classifier tests need infra shapes. */
  failWith: (traceId: string) => unknown = (traceId) =>
    new Error(`store down at ${traceId}`);

  async insertIfAbsent(trace: TraceModel): Promise<InsertIfAbsentResult> {
    if (this.failOn.has(trace.traceId)) {
      throw this.failWith(trace.traceId);
    }

    if (this.insertResult === 'inserted') {
      this.inserted.push(trace);
    }

    return this.insertResult;
  }

  async updateAttribution(
    traceId: string,
    attribution: TraceAttribution,
  ): Promise<{ modelPinnedByStamp: boolean }> {
    this.attributionUpdates.push({ traceId, attribution });

    return { modelPinnedByStamp: false };
  }

  async stampPendingTrace(
    _traceId: string,
    _stamp: PendingStamp,
  ): Promise<'stamped' | 'skipped'> {
    return 'skipped';
  }

  async findPendingPrice(_limit: number): Promise<TraceModel[]> {
    return [];
  }

  async countPendingPrice(): Promise<number> {
    return 0;
  }

  // Port member (audit B-1) — the batch sync never reconciles; no-op stub.
  async reconcileQuarantineAfterClose(): Promise<{
    flaggedStragglers: number;
    absorbed: number;
  }> {
    return { flaggedStragglers: 0, absorbed: 0 };
  }
}

class IngestFailureRepositoryStub implements IngestFailureRepository {
  failures: IngestFailureRecord[] = [];
  truncations: IngestTruncationRecord[] = [];

  async recordFailure(record: IngestFailureRecord): Promise<void> {
    this.failures.push(record);
  }

  async recordTruncation(record: IngestTruncationRecord): Promise<void> {
    this.truncations.push(record);
  }

  async countUnresolved(): Promise<number> {
    return this.failures.length;
  }
}

const makeSut = (args?: {
  batchSize?: number;
  traceBatchSource?: TraceBatchSourceStub;
  traceRepository?: TraceRepositoryStub;
  concurrency?: number;
}) => {
  const traceBatchSourceStub =
    args?.traceBatchSource ?? new TraceBatchSourceStub();
  const syncStateRepositoryStub = new SyncStateRepositoryStub();
  const priceVersionRepositoryStub = new PriceVersionRepositoryStub();
  const traceRepositoryStub =
    args?.traceRepository ?? new TraceRepositoryStub();
  const ingestFailureRepositoryStub = new IngestFailureRepositoryStub();
  const billingPeriodRepository = new InMemoryBillingPeriodRepository();
  const logger = new RecordingLogger();
  const sut = new SyncBatchesDbUseCase({
    traceBatchSource: traceBatchSourceStub,
    syncStateRepository: syncStateRepositoryStub,
    priceVersionRepository: priceVersionRepositoryStub,
    traceRepository: traceRepositoryStub,
    billingPeriodRepository,
    ingestFailureRepository: ingestFailureRepositoryStub,
    estimateDocumentBytes: (): number => 1024,
    batchSize: args?.batchSize ?? 2,
    quietPeriodMs: QUIET_MS,
    ...(args?.concurrency === undefined
      ? {}
      : { concurrency: args.concurrency }),
    now: () => NOW,
    logger,
  });

  return {
    sut,
    logger,
    traceBatchSourceStub,
    syncStateRepositoryStub,
    traceRepositoryStub,
    ingestFailureRepositoryStub,
    billingPeriodRepository,
  };
};

describe('SyncBatchesDbUseCase', () => {
  it('MUST fetch past the stored cursor with the quiet-period ceiling', async () => {
    const { sut, traceBatchSourceStub, syncStateRepositoryStub } = makeSut();

    syncStateRepositoryStub.cursor = cursorOf('trace-000');

    await sut.syncNextBatch();

    expect(traceBatchSourceStub.calls).toEqual([
      {
        after: cursorOf('trace-000'),
        limit: 2,
        updatedBefore: new Date(NOW.getTime() - QUIET_MS),
      },
    ]);
  });

  it('MUST anchor the quiet-period ceiling on the SOURCE clock when the source serves one (audit C-6.4)', async () => {
    const clockedSource = new ClockedTraceBatchSourceStub();
    const { sut, traceBatchSourceStub } = makeSut({
      traceBatchSource: clockedSource,
    });

    await sut.syncNextBatch();

    // Worker clock (NOW) is 2 min behind the source's — using it would
    // shrink the quiet period; the ceiling must ride the source clock.
    expect(traceBatchSourceStub.calls[0]?.updatedBefore).toEqual(
      new Date(clockedSource.sourceClock.getTime() - QUIET_MS),
    );
  });

  it('MUST ingest the batch and only then advance the cursor (work first, bookmark second)', async () => {
    const { sut, syncStateRepositoryStub, traceRepositoryStub } = makeSut();

    const report = await sut.syncNextBatch();

    expect(traceRepositoryStub.inserted.map((trace) => trace.traceId)).toEqual([
      'trace-001',
    ]);
    expect(syncStateRepositoryStub.writes).toEqual([cursorOf('trace-001')]);
    expect(report).toMatchObject({ scanned: 1, inserted: 1, caughtUp: true });
  });

  it('MUST dead-letter a poison trace mid-batch, continue, and STILL advance the cursor (audit B-3)', async () => {
    const {
      sut,
      traceBatchSourceStub,
      syncStateRepositoryStub,
      traceRepositoryStub,
      ingestFailureRepositoryStub,
    } = makeSut();

    traceBatchSourceStub.batch = {
      traces: [makeTrace('trace-001'), makeTrace('trace-002')],
      nextCursor: cursorOf('trace-002'),
      scanned: 2,
    };
    traceRepositoryStub.failOn.add('trace-002');

    const report = await sut.syncNextBatch();

    // The poison trace no longer blocks the cursor — the dead-letter row
    // is the recovery trail; head-of-line blocking was the B-3 bug.
    expect(report).toMatchObject({ scanned: 2, inserted: 1, failed: 1 });
    expect(syncStateRepositoryStub.writes).toEqual([cursorOf('trace-002')]);
    expect(ingestFailureRepositoryStub.failures).toEqual([
      expect.objectContaining({
        traceId: 'trace-002',
        kind: 'ingest_failure',
        context: 'cursor=start',
        error: expect.stringContaining('store down at trace-002'),
      }),
    ]);
  });

  it('MUST dead-letter a SMALL all-failing batch (trace-shaped errors) and STILL advance — documented steady-state semantics', async () => {
    const {
      sut,
      traceBatchSourceStub,
      syncStateRepositoryStub,
      ingestFailureRepositoryStub,
      traceRepositoryStub,
    } = makeSut({ batchSize: 10 });

    const traces = Array.from({ length: 3 }, (_, index) =>
      makeTrace(`trace-${index}`),
    );

    traceBatchSourceStub.batch = {
      traces,
      nextCursor: cursorOf('trace-2'),
      scanned: 3,
    };
    for (const trace of traces) {
      traceRepositoryStub.failOn.add(trace.traceId);
    }

    const report = await sut.syncNextBatch();

    expect(report).toMatchObject({ scanned: 3, inserted: 0, failed: 3 });
    expect(ingestFailureRepositoryStub.failures).toHaveLength(3);
    // Below the ≥10 breaker, three poison traces are three poison traces —
    // parking them and moving on is the B-3 contract.
    expect(syncStateRepositoryStub.writes).toEqual([cursorOf('trace-2')]);
  });

  it('MUST rethrow an INFRA-class failure without parking or advancing — the steady-state hole the ≥10 breaker cannot see (re-audit sync item 2)', async () => {
    const {
      sut,
      traceBatchSourceStub,
      syncStateRepositoryStub,
      ingestFailureRepositoryStub,
      traceRepositoryStub,
    } = makeSut({ batchSize: 10 });

    const traces = Array.from({ length: 3 }, (_, index) =>
      makeTrace(`trace-${index}`),
    );

    traceBatchSourceStub.batch = {
      traces,
      nextCursor: cursorOf('trace-2'),
      scanned: 3,
    };
    for (const trace of traces) {
      traceRepositoryStub.failOn.add(trace.traceId);
    }
    traceRepositoryStub.failWith = mongoNetworkError;

    await expect(sut.syncNextBatch()).rejects.toThrow(/connection 4 to mongo/);

    // The watermark must NOT move over traces the store could not take,
    // and no dead letter may claim they were examined and rejected.
    expect(syncStateRepositoryStub.writes).toEqual([]);
    expect(ingestFailureRepositoryStub.failures).toEqual([]);
  });

  it('MUST rethrow a transaction-labelled failure too (TransientTransactionError)', async () => {
    const { sut, traceRepositoryStub, syncStateRepositoryStub } = makeSut();

    traceRepositoryStub.failOn.add('trace-001');
    traceRepositoryStub.failWith = (): unknown =>
      Object.assign(new Error('transaction aborted'), {
        hasErrorLabel: (label: string) => label === 'TransientTransactionError',
      });

    await expect(sut.syncNextBatch()).rejects.toThrow(/transaction aborted/);
    expect(syncStateRepositoryStub.writes).toEqual([]);
  });

  it('MUST quarantine a PAST-month trace whose month closed after the cycle read its set (re-audit sync item 5)', async () => {
    const { sut, traceRepositoryStub, billingPeriodRepository } = makeSut();

    await billingPeriodRepository.markClosed({
      year: 2026,
      month: 7,
      closedAt: new Date('2026-08-01T00:00:00.000Z'),
      snapshotVersion: 1,
      audit: {
        at: new Date('2026-08-01T00:00:00.000Z'),
        action: 'close',
        trigger: 'runbook',
        snapshotVersion: 1,
      },
    });
    // THE stale set: what a cycle that started before the close saw.
    jest.spyOn(billingPeriodRepository, 'listAll').mockResolvedValue([]);

    const report = await sut.syncNextBatch();

    expect(report.quarantined).toBe(1);
    expect(traceRepositoryStub.inserted[0]?.billingQuarantine).toEqual(
      expect.objectContaining({ reason: 'period_closed' }),
    );
  });

  it('MUST throw WITHOUT advancing when every trace of a non-trivial batch fails — store outage, not poison (audit B-3 breaker)', async () => {
    const {
      sut,
      traceBatchSourceStub,
      syncStateRepositoryStub,
      traceRepositoryStub,
    } = makeSut({ batchSize: 10 });

    const traces = Array.from({ length: 10 }, (_, index) =>
      makeTrace(`trace-${index}`),
    );

    traceBatchSourceStub.batch = {
      traces,
      nextCursor: cursorOf('trace-9'),
      scanned: 10,
    };
    for (const trace of traces) {
      traceRepositoryStub.failOn.add(trace.traceId);
    }

    await expect(sut.syncNextBatch()).rejects.toThrow(/store outage/);

    // Crash story preserved: cursor untouched → the batch is re-read next
    // cycle and deduplicated by insertIfAbsent.
    expect(syncStateRepositoryStub.writes).toEqual([]);
  });

  it('MUST keep the cursor untouched on an empty batch', async () => {
    const { sut, traceBatchSourceStub, syncStateRepositoryStub } = makeSut();

    traceBatchSourceStub.batch = { traces: [], nextCursor: null, scanned: 0 };

    const report = await sut.syncNextBatch();

    expect(syncStateRepositoryStub.writes).toEqual([]);
    expect(report).toMatchObject({ scanned: 0, caughtUp: true });
  });

  it('MUST report caughtUp false while full batches keep coming', async () => {
    const { sut, traceBatchSourceStub } = makeSut({ batchSize: 1 });

    traceBatchSourceStub.batch = {
      traces: [makeTrace('trace-001')],
      nextCursor: cursorOf('trace-001'),
      scanned: 1,
    };

    const report = await sut.syncNextBatch();

    expect(report.caughtUp).toBe(false);
  });

  it('MUST refresh attribution (never the stamp) for already-stored traces', async () => {
    const { sut, traceRepositoryStub } = makeSut();

    traceRepositoryStub.insertResult = 'skipped';

    const report = await sut.syncNextBatch();

    expect(report).toMatchObject({ inserted: 0, skipped: 1 });
    expect(traceRepositoryStub.attributionUpdates).toHaveLength(1);
  });

  it('MUST count token divergence on a skipped re-sync that reports a different stored total (audit B-4 residual, Q3)', async () => {
    const { sut, logger, traceRepositoryStub } = makeSut();

    traceRepositoryStub.insertResult = {
      outcome: 'skipped',
      storedTokensTotal: 100, // source now says 1200 + 350
    };

    const report = await sut.syncNextBatch();

    expect(report).toMatchObject({ skipped: 1, tokenDivergence: 1 });
    expect(logger.messages('warn').join('\n')).toContain(
      'divergent token totals',
    );
  });

  it('MUST crash — not re-drain — when the source returns a cursor that does not advance (audit A-3)', async () => {
    // The CAS on the stored watermark refuses a regression, but the LOOP
    // used to keep going: caughtUp stayed false and the worker re-fetched
    // the identical batch forever with no error, no backoff and no dead
    // letter. A non-advancing cursor is a broken source (the epoch-0
    // coercion built one once) and must surface as a retryable failure.
    const { sut, traceBatchSourceStub, syncStateRepositoryStub } = makeSut();

    syncStateRepositoryStub.cursor = cursorOf('trace-001');
    traceBatchSourceStub.batch = {
      traces: [makeTrace('trace-001')],
      nextCursor: cursorOf('trace-001'), // identical tuple: zero progress
      scanned: 1,
    };

    await expect(sut.syncNextBatch()).rejects.toThrow(/failed to advance/);
  });

  describe('session lanes (issue #102)', () => {
    /** Holds every insert open for a few ticks so overlap is observable. */
    class SlowTraceRepositoryStub extends TraceRepositoryStub {
      inFlight = 0;
      peak = 0;
      bySession = new Map<string, number>();
      sessionPeak = 0;

      override async insertIfAbsent(
        trace: TraceModel,
      ): Promise<InsertIfAbsentResult> {
        const session = trace.sessionId ?? trace.traceId;

        this.inFlight += 1;
        this.peak = Math.max(this.peak, this.inFlight);
        this.bySession.set(session, (this.bySession.get(session) ?? 0) + 1);
        this.sessionPeak = Math.max(
          this.sessionPeak,
          this.bySession.get(session) ?? 0,
        );

        for (let i = 0; i < 3; i += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }

        this.bySession.set(session, (this.bySession.get(session) ?? 1) - 1);
        this.inFlight -= 1;

        return super.insertIfAbsent(trace);
      }
    }

    const tracesIn = (sessions: string[]): SourceTrace[] =>
      sessions.map((sessionId, index) => ({
        ...makeTrace(`trace-${index}`),
        sessionId,
      }));

    it('MUST write traces of different sessions concurrently, up to the configured limit', async () => {
      const slow = new SlowTraceRepositoryStub();
      const { sut, traceBatchSourceStub, syncStateRepositoryStub } = makeSut({
        batchSize: 10,
        traceRepository: slow,
        concurrency: 3,
      });
      const traces = tracesIn(['a', 'b', 'c', 'd', 'e', 'f']);

      traceBatchSourceStub.batch = {
        traces,
        nextCursor: cursorOf('trace-5'),
        scanned: traces.length,
      };

      const report = await sut.syncNextBatch();

      expect(report.inserted).toBe(6);
      expect(slow.peak).toBe(3);
      expect(syncStateRepositoryStub.writes).toEqual([cursorOf('trace-5')]);
    });

    it('MUST keep traces of one session strictly one at a time', async () => {
      const slow = new SlowTraceRepositoryStub();
      const { sut, traceBatchSourceStub } = makeSut({
        batchSize: 10,
        traceRepository: slow,
        concurrency: 8,
      });
      const traces = tracesIn(['s1', 's1', 's2', 's1', 's2', 's1']);

      traceBatchSourceStub.batch = {
        traces,
        nextCursor: cursorOf('trace-5'),
        scanned: traces.length,
      };

      await sut.syncNextBatch();

      expect(slow.sessionPeak).toBe(1);
      expect(
        slow.inserted
          .filter((trace) => trace.sessionId === 's1')
          .map((trace) => trace.traceId),
      ).toEqual(['trace-0', 'trace-1', 'trace-3', 'trace-5']);
    });

    it('MUST rethrow a systemic failure in one lane without advancing the cursor, while other lanes were in flight', async () => {
      const slow = new SlowTraceRepositoryStub();
      const {
        sut,
        traceBatchSourceStub,
        syncStateRepositoryStub,
        ingestFailureRepositoryStub,
      } = makeSut({ batchSize: 10, traceRepository: slow, concurrency: 4 });
      const traces = tracesIn(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

      traceBatchSourceStub.batch = {
        traces,
        nextCursor: cursorOf('trace-7'),
        scanned: traces.length,
      };
      slow.failOn.add('trace-1');
      slow.failWith = mongoNetworkError;

      await expect(sut.syncNextBatch()).rejects.toThrow(
        /connection 4 to mongo/,
      );

      expect(syncStateRepositoryStub.writes).toEqual([]);
      expect(ingestFailureRepositoryStub.failures).toEqual([]);
    });

    it('MUST dead-letter a trace-shaped failure in one lane and keep the others going', async () => {
      const slow = new SlowTraceRepositoryStub();
      const {
        sut,
        traceBatchSourceStub,
        syncStateRepositoryStub,
        ingestFailureRepositoryStub,
      } = makeSut({ batchSize: 10, traceRepository: slow, concurrency: 4 });
      const traces = tracesIn(['a', 'b', 'c', 'd']);

      traceBatchSourceStub.batch = {
        traces,
        nextCursor: cursorOf('trace-3'),
        scanned: traces.length,
      };
      slow.failOn.add('trace-2');

      const report = await sut.syncNextBatch();

      expect(report.inserted).toBe(3);
      expect(report.failed).toBe(1);
      expect(
        ingestFailureRepositoryStub.failures.map((f) => f.traceId),
      ).toEqual(['trace-2']);
      expect(syncStateRepositoryStub.writes).toEqual([cursorOf('trace-3')]);
    });
  });
});
