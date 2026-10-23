import { Document } from 'mongodb';
import {
  BillRow,
  BillingQueryRepository,
  DailyRollupRow,
  MonthlyRollupRow,
} from '../../../../application/interfaces/billing-query-repository.js';
import { TokenType } from '../../../../domain/models/price-version-model.js';
import { CostByTokenType } from '../../../../domain/useCases/get-billing-series-use-case.js';
import { PendingPriceSummary } from '../../../../domain/useCases/get-billing-summary-use-case.js';
import { BillingUsageRecord } from '../../../../domain/models/billing-snapshot-model.js';
import { ModelRef, modelKey } from '../../../../domain/models/model-ref.js';
import { MongoDb } from '../mongo-db.js';
import { clientTimezone } from '../../../../common/helpers/clock/client-clock.js';
import { TRACES_COLLECTION } from '../collections.js';

/**
 * Unresolved quarantine (decision 100): flagged and not absorbed by any
 * snapshot — the only quarantine state readers treat as "outside the
 * bill". A normal trace stores `billingQuarantine: null`, so the nested
 * path simply does not exist on it.
 */
const UNRESOLVED_QUARANTINE_EXPR = {
  $and: [
    { $ne: [{ $type: '$billingQuarantine.reason' }, 'missing'] },
    {
      $eq: [
        { $type: '$billingQuarantine.absorbedInSnapshotVersion' },
        'missing',
      ],
    },
  ],
};

/** Match-stage form: docs where the quarantine is NOT unresolved. */
const NOT_UNRESOLVED_QUARANTINE_MATCH = {
  $or: [
    { 'billingQuarantine.reason': { $exists: false } },
    { 'billingQuarantine.absorbedInSnapshotVersion': { $exists: true } },
  ],
};

/**
 * Expression form: does this trace start inside any CLOSED month? The
 * unresolved-quarantine exclusion is the FROZEN-month lens only (decision
 * 100 scoped by decision 113 and re-audit iteration 2), and listBills
 * groups every month of the scan in one pass — so the scope has to be a
 * per-document expression, not a $match stage.
 */
const startedInClosedMonthExpr = (
  closedMonthWindows: { start: Date; end: Date }[],
): Document | boolean =>
  closedMonthWindows.length === 0
    ? false
    : {
        $or: closedMonthWindows.map((window) => ({
          $and: [
            { $gte: ['$startedAt', window.start] },
            { $lt: ['$startedAt', window.end] },
          ],
        })),
      };

/**
 * THE month bucket of a trace, stated once (decision 181): the CLIENT's
 * calendar month, cut at the CLIENT's midnight — the same boundary
 * `monthWindow` gives the summary and `$dateTrunc` gives the daily lens
 * (decision 130). Mongo's bare `{ $year: '$startedAt' }` answers in UTC,
 * which for a UTC-3 client files the last three local hours of every
 * month under the NEXT one; the `{ date, timezone }` form is the fix, and
 * Mongo resolves the IANA zone (DST included) natively.
 *
 * A FUNCTION, not a const, for the reason filterCounterStages spells out:
 * a module-level evaluation would freeze whatever zone was — or was NOT —
 * initialized at first import. The stages are built when the query RUNS.
 */
const clientMonthOf = (): Document => {
  const date = { date: '$startedAt', timezone: clientTimezone() };

  return { year: { $year: date }, month: { $month: date } };
};

/**
 * Billing reads the SAME traces collection the tabs read and sums the SAME
 * ingestion-time stamps (invariants 1 and 3). µ¢ sums stay exact: integers
 * below 2^53 are exact under Mongo's $sum.
 */
