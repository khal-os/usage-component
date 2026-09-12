import {
  BillingCloseBlockedError,
  BillingPeriodRepository,
  BillingPeriodStateError,
  BillingQueryRepository,
  BillingSnapshotRepository,
  CloseBillingPeriodResult,
  CloseBillingPeriodUseCase,
  TraceRepository,
} from './billing-lifecycle-protocols.js';
import { BillingSnapshotModel } from '@observability/core/domain/models/billing-snapshot-model.js';
import {
  BillingLifecycleTrigger,
  monthWindow,
} from '@observability/core/domain/models/billing-period-model.js';
import {
  clientCalendarOf,
  clientTimezone,
} from '@observability/core/common/helpers/clock/client-clock.js';
import {
  STATEMENT_LOGIC_VERSION,
  STATEMENT_ROUNDING_RULE,
  createStatementFold,
} from '../billingStatement/statement-engine.js';

/**
 * The close's page unit: one CLIENT day of the month (re-audit iteration
 * 3; decision 130 aligned the cut to the client midnight — the fold is
 * order-independent so any partition is CORRECT, but pages that match the
 * daily-rollup lens keep every reader speaking one boundary).
 *
 * The month's usage set is one record per stamped trace and unbounded, and
 * the close runs in a hard-capped container (compose.module.yml gives the
 * api service 512m ⇒ a ~259 MB V8 heap): materializing the month made a
 * busy month IMPOSSIBLE to close — the process died with "Reached heap
 * limit", deterministically, so every retry died identically and the whole
 * lifecycle (invariant 8) became unreachable behind it. Paging bounds the
 * resident set by the busiest DAY instead of the month; the fold that
 * consumes the pages is bounded by DISTINCT statement keys, not by traces.
 *
 * A day is the natural unit because the adapter's window match is
 * `startedAt: { $gte, $lt }` over the same index the month scan rides —
 * one indexed range per page, ~31 per close (a runbook job).
 */
const usagePageWindows = (
  monthStart: Date,
  monthEnd: Date,
): { start: Date; end: Date }[] => {
  const pages: { start: Date; end: Date }[] = [];
  let cursor = monthStart;

  while (cursor.getTime() < monthEnd.getTime()) {
    // monthStart IS a client midnight (monthWindow, decision 130), so
    // stepping 24h stays on client midnights in fixed-offset zones; in a
    // DST zone one page is 23/25h — a partition shift the order-independent
    // fold is indifferent to, clamped to the month end either way.
    const nextDay = new Date(cursor.getTime() + 86_400_000);
    const end = nextDay.getTime() > monthEnd.getTime() ? monthEnd : nextDay;

    pages.push({ start: cursor, end });
    cursor = end;
  }

  return pages;
};

/**
 * T6: the month close. Freezes the ENTIRE calculation — inputs (usage
 * records, stamps copied verbatim) and output (the statement, produced by
 * the same engine the live path runs) — into an immutable, versioned
 * snapshot, then flips the period to 'closed'.
 *
 * Guards:
 * - only a fully-past UTC calendar month can close (the current month is
 *   partial by definition — invariant 8);
 * - CLOSE ORDER (re-audit): months close OLDEST-FIRST — closing M while an
 *   older month still has traces and was never closed is blocked, naming
 *   the month to close first. The C-7.1 live-scan bound
 *   (firstOpenMonthStart) starts at the earliest non-closed month, so an
 *   out-of-order close would silently drop the skipped month's money from
 *   /bills and the monthly series while the summary still showed it;
 * - BLOCKED while any pending_price trace exists in the month (T6): the
 *   bill never silently drops open costs;
 * - already-closed month → state error (reopen first, audited) — after
 *   RE-RUNNING the post-close quarantine reconciliation from the durable
 *   snapshot, so a retry of a close that crashed between the committed
 *   transaction and the reconciliation heals instead of just refusing.
 */
