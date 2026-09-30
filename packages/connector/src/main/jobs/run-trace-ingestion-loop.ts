import {
  makeIngestFailureRepository,
  makeReprocessPendingUseCase,
  makeSyncBatchesUseCase,
  traceIngestionWorkerSettings,
} from '../factories/sync-factory.js';
import { makeDatabase } from '../factories/database-factory.js';
import { makeLogger } from '../factories/logger-factory.js';
import { beatWorkerHeartbeat } from './worker-heartbeat.js';
import {
  SweepState,
  afterSweepChunk,
  nextSweepAction,
} from './sweep-pacing.js';
import { assertIngestionIndexes } from '@observability/core/infrastructure/database/mongodb/helpers/assert-ingestion-indexes.js';

/**
 * T2 continuous form — the trace-ingestion-worker sidecar's entry point. An infinite
 * watermark loop, NOT a cron: a cycle drains the backlog in bounded
 * batches, then sleeps; by construction two cycles can never overlap.
 *
 * Shutdown contract: SIGTERM/SIGINT set a flag checked BETWEEN batches —
 * the in-flight batch always completes and advances the watermark before
 * exit. Graceful shutdown is a courtesy, not a correctness requirement:
 * a SIGKILL mid-batch just leaves the cursor un-advanced, and the re-read
 * batch is deduplicated by insertIfAbsent.
 *
 * Errors: the schema tripwire (startup) is FATAL — exit non-zero and let
 * the restart policy surface a visible crash loop instead of syncing an
 * unverified schema. Loop errors are treated as transient: logged, then
 * retried with doubling backoff (poison ROWS never even throw — the
 * source skips and records them, decision 62 + audit C-6.2; a poison
 * TRACE is dead-lettered by the use case, audit B-3).
 */
const logger = makeLogger({ component: 'trace-ingestion-worker' });

let stopping = false;
let wake: (() => void) | undefined;

const requestStop = (signal: string): void => {
  logger.info(
    'Trace ingestion worker: stop requested — finishing current batch',
    { signal },
  );
  stopping = true;
  wake?.();
};

process.on('SIGTERM', () => requestStop('SIGTERM'));
process.on('SIGINT', () => requestStop('SIGINT'));

/** Interruptible sleep — a stop signal cuts it short immediately. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    wake = (): void => {
      clearTimeout(timer);
      resolve();
    };
  });

const TRANSIENT_BACKOFF_BASE_MS = 5_000;
const TRANSIENT_BACKOFF_CAP_MS = 300_000;

/**
 * The worker's body, extracted so every exit path — including the idle
 * stack's — leaves through the caller's `finally` (re-audit 2026-08, sync
 * minors: the idle branch used to `process.exit(0)`, skipping the
 * disconnect entirely).
 */