export class MongoDbBillingQueryRepository implements BillingQueryRepository {
  async listBills(
    sinceInclusive: Date | null | undefined,
    closedMonthWindows: { start: Date; end: Date }[],
  ): Promise<BillRow[]> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);
    const inClosedMonth = startedInClosedMonthExpr(closedMonthWindows);

    const documents = (await traces
      .aggregate([
        // audit C-7.1: the scan is bounded to open months — closed history
        // is served from snapshots by the caller, never re-scanned here.
        ...(sinceInclusive
          ? [{ $match: { startedAt: { $gte: sinceInclusive } } }]
          : []),
        {
          $project: {
            // Decision 181: the CLIENT's calendar month — the same cut
            // monthWindow makes for the summary, so /bills and
            // /billing/summary cannot disagree (invariants 3 and 8).
            ...clientMonthOf(),
            pricingStatus: 1,
            totalCostMicrocents: 1,
            docTokens: {
              $add: [
                { $ifNull: ['$tokens.input', 0] },
                { $ifNull: ['$tokens.output', 0] },
                { $ifNull: ['$tokens.cache_read', 0] },
                { $ifNull: ['$tokens.cache_write', 0] },
              ],
            },
            // Decision 100, scoped to CLOSED months by re-audit iteration
            // 2: a pending trace with UNRESOLVED quarantine is outside a
            // FROZEN bill (the quarantine count carries it there), but in
            // an open or REOPENED month the live statement bills that
            // month, so its pending traces belong in the pending panel —
            // the same lens pendingPriceSummary and the close guard use,
            // so the endpoints agree for every period status.
            pendingInScope: {
              $and: [
                { $eq: ['$pricingStatus', 'pending_price'] },
                {
                  $not: {
                    $and: [UNRESOLVED_QUARANTINE_EXPR, inClosedMonth],
                  },
                },
              ],
            },
          },
        },
        {
          $group: {
            _id: { year: '$year', month: '$month' },
            stampedTraceCount: {
              $sum: { $cond: [{ $eq: ['$pricingStatus', 'stamped'] }, 1, 0] },
            },
            pendingTraceCount: {
              $sum: { $cond: ['$pendingInScope', 1, 0] },
            },
            totalCostMicrocents: {
              $sum: {
                $cond: [
                  { $eq: ['$pricingStatus', 'stamped'] },
                  { $ifNull: ['$totalCostMicrocents', 0] },
                  0,
                ],
              },
            },
            // audit B-10.4 — tokens: stamped + in-scope pending (the live
            // "month volume so far"); stampedTokens: billed volume only.
            tokens: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $eq: ['$pricingStatus', 'stamped'] },
                      '$pendingInScope',
                    ],
                  },
                  '$docTokens',
                  0,
                ],
              },
            },
            stampedTokens: {
              $sum: {
                $cond: [
                  { $eq: ['$pricingStatus', 'stamped'] },
                  '$docTokens',
                  0,
                ],
              },
            },
          },
        },
        { $sort: { '_id.year': -1, '_id.month': -1 } },
      ])
      .toArray()) as {
      _id: { year: number; month: number };
      stampedTraceCount: number;
      pendingTraceCount: number;
      totalCostMicrocents: number;
      tokens: number;
      stampedTokens: number;
    }[];

    return documents.map((document) => ({
      year: document._id.year,
      month: document._id.month,
      totalCostMicrocents: document.totalCostMicrocents,
      stampedTraceCount: document.stampedTraceCount,
      pendingTraceCount: document.pendingTraceCount,
      tokens: document.tokens,
      stampedTokens: document.stampedTokens,
    }));
  }

  /**
   * The statement engine's diet (decision 88): one record per stamped
   * trace, stamps verbatim, never the payloads/spans (decision 47).
   * Deterministic order by traceId — snapshots must reproduce exactly.
   *
   * audit C-7.2: the sort happens IN PROCESS, after materialization. A
   * DB-side sort had no serving index; past the 100MB in-memory sort
   * ceiling the query aborted — taking down GET /billing/summary AND
   * `make billing-close` for the month. Determinism is the only contract
   * requirement, and the array is fully materialized for buildStatement
   * anyway.
   */
  async fetchUsageRecords(
    monthStart: Date,
    monthEnd: Date,
  ): Promise<BillingUsageRecord[]> {
    const documents = await MongoDb.getCollection(TRACES_COLLECTION)
      .find(
        {
          startedAt: { $gte: monthStart, $lt: monthEnd },
          pricingStatus: 'stamped',
        },
        {
          projection: {
            traceId: 1,
            startedAt: 1,
            agent: 1,
            model: 1,
            stampedCosts: 1,
            totalCostMicrocents: 1,
          },
        },
      )
      .toArray();

    return documents
      .map((document) => ({
        traceId: document.traceId as string,
        startedAt: document.startedAt as Date,
        agentId: (document.agent?.id as string | undefined) ?? null,
        agentVersion: (document.agent?.version as string | undefined) ?? null,
        model: document.model ? modelKey(document.model as ModelRef) : null,
        stampedCosts: (document.stampedCosts ??
          []) as BillingUsageRecord['stampedCosts'],
        totalCostMicrocents: (document.totalCostMicrocents as number) ?? 0,
      }))
      .sort((a, b) =>
        a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0,
      );
  }

  async pendingPriceSummary(
    monthStart: Date,
    monthEnd: Date,
    // Required, exactly as on the port: a default here would restore the
    // very thing the required lens exists to prevent — a reader silently
    // inheriting the frozen-month reading on a live month.
    opts: { excludeUnresolvedQuarantine: boolean },
  ): Promise<PendingPriceSummary> {
    const [pendingDocument] = (await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate([
        {
          $match: {
            startedAt: { $gte: monthStart, $lt: monthEnd },
            pricingStatus: 'pending_price',
            // Decision 100, scoped to CLOSED months by the re-audit (same
            // rule decision 113 gave dailyRollup): inside a frozen month a
            // pending trace with UNRESOLVED quarantine is outside the
            // bill, and countQuarantined carries its visibility. In an
            // open or REOPENED month the live statement bills that same
            // month, so its pending traces are open costs — counted here,
            // blocking the close until they are priced (decision 89).
            ...(opts.excludeUnresolvedQuarantine
              ? NOT_UNRESOLVED_QUARANTINE_MATCH
              : {}),
          },
        },
        {
          $group: {
            _id: null,
            traceCount: { $sum: 1 },
            tokensInput: { $sum: { $ifNull: ['$tokens.input', 0] } },
            tokensOutput: { $sum: { $ifNull: ['$tokens.output', 0] } },
            tokensCacheRead: { $sum: { $ifNull: ['$tokens.cache_read', 0] } },
            tokensCacheWrite: { $sum: { $ifNull: ['$tokens.cache_write', 0] } },
            models: { $addToSet: { $ifNull: ['$model', null] } },
          },
        },
      ])
      .toArray()) as Document[];

    return {
      traceCount: pendingDocument?.traceCount ?? 0,
      tokens: {
        input: pendingDocument?.tokensInput ?? 0,
        output: pendingDocument?.tokensOutput ?? 0,
        cache_read: pendingDocument?.tokensCacheRead ?? 0,
        cache_write: pendingDocument?.tokensCacheWrite ?? 0,
      },
      models: (pendingDocument?.models ?? [])
        .filter((model: ModelRef | null): model is ModelRef => model !== null)
        .map(modelKey)
        .sort(),
    };
  }

  async monthlyRollup(
    sinceInclusive?: Date | null,
  ): Promise<MonthlyRollupRow[]> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);

    // Two pipelines over the UNWOUND stamps — (month × agent × type) and
    // (month × model × type); every coarser sum (agent totals, month
    // totals, month type split) is assembled from them in JS.
    // audit C-7.1: bounded to open months when the caller passes the
    // bound — closed months chart from their snapshots, not from here.
    const stampStages = [
      {
        $match: {
          pricingStatus: 'stamped',
          ...(sinceInclusive ? { startedAt: { $gte: sinceInclusive } } : {}),
        },
      },
      { $project: { startedAt: 1, agent: 1, model: 1, stampedCosts: 1 } },
      { $unwind: '$stampedCosts' },
    ];

    const byAgentType = (await traces
      .aggregate([
        ...stampStages,
        {
          $group: {
            _id: {
              ...clientMonthOf(),
              agentId: { $ifNull: ['$agent.id', null] },
              tokenType: '$stampedCosts.tokenType',
            },
            costMicrocents: { $sum: '$stampedCosts.costMicrocents' },
          },
        },
      ])
      .toArray()) as Document[];

    const byModelType = (await traces
      .aggregate([
        ...stampStages,
        {
          $group: {
            _id: {
              ...clientMonthOf(),
              model: { $ifNull: ['$model', null] },
              tokenType: '$stampedCosts.tokenType',
            },
            costMicrocents: { $sum: '$stampedCosts.costMicrocents' },
          },
        },
      ])
      .toArray()) as Document[];

    const rows = new Map<string, MonthlyRollupRow>();

    const rowOf = (year: number, month: number): MonthlyRollupRow => {
      const key = `${year}-${month}`;
      let row = rows.get(key);

      if (!row) {
        row = {
          year,
          month,
          totalCostMicrocents: 0,
          byTokenType: [],
          byAgent: [],
          byModel: [],
        };
        rows.set(key, row);
      }

      return row;
    };

    const addTokenCost = (
      split: CostByTokenType,
      tokenType: TokenType,
      costMicrocents: number,
    ): void => {
      const entry = split.find(
        (candidate) => candidate.tokenType === tokenType,
      );

      if (entry) {
        entry.costMicrocents += costMicrocents;
      } else {
        split.push({ tokenType, costMicrocents });
      }
    };

    for (const document of byAgentType) {
      const row = rowOf(document._id.year, document._id.month);
      const tokenType = document._id.tokenType as TokenType;

      // Every stamped trace has an agent slot (null included), so the
      // agent×type rows also feed the month total and its type split.
      row.totalCostMicrocents += document.costMicrocents;
      addTokenCost(row.byTokenType, tokenType, document.costMicrocents);

      let agent = row.byAgent.find(
        (candidate) => candidate.agentId === document._id.agentId,
      );

      if (!agent) {
        agent = {
          agentId: document._id.agentId,
          costMicrocents: 0,
          byTokenType: [],
        };
        row.byAgent.push(agent);
      }

      agent.costMicrocents += document.costMicrocents;
      addTokenCost(agent.byTokenType, tokenType, document.costMicrocents);
    }

    for (const document of byModelType) {
      const row = rowOf(document._id.year, document._id.month);
      const model = document._id.model ? modelKey(document._id.model) : null;

      let entry = row.byModel.find((candidate) => candidate.model === model);

      if (!entry) {
        entry = { model, costMicrocents: 0, byTokenType: [] };
        row.byModel.push(entry);
      }

      entry.costMicrocents += document.costMicrocents;
      addTokenCost(
        entry.byTokenType,
        document._id.tokenType as TokenType,
        document.costMicrocents,
      );
    }

    for (const row of rows.values()) {
      row.byAgent.sort((a, b) => b.costMicrocents - a.costMicrocents);
      row.byModel.sort((a, b) => b.costMicrocents - a.costMicrocents);
    }

    return [...rows.values()].sort(
      (a, b) => a.year - b.year || a.month - b.month,
    );
  }

  async dailyRollup(
    from: Date,
    toExclusive: Date,
    closedMonthWindows: { start: Date; end: Date }[],
  ): Promise<DailyRollupRow[]> {
    // UNRESOLVED quarantine is outside a FROZEN bill (decision 100), so
    // the exclusion applies ONLY to days inside CLOSED months — that is
    // what keeps a closed month's days summing to its frozen total
    // (decision 97). In a reopened (or never-closed) month the live
    // summary bills every stamped trace, straggler included, so its days
    // must chart too (re-audit: without this scope, Σ daily diverged
    // from the live summary between a reopen and its re-close). A trace
    // ABSORBED by a re-close is billed by snapshot v+1 (decision 89), so
    // it charts either way.
    const quarantineScope =
      closedMonthWindows.length === 0
        ? {}
        : {
            $or: [
              ...NOT_UNRESOLVED_QUARANTINE_MATCH.$or,
              {
                $nor: closedMonthWindows.map((window) => ({
                  startedAt: { $gte: window.start, $lt: window.end },
                })),
              },
            ],
          };

    const documents = (await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate([
        {
          $match: {
            // The startedAt bound stays FIRST — it is the indexed cut.
            startedAt: { $gte: from, $lt: toExclusive },
            pricingStatus: 'stamped',
            ...quarantineScope,
          },
        },
        { $project: { startedAt: 1, stampedCosts: 1 } },
        { $unwind: '$stampedCosts' },
        {
          $group: {
            _id: {
              day: {
                // Decision 130: the day bar cuts at the CLIENT midnight —
                // the same boundary the invoice and the screen use. Mongo
                // handles the IANA zone (DST included) natively.
                $dateTrunc: {
                  date: '$startedAt',
                  unit: 'day',
                  timezone: clientTimezone(),
                },
              },
              tokenType: '$stampedCosts.tokenType',
            },
            costMicrocents: { $sum: '$stampedCosts.costMicrocents' },
          },
        },
        { $sort: { '_id.day': 1 } },
      ])
      .toArray()) as Document[];

    const rows = new Map<number, DailyRollupRow>();

    for (const document of documents) {
      const date = document._id.day as Date;
      let row = rows.get(date.getTime());

      if (!row) {
        row = { date, totalCostMicrocents: 0, byTokenType: [] };
        rows.set(date.getTime(), row);
      }

      row.totalCostMicrocents += document.costMicrocents;
      row.byTokenType.push({
        tokenType: document._id.tokenType as TokenType,
        costMicrocents: document.costMicrocents,
      });
    }

    return [...rows.values()].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );
  }

  async ingestionWatermark(
    monthStart: Date,
    monthEnd: Date,
  ): Promise<Date | null> {
    const [document] = (await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate([
        { $match: { startedAt: { $gte: monthStart, $lt: monthEnd } } },
        { $group: { _id: null, watermark: { $max: '$ingestedAt' } } },
      ])
      .toArray()) as Document[];

    return (document?.watermark as Date | undefined) ?? null;
  }

  async countQuarantined(monthStart: Date, monthEnd: Date): Promise<number> {
    // UNRESOLVED only (decision 100): a trace absorbed by a re-close is
    // billed — counting it "outside the bill" forever was audit B-1(a).
    return MongoDb.getCollection(TRACES_COLLECTION).countDocuments({
      startedAt: { $gte: monthStart, $lt: monthEnd },
      'billingQuarantine.reason': { $exists: true },
      'billingQuarantine.absorbedInSnapshotVersion': { $exists: false },
    });
  }

  async countNoMeasuredUsage(
    monthStart: Date,
    monthEnd: Date,
  ): Promise<number> {
    // Live context count (decision 128) — same lens as countQuarantined.
    return MongoDb.getCollection(TRACES_COLLECTION).countDocuments({
      startedAt: { $gte: monthStart, $lt: monthEnd },
      pricingStatus: 'no_measured_usage',
    });
  }

  async earliestTraceAt(): Promise<Date | null> {
    // One indexed min read ({startedAt: -1} index, ascending scan) — the
    // close-order guard's anchor.
    const document = await MongoDb.getCollection(TRACES_COLLECTION)
      .find({}, { projection: { _id: 0, startedAt: 1 } })
      .sort({ startedAt: 1 })
      .limit(1)
      .next();

    return (document?.['startedAt'] as Date | undefined) ?? null;
  }

  async hasTraces(monthStart: Date, monthEnd: Date): Promise<boolean> {
    const document = await MongoDb.getCollection(TRACES_COLLECTION).findOne(
      { startedAt: { $gte: monthStart, $lt: monthEnd } },
      { projection: { _id: 1 } },
    );

    return document !== null;
  }

  async accruedCostMicrocents(monthStart: Date, upTo: Date): Promise<number> {
    const [document] = (await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate([
        {
          $match: {
            startedAt: { $gte: monthStart, $lt: upTo },
            pricingStatus: 'stamped',
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $ifNull: ['$totalCostMicrocents', 0] } },
          },
        },
      ])
      .toArray()) as Document[];

    return (document?.total as number | undefined) ?? 0;
  }
}