export class CloseBillingPeriodDbUseCase implements CloseBillingPeriodUseCase {
  private readonly billingQueryRepository: BillingQueryRepository;
  private readonly billingPeriodRepository: BillingPeriodRepository;
  private readonly billingSnapshotRepository: BillingSnapshotRepository;
  private readonly traceRepository: Pick<
    TraceRepository,
    'reconcileQuarantineAfterClose'
  >;
  private readonly now: () => Date;
  // The door this instance is composed behind (decision 131): 'runbook'
  // for the CLI job, 'scheduled' for the auto-close sidecar. A property
  // of the composition, not of the call — the domain interface stays
  // close(year, month).
  private readonly trigger: BillingLifecycleTrigger;
  // WHO, when the door knows (decision 179): the MCP endpoint passes the
  // session subject; the runbook and the scheduler have nobody to name.
  private readonly actor?: string;

  constructor(args: {
    billingQueryRepository: BillingQueryRepository;
    billingPeriodRepository: BillingPeriodRepository;
    billingSnapshotRepository: BillingSnapshotRepository;
    traceRepository: Pick<TraceRepository, 'reconcileQuarantineAfterClose'>;
    now?: () => Date;
    trigger?: BillingLifecycleTrigger;
    actor?: string;
  }) {
    this.billingQueryRepository = args.billingQueryRepository;
    this.billingPeriodRepository = args.billingPeriodRepository;
    this.billingSnapshotRepository = args.billingSnapshotRepository;
    this.traceRepository = args.traceRepository;
    this.now = args.now ?? (() => new Date());
    this.trigger = args.trigger ?? 'runbook';
    this.actor = args.actor;
  }