const runWorker = async (): Promise<void> => {
  const batchSync = makeSyncBatchesUseCase();

  if (!batchSync) {
    // Pre-onboarding stack: no ClickHouse source to page. EXIT non-zero
    // (audit G-1): the old idle branch kept the process alive, so the
    // pgrep-style healthcheck read "healthy" for a worker that would
    // never ingest — green-while-dead, while the source's ~49-day
    // retention burned. A visible crash loop is the honest signal
    // (decision 117's preference), and onboarding's `make up` recreates
    // the worker with the source enabled. Nothing depends_on or waits on
    // this service's health, so the loop blocks nobody.
    logger.fatal(
      'Trace ingestion worker: continuous-sync source not configured — ' +
        'onboarding writes the project id that enables it (see ' +
        'clients/example.env). Exiting so the restart loop stays VISIBLE ' +
        'instead of idling green (audit G-1). Fixture-backed demos use ' +
        '`make sync` with TRACE_SOURCE=fixtures.',
    );
    process.exitCode = 1;

    return;
  }

  // Fatal by design: never sync through an unverified source schema —
  // and never write into a store whose idempotency index is missing
  // (audit G-2: without the unique traceId index, re-reads double-store
  // and the bill double-counts; `make migrate` is the only door).
  await assertIngestionIndexes();
  await batchSync.source.assertCompatibleSchema();

  // audit F-4: the resolved knobs in the first lines of the log — a
  // misconfigured knob must be visible without reading compose.
  logger.info('Trace ingestion worker: started', {
    intervalSeconds: traceIngestionWorkerSettings.intervalMs / 1000,
    reprocessIntervalSeconds:
      traceIngestionWorkerSettings.reprocessIntervalMs / 1000,
    reprocessMaxTracesPerCycle:
      traceIngestionWorkerSettings.reprocessMaxTracesPerCycle,
  });

  const ingestFailureRepository = makeIngestFailureRepository();

  let backoffMs = TRANSIENT_BACKOFF_BASE_MS;
  let sweepState: SweepState = { lastRoundEndedAt: 0 };

  while (!stopping) {
    let drainFailed = false;

    try {
      // Drain the backlog: batch after batch until caught up. The stop
      // flag is honored between batches — never mid-batch.
      let caughtUp = false;

      while (!caughtUp && !stopping) {
        const report = await batchSync.useCase.syncNextBatch();

        // Progress, not process existence (audit G-1): only a COMPLETED
        // batch beats. Error paths deliberately fall through without
        // beating, so an outage or a wedge ages the heartbeat and the
        // container turns unhealthy instead of green-while-dead.
        beatWorkerHeartbeat(undefined, logger);

        caughtUp = report.caughtUp;
      }

      backoffMs = TRANSIENT_BACKOFF_BASE_MS; // healthy cycle → reset
    } catch (error) {
      logger.error('Trace ingestion worker: cycle failed', {
        retryInSeconds: backoffMs / 1000,
        err: error,
      });
      drainFailed = true;
    }

    // re-audit 2026-08 (sync item 3): the dead-letter trail gets a voice.
    // Parked traces are traces the archive is MISSING (invariant 6), and
    // until now the only sign of them was the log line of the cycle that
    // wrote them. One cheap count per cycle, never per batch; a failing
    // count is reported, never fatal (the drain already owns the backoff).
    try {
      const deadLettered = await ingestFailureRepository.countUnresolved();

      if (deadLettered > 0) {
        logger.warn(
          'Trace ingestion worker: traces parked in the dead-letter trail ' +
            "(ingest_failures) — recover them with the README's Day-2 runbook",
          { deadLettered },
        );
      }
    } catch (error) {
      logger.warn(
        'Trace ingestion worker: dead-letter count unavailable this cycle',
        {
          err: error,
        },
      );
    }

    // Periodic reprocess sweep (decision 63: also triggered directly by
    // the price-insert job; this is the backstop cadence). Runs on its
    // OWN cadence regardless of drain success (audit B-3): a stalled
    // drain must not starve pending re-stamps.
    //
    // Decision 183: in capped chunks, one per cycle, resuming from the
    // cursor the previous chunk handed back — an uncapped sweep held
    // ingestion for hours on 2026-09-28. Traces with no model are skipped:
    // no price can stamp them. The chunk does NOT beat the heartbeat: the
    // sweep runs even when the drain failed, so beating here would keep a
    // worker whose ingestion is broken green. The chunk size keeps the next
    // drain's beat inside the healthcheck window instead.
    //
    // Accepted: the cursor lives in memory, so a restart mid-round starts
    // the round over; cheap now that model-less traces are out of the walk.
    // A trace that turns pending behind the cursor waits for the next round.
    const sweep = nextSweepAction(
      sweepState,
      Date.now(),
      traceIngestionWorkerSettings.reprocessIntervalMs,
    );

    if (!stopping && sweep.kind === 'run-chunk') {
      try {
        const report = await makeReprocessPendingUseCase().reprocess({
          maxTraces: traceIngestionWorkerSettings.reprocessMaxTracesPerCycle,
          onlyWithModel: true,
          ...(sweep.after ? { after: sweep.after } : {}),
        });
        sweepState = afterSweepChunk(
          report.resumeAfter,
          Date.now(),
          sweepState,
        );
      } catch (error) {
        // State untouched: the same chunk retries next cycle.
        logger.error(
          'Trace ingestion worker: reprocess sweep chunk failed (next cycle retries)',
          { err: error },
        );
      }
    }

    if (drainFailed) {
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, TRANSIENT_BACKOFF_CAP_MS);
      continue;
    }

    if (!stopping) {
      await sleep(traceIngestionWorkerSettings.intervalMs);
    }
  }

  logger.info('Trace ingestion worker: stopped cleanly');
};

const database = makeDatabase();

await database.connect();

try {
  await runWorker();
} finally {
  await database.disconnect();
}
