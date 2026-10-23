import {
  BatchSyncReport,
  IngestFailureRepository,
  PriceVersionRepository,
  SyncBatchesUseCase,
  SyncCursor,
  SyncStateRepository,
  TraceBatchSource,
  TraceRepository,
} from './sync-batches-protocols.js';
import { EstimateDocumentBytes } from '../../interfaces/ingest-failure-repository.js';
import {
  assertNotAllFailed,
  ingestFailureKindOf,
  ingestSourceTrace,
  isSystemicStoreError,
} from '../syncTraces/trace-ingestor.js';
import { closedMonthKeys } from '@observability/core/domain/models/month-key.js';
import { BillingPeriodRepository } from '@observability/core/application/interfaces/billing-period-repository.js';
import { Logger } from '@observability/core/common/logging/logger.js';
import { nullLogger } from '@observability/core/common/logging/null-logger.js';
import { BatchPriceCache } from './batch-price-cache.js';
import { runInLanes } from './run-in-lanes.js';

/** Traces written at once by default (issue #102); same-session traces stay sequential. */
export const DEFAULT_INGESTION_CONCURRENCY = 8;

/**
 * One bounded step of the watermark loop (T2 continuous form). The
 * protocol that makes every failure mode safe:
 *
 *   1. read cursor → 2. fetch ≤ batchSize rows past it → 3. ingest ALL of
 *   them → 4. only then persist the advanced cursor.
 *
 * A crash anywhere leaves the cursor un-advanced; the re-read batch is
 * deduplicated by insertIfAbsent. Work first, bookmark second — never the
 * other way around. Memory is bounded by batchSize per step, regardless
 * of backlog size.
 *
 * audit B-3: "ingest ALL of them" tolerates per-trace poison — a failing
 * trace is dead-lettered (ingest_failures) and the batch continues, so
 * one deterministic failure can no longer park the cursor forever while
 * the source's ~49-day retention burns. The cursor still advances only
 * after the batch was fully SCANNED; an all-fail batch (store outage,
 * not poison) throws without advancing.
 */
export class SyncBatchesDbUseCase implements SyncBatchesUseCase {
  private readonly traceBatchSource: TraceBatchSource;
  private readonly syncStateRepository: SyncStateRepository;
  private readonly priceVersionRepository: PriceVersionRepository;
  private readonly traceRepository: TraceRepository;
  private readonly billingPeriodRepository: BillingPeriodRepository;
  private readonly ingestFailureRepository: IngestFailureRepository;
  private readonly estimateDocumentBytes: EstimateDocumentBytes;
  private readonly batchSize: number;
  private readonly quietPeriodMs: number;
  private readonly concurrency: number;
  private readonly now: () => Date;
  private readonly elapsedMs: () => number;
  private readonly logger: Logger;

  constructor(args: {
    traceBatchSource: TraceBatchSource;
    syncStateRepository: SyncStateRepository;
    priceVersionRepository: PriceVersionRepository;
    traceRepository: TraceRepository;
    billingPeriodRepository: BillingPeriodRepository;
    ingestFailureRepository: IngestFailureRepository;
    estimateDocumentBytes: EstimateDocumentBytes;
    batchSize: number;
    /** decision 61: only rows quiet for this long are eligible — the
     * source builds traces incrementally and the stamp is immutable. */
    quietPeriodMs: number;
    /**
     * issue #102: traces written at once. Each trace still costs its own
     * round trips (price lookup, insert transaction, session recompute);
     * running several at once overlaps that latency. 1 restores the old
     * one-at-a-time loop.
     */
    concurrency?: number;
    /** Test seam. */
    now?: () => Date;
    /** Monotonic clock for the batch phase durations. Test seam. */
    elapsedMs?: () => number;
    logger?: Logger;
  }) {
    this.traceBatchSource = args.traceBatchSource;
    this.syncStateRepository = args.syncStateRepository;
    this.priceVersionRepository = args.priceVersionRepository;
    this.traceRepository = args.traceRepository;
    this.billingPeriodRepository = args.billingPeriodRepository;
    this.ingestFailureRepository = args.ingestFailureRepository;
    this.estimateDocumentBytes = args.estimateDocumentBytes;
    this.batchSize = args.batchSize;
    this.quietPeriodMs = args.quietPeriodMs;
    this.concurrency = args.concurrency ?? DEFAULT_INGESTION_CONCURRENCY;
    this.now = args.now ?? ((): Date => new Date());
    this.elapsedMs = args.elapsedMs ?? ((): number => performance.now());
    this.logger = args.logger ?? nullLogger;
  }

