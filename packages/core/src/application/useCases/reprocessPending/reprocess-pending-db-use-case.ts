import {
  PendingPriceFilter,
  PriceVersionRepository,
  ReprocessOptions,
  ReprocessPendingUseCase,
  ReprocessReport,
  TraceRepository,
} from './reprocess-pending-protocols.js';
import { BillingPeriodRepository } from '../../interfaces/billing-period-repository.js';
import { modelKey } from '../../../domain/models/model-ref.js';
import { stampTokens } from '../priceStamping/price-stamper.js';
import {
  PendingPriceCursor,
  PendingPriceTrace,
} from '../../interfaces/trace-repository.js';
import {
  closedMonthKeys,
  monthKeyOf,
} from '../../../domain/models/month-key.js';
import { Logger } from '../../../common/logging/logger.js';
import { nullLogger } from '../../../common/logging/null-logger.js';

/**
 * US3/T5: when the missing price is finally registered, pending traces get
 * stamped — with the SAME rule as ingestion.
 *
 * T6 guard: a pending trace dated inside a CLOSED month is never stamped
 * here — its bill is frozen; only the audited reopen flow unblocks it.
 * Counted in the report (`blockedClosedMonth`) so the admin sees them.
 */
/**
 * One sweep page (audit B-5): bounds memory AND the unit of progress the
 * loop measures. 500 keeps a page's serial round-trips comfortably under
 * a second against a local store.
 */
const REPROCESS_PAGE_SIZE = 500;

export class ReprocessPendingDbUseCase implements ReprocessPendingUseCase {
  private readonly priceVersionRepository: PriceVersionRepository;
  private readonly traceRepository: TraceRepository;
  private readonly billingPeriodRepository: BillingPeriodRepository;
  private readonly logger: Logger;

  constructor(args: {
    priceVersionRepository: PriceVersionRepository;
    traceRepository: TraceRepository;
    billingPeriodRepository: BillingPeriodRepository;
    logger?: Logger;
  }) {
    this.priceVersionRepository = args.priceVersionRepository;
    this.traceRepository = args.traceRepository;
    this.billingPeriodRepository = args.billingPeriodRepository;
    this.logger = args.logger ?? nullLogger;
  }

  async reprocess(options?: ReprocessOptions): Promise<ReprocessReport> {
    // re-audit 2026-08 (sync item 6): the SAME closed-month key rule as
    // ingestion, imported instead of re-derived — trace-ingestor already
    // called these shared, and two copies of a month key is exactly how
    // "stamped here but blocked there" divergence starts.
    const closedMonths = closedMonthKeys(
      await this.billingPeriodRepository.listAll(),
    );

    const report: ReprocessReport = {
      examined: 0,
      stamped: 0,
      stillPending: 0,
      failed: 0,
      blockedClosedMonth: 0,
      pendingRemaining: 0,
    };

    // audit B-5: PAGED, never all-at-once — the unbounded read let
    // POST /prices run a whole day of an unpriced model's backlog (~33k
    // traces, ~165k serial Mongo ops) inside one HTTP request; a proxy
    // timeout then aborted the response while the loop kept running.
    // `maxTraces` caps a single run (the HTTP door and the worker's sweep
    // pass it; the runbook job stays uncapped) — whatever a capped run
    // leaves behind is reported honestly in pendingRemaining, and the
    // capped run hands back `resumeAfter` so the next one continues from
    // there instead of re-reading the head of the queue (decision 183).
    //
    // Pages walk the (startedAt, traceId) tuple FORWARD: traces a page
    // could not move (blocked closed month, still-pending, failed) are
    // walked PAST, never re-read at the head — a >page-size clog of
    // closed-month traces must not starve the stampable ones behind it.
    const cap = options?.maxTraces ?? Number.POSITIVE_INFINITY;
    const filter: PendingPriceFilter = {
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.onlyWithModel ? { withModelOnly: true } : {}),
    };
    let after: PendingPriceCursor | undefined = options?.after;
    let reachedEnd = false;