  async close(year: number, month: number): Promise<CloseBillingPeriodResult> {
    const { start, end } = monthWindow(year, month);
    const now = this.now();

    if (end.getTime() > now.getTime()) {
      throw new BillingPeriodStateError(
        `O mês ${year}-${String(month).padStart(2, '0')} ainda não terminou ` +
          '(UTC) — só meses completos podem fechar (invariante 8).',
      );
    }

    const period = await this.billingPeriodRepository.find(year, month);

    if (period?.status === 'closed') {
      await this.repairReconciliationAndRefuse(year, month, start, end, period);
    }

    // Re-audit close-order guard: every month from the earliest stored
    // trace up to M-1 must be closed or trace-free BEFORE M closes.
    await this.assertOlderMonthsClosed(year, month);

    // Re-audit: the month is provably NOT closed here (the already-closed
    // branch above always throws), so the closed-month exemption for
    // unresolved-quarantined pending traces MUST NOT apply — a REOPENED
    // month's straggler is precisely the case decision 89's correction
    // flow exists to resolve, and freezing it out would produce a v+1
    // bill that omits its cost while reporting zero pending. Every
    // pending_price trace in the window blocks the close (T6).
    const pending = await this.billingQueryRepository.pendingPriceSummary(
      start,
      end,
      { excludeUnresolvedQuarantine: false },
    );

    if (pending.traceCount > 0) {
      throw new BillingCloseBlockedError({
        pendingTraceCount: pending.traceCount,
        modelsWithoutPrice: pending.models,
      });
    }

    const ingestionWatermark =
      await this.billingQueryRepository.ingestionWatermark(start, end);

    // audit B-2: collision-proof version — the period doc's counter AND
    // the highest header actually stored (a crash-orphaned header, however
    // it came to exist, must never wedge every retry on the unique index).
    const currentSnapshot = await this.billingSnapshotRepository.findCurrent(
      year,
      month,
    );
    const version =
      Math.max(period?.snapshotVersion ?? 0, currentSnapshot?.version ?? 0) + 1;

    // Decision 130: the zone is pinned like a price. A re-close of a month
    // whose earlier snapshot was cut under a DIFFERENT zone would compare
    // and reconcile across two incompatible windows — refuse loudly.
    // (Zone changes are forward-only, and never after real closes exist.)
    if (currentSnapshot && currentSnapshot.timezone !== clientTimezone()) {
      throw new BillingCloseBlockedError({
        pendingTraceCount: 0,
        modelsWithoutPrice: [],
        message:
          `Fechamento bloqueado: o snapshot v${currentSnapshot.version} deste ` +
          `mês foi cortado no fuso ${currentSnapshot.timezone}, mas ` +
          `CLIENT_TIMEZONE agora é ${clientTimezone()}. Mudança de fuso é ` +
          'forward-only (decisão 130) — nunca sobre um mês já fechado.',
      });
    }

    const closedAt = this.now();

    // re-audit iteration 3: the month is folded PAGE BY PAGE — read a day,
    // fold it into the (distinct-key-bounded) accumulators, stage it, drop
    // it. The statement is byte-identical to the one the whole-month array
    // produced: it IS the same engine, and the engine's order-independence
    // is ENFORCED, not assumed — its comparators are total orders over the
    // very keys the accumulators group by (decision 122; before that a
    // price-only tie fell through to insertion order and this page order
    // diverged from the readers'). LOGIC_VERSION does not move — no
    // arithmetic changed, only when the records are resident.
    const fold = createStatementFold();
    // The one O(traces) structure left in the close: the ids the snapshot
    // billed, which reconcileQuarantineAfterClose takes as an array
    // (strings only — ~11 MB at 200k traces, against ~250 MB for the
    // records). Collected while folding instead of re-derived afterwards.
    const billedTraceIds: string[] = [];

    // audit B-2: the close publishes ATOMICALLY (decision 81 + re-audit).
    // The adapter stages the unbounded inputs OUTSIDE the transaction, in
    // bounded chunks under a key private to this attempt, then commits
    // header + period flip together — the header is the commit mark, and
    // no reader can resolve rows without one. A crash leaves NOTHING
    // readable — the retry recomputes and closes cleanly; a concurrent
    // close loses whole, its staged records dropped, never left under the
    // winner's header.
    const outcome =
      await this.billingSnapshotRepository.insertWithPeriodCloseStaged(
        { year, month, version },
        async (stage) => {
          for (const page of usagePageWindows(start, end)) {
            const records = await this.billingQueryRepository.fetchUsageRecords(
              page.start,
              page.end,
            );

            if (records.length === 0) continue;

            for (const record of records) {
              fold.add(record);
              billedTraceIds.push(record.traceId);
            }

            await stage(records);
          }

          const snapshot: BillingSnapshotModel = {
            year,
            month,
            version,
            createdAt: closedAt,
            trigger: this.trigger,
            ingestionWatermark,
            logicVersion: STATEMENT_LOGIC_VERSION,
            timezone: clientTimezone(),
            roundingRule: STATEMENT_ROUNDING_RULE,
            statement: fold.statement(),
            // v1: always empty — the pending guard above blocks the only
            // exclusion source; the ledger exists for schema completeness
            // (T6).
            exceptions: [],
            priceVersionsApplied: fold.appliedPriceVersions(),
            usageRecordCount: fold.recordCount(),
          };

          return snapshot;
        },
        {
          closedAt,
          audit: {
            at: closedAt,
            action: 'close',
            trigger: this.trigger,
            ...(this.actor !== undefined && { actor: this.actor }),
            snapshotVersion: version,
          },
        },
      );

    if (outcome === 'conflict') {
      throw new BillingPeriodStateError(
        `Fechamento concorrente detectado para ${year}-${month} — nada foi sobrescrito.`,
      );
    }

    // Pure over the accumulators — the same projection the header carries.
    const statement = fold.statement();

    // audit B-1 (decision 100): the snapshot adjudicates. With the ids the
    // snapshot billed already in memory, flag every straggler the
    // ingest-vs-close race let through and absorb every flagged trace this
    // version DID bill (reopen→re-close correction, decision 89).
    const quarantine = await this.traceRepository.reconcileQuarantineAfterClose(
      start,
      end,
      billedTraceIds,
      version,
    );

    return {
      year,
      month,
      snapshotVersion: version,
      totalCostMicrocents: statement.totalCostMicrocents,
      totalDisplayCents: statement.totalDisplayCents,
      stampedTraceCount: statement.stampedTraceCount,
      ingestionWatermark,
      quarantine,
    };
  }