  async syncNextBatch(): Promise<BatchSyncReport> {
    // Phase durations for the batch log: a cycle's time was one number,
    // and #102's lanes could not be judged against a ClickHouse fetch whose
    // cost swings by minutes. fetchMs is the source read, writeMs the store.
    const startedAt = this.elapsedMs();
    const cursor: SyncCursor | null =
      await this.syncStateRepository.getTraceCursor();

    // audit C-6.4: the quiet period is measured against the SOURCE's
    // write times, so it must use the SOURCE's clock when one is
    // available — a worker clock N minutes behind the source silently
    // shrinks the 15-minute quiet period to 15−N (partial-stamp hole).
    const now = this.traceBatchSource.sourceNow
      ? await this.traceBatchSource.sourceNow()
      : this.now();

    const batch = await this.traceBatchSource.fetchBatch({
      after: cursor,
      limit: this.batchSize,
      updatedBefore: new Date(now.getTime() - this.quietPeriodMs),
    });
    const fetchedAt = this.elapsedMs();

    // Strict monotonicity or crash (audit A-3). fetchBatch queries
    // strictly AFTER the cursor tuple, so a legitimate next cursor is
    // always strictly greater; anything else means the source built a
    // broken cursor (the epoch-0 coercion once did), and without this
    // guard the drain loop re-fetches the identical batch forever with
    // no error, no backoff and no dead letter — the CAS below protects
    // the STORED watermark, not the loop. Throwing hands the worker's
    // transient-backoff path a visible, retryable failure instead.
    if (cursor && batch.nextCursor) {
      const previousMs = cursor.updatedAt.getTime();
      const nextMs = batch.nextCursor.updatedAt.getTime();

      if (
        nextMs < previousMs ||
        (nextMs === previousMs && batch.nextCursor.traceId <= cursor.traceId)
      ) {
        throw new Error(
          `Sync: batch cursor failed to advance — next ` +
            `(${batch.nextCursor.updatedAt.toISOString()}, ${batch.nextCursor.traceId}) ` +
            `is not strictly after ` +
            `(${cursor.updatedAt.toISOString()}, ${cursor.traceId}). ` +
            'Refusing to re-drain the same batch (audit A-3).',
        );
      }
    }

    const report: BatchSyncReport = {
      scanned: batch.scanned,
      inserted: 0,
      skipped: 0,
      pendingPrice: 0,
      quarantined: 0,
      failed: 0,
      tokenDivergence: 0,
      caughtUp: batch.scanned < this.batchSize,
    };

    // audit C-7.3: one listAll per cycle, not one period lookup per trace
    // (see closedMonthKeys for why a cycle-start read is safe).
    const closedMonths =
      batch.traces.length > 0
        ? closedMonthKeys(await this.billingPeriodRepository.listAll())
        : new Set<string>();

    const context = cursor
      ? `cursor=(${cursor.updatedAt.toISOString()}, ${cursor.traceId})`
      : 'cursor=start';

    // issue #102: one price lookup per model interval instead of one per
    // trace, rebuilt every batch so a newly registered price is seen next.
    const priceVersionRepository = new BatchPriceCache(
      this.priceVersionRepository,
    );

    // issue #102: up to `concurrency` traces in flight; traces of one
    // session stay in one lane, in order (see runInLanes). A systemic error
    // thrown below stops the batch exactly as the sequential loop did: the
    // in-flight traces finish, the error propagates, the cursor stays put.
    await runInLanes(
      batch.traces,
      (trace) =>
        trace.sessionId
          ? `session:${trace.sessionId}`
          : `trace:${trace.traceId}`,
      this.concurrency,
      async (trace) => {
        try {
          const result = await ingestSourceTrace(
            {
              priceVersionRepository,
              traceRepository: this.traceRepository,
              billingPeriodRepository: this.billingPeriodRepository,
              ingestFailureRepository: this.ingestFailureRepository,
              estimateDocumentBytes: this.estimateDocumentBytes,
              logger: this.logger,
            },
            trace,
            closedMonths,
          );

          if (result.quarantined) {
            report.quarantined += 1;
          }

          if (result.outcome === 'inserted') {
            report.inserted += 1;

            if (result.pendingPrice) {
              report.pendingPrice += 1;
            }

            return;
          }

          if (result.tokenDivergence) {
            report.tokenDivergence += 1;
          }

          report.skipped += 1;
        } catch (error) {
          // re-audit 2026-08 (sync item 2): an infra-class failure is not
          // poison. Dead-lettering it would park good traces AND advance the
          // watermark past them — the steady-state hole the ≥10 breaker
          // cannot see (a caught-up worker runs 1–9-trace batches). Rethrow:
          // the batch aborts BEFORE the bookmark, the cursor stays put.
          if (isSystemicStoreError(error)) {
            throw error;
          }

          // audit B-3: per-trace isolation — the dead-letter row is the
          // recovery trail; the batch continues and the cursor advances
          // past the poison trace instead of re-reading it forever.
          report.failed += 1;
          this.logger.warn(
            'Sync: trace failed ingestion and was dead-lettered',
            {
              traceId: trace.traceId,
              err: error,
            },
          );
          await this.ingestFailureRepository.recordFailure({
            traceId: trace.traceId,
            kind: ingestFailureKindOf(error),
            context,
            error: String(error),
            seenAt: new Date(),
          });
        }
      },
    );

    // audit B-3 breaker: an all-fail non-trivial batch is a store outage,
    // not poison — throw BEFORE the bookmark, keeping the batch re-runnable.
    assertNotAllFailed(batch.traces.length, report.failed);
    const writtenAt = this.elapsedMs();

    // Only now — the whole batch is in the store or dead-lettered (work
    // first, bookmark second). An empty batch keeps the cursor untouched.
    if (batch.nextCursor !== null) {
      await this.syncStateRepository.setTraceCursor(batch.nextCursor);
    }

    if (report.scanned > 0) {
      this.logger.info('Sync: batch finished', {
        scanned: report.scanned,
        inserted: report.inserted,
        skipped: report.skipped,
        pendingPrice: report.pendingPrice,
        failed: report.failed,
        ...(report.tokenDivergence > 0
          ? { tokenDivergence: report.tokenDivergence }
          : {}),
        caughtUp: report.caughtUp,
        concurrency: this.concurrency,
        fetchMs: Math.round(fetchedAt - startedAt),
        writeMs: Math.round(writtenAt - fetchedAt),
        totalMs: Math.round(this.elapsedMs() - startedAt),
      });
    }

    return report;
  }
}