    while (report.examined < cap) {
      const pageSize = Math.min(REPROCESS_PAGE_SIZE, cap - report.examined);
      const pendingTraces = await this.traceRepository.findPendingPrice(
        pageSize,
        after,
        filter,
      );

      if (pendingTraces.length === 0) {
        reachedEnd = true;
        break;
      }

      await this.reprocessPage(pendingTraces, closedMonths, report);

      const last = pendingTraces[pendingTraces.length - 1] as PendingPriceTrace;
      after = { startedAt: last.startedAt, traceId: last.traceId };

      if (pendingTraces.length < pageSize) {
        reachedEnd = true;
        break;
      }
    }

    // Stopped by the cap with a full last page: there may be more queue.
    // When the cap lands exactly on the end, the next run reads one empty
    // page and reports the end — harmless.
    if (!reachedEnd && after) report.resumeAfter = after;

    report.pendingRemaining = await this.traceRepository.countPendingPrice();

    this.logReport(report, filter);

    return report;
  }

  private async reprocessPage(
    pendingTraces: PendingPriceTrace[],
    closedMonths: Set<string>,
    report: ReprocessReport,
  ): Promise<void> {
    report.examined += pendingTraces.length;

    for (const trace of pendingTraces) {
      if (closedMonths.has(monthKeyOf(trace.startedAt))) {
        report.blockedClosedMonth += 1;
        continue;
      }

      // Per-trace isolation (decision 79): one throwing trace must not
      // lose the whole run — the sweep is rerunnable and every other
      // trace's stamp is independent of this one.
      try {
        // QA19: same as-of rule as the sync — the price version effective
        // on the TRACE's date, never "the latest price now".
        const effectivePrices = trace.model
          ? await this.priceVersionRepository.findEffectivePrices(
              modelKey(trace.model),
              trace.startedAt,
            )
          : {};

        const stamp = stampTokens(
          trace.tokens,
          effectivePrices,
          trace.model !== undefined && trace.model !== null,
        );

        // Only a full stamp proceeds. 'pending_price' is the expected
        // other arm; 'no_measured_usage' is UNREACHABLE from the pending
        // set (pending requires a used token type, decision 128) but the
        // exhaustive guard keeps a future stamper change from silently
        // writing a partial stamp here.
        if (stamp.pricingStatus !== 'stamped') {
          report.stillPending += 1;
          continue;
        }

        // A 'skipped' result means the trace moved between our read and
        // our write: either a concurrent reprocess stamped it (it IS
        // stamped — reporting still-pending would be false) or a
        // concurrent attribution correction changed the model (audit B-5:
        // the CAS is pinned to the model these prices were resolved for),
        // in which case the NEXT sweep re-reads fresh and settles it.
        await this.traceRepository.stampPendingTrace(
          trace.traceId,
          {
            stampedCosts: stamp.stampedCosts,
            totalCostMicrocents: stamp.totalCostMicrocents,
            stampedAt: new Date(),
          },
          trace.model ?? null,
        );

        report.stamped += 1;
      } catch (error) {
        report.failed += 1;
        this.logger.warn('Reprocess pending: trace failed and was skipped', {
          traceId: trace.traceId,
          err: error,
        });
      }
    }
  }

  private logReport(report: ReprocessReport, filter: PendingPriceFilter): void {
    this.logger.info('Reprocess pending: sweep finished', {
      // Decision 183: examined/stamped count only this scope;
      // pendingRemaining is always the whole queue.
      scope: filter.model
        ? modelKey(filter.model)
        : filter.withModelOnly
          ? 'with-model'
          : 'all',
      examined: report.examined,
      stamped: report.stamped,
      stillPending: report.stillPending,
      failed: report.failed,
      blockedClosedMonth: report.blockedClosedMonth,
      pendingRemaining: report.pendingRemaining,
      // Decision 183: false = capped mid-queue, the caller resumes from here.
      reachedEnd: report.resumeAfter === undefined,
    });
  }
}