  /**
   * Re-audit repair path: the reconciliation runs AFTER the committed
   * close transaction, so a crash (or throw) between the two leaves the
   * month closed-but-unreconciled — and the natural retry
   * (`make billing-close` again) used to refuse with "já está fechado"
   * WITHOUT healing. Before refusing, re-run the reconciliation (both
   * passes are idempotent) from the DURABLE snapshot usage ids of the
   * CURRENT version; the refusal message then says so. Exit semantics are
   * unchanged: the runbook still surfaces the already-closed state error.
   */
  private async repairReconciliationAndRefuse(
    year: number,
    month: number,
    start: Date,
    end: Date,
    period: { snapshotVersion?: number },
  ): Promise<never> {
    const alreadyClosed =
      `O mês ${year}-${String(month).padStart(2, '0')} já está fechado ` +
      `(snapshot v${period.snapshotVersion}). Reabra antes de refechar.`;

    if (typeof period.snapshotVersion !== 'number') {
      // Corrupt lifecycle document — nothing durable to reconcile from;
      // refuse plainly (the summary path reports the corruption loudly).
      throw new BillingPeriodStateError(alreadyClosed);
    }

    const billedTraceIds =
      await this.billingSnapshotRepository.findUsageTraceIds(
        year,
        month,
        period.snapshotVersion,
      );

    await this.traceRepository.reconcileQuarantineAfterClose(
      start,
      end,
      billedTraceIds,
      period.snapshotVersion,
    );

    throw new BillingPeriodStateError(
      `${alreadyClosed} Reconciliação de quarentena reverificada/reparada ` +
        `a partir do snapshot v${period.snapshotVersion}.`,
    );
  }

  /**
   * Re-audit close-order guard: firstOpenMonthStart (the C-7.1 live-scan
   * bound) walks forward from the EARLIEST closed month — so closing M
   * while an OLDER month still has traces and was never closed would push
   * that month behind the bound: its money would vanish from /bills and
   * the monthly series while the summary still showed it. Enforce
   * oldest-first here: every month from the earliest stored trace to M-1
   * must be closed or trace-free (a genuine no-traffic gap month passes).
   */
  private async assertOlderMonthsClosed(
    year: number,
    month: number,
  ): Promise<void> {
    const earliest = await this.billingQueryRepository.earliestTraceAt();

    if (!earliest) return;

    const targetOrdinal = year * 12 + (month - 1);
    // Decision 130: the earliest trace's month is a CLIENT-calendar fact.
    const earliestCalendar = clientCalendarOf(earliest);
    let cursorYear = earliestCalendar.year;
    let cursorMonth = earliestCalendar.month;

    if (cursorYear * 12 + (cursorMonth - 1) >= targetOrdinal) return;

    const closedMonths = new Set(
      (await this.billingPeriodRepository.listAll())
        .filter((period) => period.status === 'closed')
        .map((period) => `${period.year}-${period.month}`),
    );

    // Months are few (one iteration per calendar month of history), and
    // the trace-free probe only runs for the non-closed ones.
    while (cursorYear * 12 + (cursorMonth - 1) < targetOrdinal) {
      if (!closedMonths.has(`${cursorYear}-${cursorMonth}`)) {
        const window = monthWindow(cursorYear, cursorMonth);

        if (
          await this.billingQueryRepository.hasTraces(window.start, window.end)
        ) {
          const blocking = `${cursorYear}-${String(cursorMonth).padStart(2, '0')}`;

          throw new BillingCloseBlockedError({
            pendingTraceCount: 0,
            modelsWithoutPrice: [],
            message:
              `Fechamento de ${year}-${String(month).padStart(2, '0')} ` +
              `bloqueado: o mês ${blocking} tem traces e nunca foi fechado — ` +
              `feche ${blocking} primeiro (fechamento é sempre do mês mais ` +
              'antigo para o mais novo).',
          });
        }
      }

      cursorMonth += 1;

      if (cursorMonth === 13) {
        cursorMonth = 1;
        cursorYear += 1;
      }
    }
  }
}
