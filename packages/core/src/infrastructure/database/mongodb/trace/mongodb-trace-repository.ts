import {
  InsertIfAbsentResult,
  PendingPriceTrace,
  PendingStamp,
  QuarantineReconciliation,
  AttributionUpdateResult,
  PendingPriceCursor,
  PendingPriceFilter,
  TraceAttribution,
  TraceRepository,
} from '../../../../application/interfaces/trace-repository.js';
import { TraceModel } from '../../../../domain/models/trace-model.js';
import { ModelRef } from '../../../../domain/models/model-ref.js';
import { toFilterCounterDims } from '../../../../domain/models/filter-counter-model.js';
import { deriveUnclassified } from '../../../../domain/models/derive-unclassified.js';
import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../collections.js';
import { isDuplicateKeyError } from '../helpers/is-duplicate-key-error.js';
import { MongoDbFilterCounterRepository } from '../filterCounter/mongodb-filter-counter-repository.js';
import { MongoDbSessionSummaryRepository } from '../session/mongodb-session-summary-repository.js';
import { Logger } from '../../../../common/logging/logger.js';
import { nullLogger } from '../../../../common/logging/null-logger.js';

const filterCounters = new MongoDbFilterCounterRepository();

// Materialized sessions read-model (decision 80): every write that touches
// a session re-derives that session's summary — exact by construction,
// self-healing on the next touch.
const sessionSummaries = new MongoDbSessionSummaryRepository();

// The recompute runs AFTER the trace write committed, and the
// materialization is self-healing by design (next touch or the rebuild
// job) — so a recompute failure must never bubble into the caller's
// outcome. Before this catch, a post-commit throw made the ingest loop
// count a STORED trace as failed and dead-letter it (re-audit): the
// write's outcome is the transaction's outcome, nothing later.
const recomputeSessionOf = async (
  sessionId: string | undefined | null,
  logger: Logger,
): Promise<void> => {
  if (typeof sessionId !== 'string') return;

  try {
    await sessionSummaries.recompute(sessionId);
  } catch (error) {
    logger.warn(
      'session summary recompute failed — summary stays stale until the ' +
        'next touch or rebuild (decision 80)',
      { sessionId, err: error },
    );
  }
};

/**
 * audit re-check (item 3): both reconcile passes write via chunked $in —
 * a full month of traceIds in ONE updateMany hit the 16MB command ceiling
 * around ~300-400k ids, and it threw AFTER the committed close (the exact
 * closed-but-unreconciled state the repair path exists for). 10k string
 * ids ≈ well under 1MB per command.
 */
const RECONCILE_CHUNK_SIZE = 10_000;

const chunksOf = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

/**
 * Storage convention: OPTIONAL FIELDS ARE STORED AS NULL, never absent —
 * every document shows the full schema in the DB. The mapper names every
 * optional key (undefined values) and the BSON serializer turns undefined
 * into null at write time. A pending_price trace therefore shows
 * `totalCostMicrocents: null` — cost OPEN, still never R$ 0 (invariant 2).
 */
/**
 * The attribution-refresh working set (audit F-2): exactly what
 * updateAttribution's callback reads — the facet dims, the model, the
 * session, the stamp status and the correction guard. Never the embedded
 * transcript or spans (decision 47).
 */
/** Canonical-shape inequality (audit F-2) — a re-sync of the same value writes nothing. */
const differs = (stored: unknown, next: unknown): boolean =>
  JSON.stringify(stored) !== JSON.stringify(next);

const ATTRIBUTION_FIELDS = {
  traceId: 1,
  startedAt: 1,
  domain: 1,
  subdomain: 1,
  type: 1,
  agent: 1,
  channel: 1,
  status: 1,
  model: 1,
  sessionId: 1,
  pricingStatus: 1,
  attributionCorrectedAt: 1,
  unclassified: 1,
} as const;

export class MongoDbTraceRepository implements TraceRepository {
  private readonly logger: Logger;

  constructor(args?: { logger?: Logger }) {
    this.logger = args?.logger ?? nullLogger;
  }

  async insertIfAbsent(trace: TraceModel): Promise<InsertIfAbsentResult> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);

    // One trace = one document (decision 47) and trace + counter commit
    // or abort TOGETHER (decision 81): the facet cube's exactly-once
    // counting rides the same durability as the insert — a crash can no
    // longer land the trace without its count (which a retried batch,
    // seeing 'skipped', would never repair).
    //
    // audit C-7.3: insert directly — no pre-insert findOne. The unique
    // traceId index IS the existence check; the common path (new trace)
    // pays one round trip instead of two.
    try {
      await MongoDb.withTransaction(async (session) => {
        await traces.insertOne({ ...trace }, { session });
        await filterCounters.increment(toFilterCounterDims(trace), session);
      });
    } catch (error) {
      // A duplicate (re-sync, or a concurrent ingestor winning the race —
      // the worker and a manual `make sync` are a legal combination) turns
      // into E11000 aborting the transaction: that is just 'skipped'.
      // audit B-4 residual: the skipped branch carries the STORED token
      // total (tiny projected read) so the ingest path can surface
      // source/store token divergence without a second full read.
      if (isDuplicateKeyError(error)) {
        const stored = await traces.findOne(
          { traceId: trace.traceId },
          { projection: { _id: 0, tokensTotal: 1 } },
        );

        return typeof stored?.['tokensTotal'] === 'number'
          ? { outcome: 'skipped', storedTokensTotal: stored['tokensTotal'] }
          : 'skipped';
      }

      throw error;
    }

    // Sessions read-model (decision 80) — deliberately OUTSIDE the
    // transaction: recompute-on-touch is self-healing (next touch or
    // rebuild), and keeping the transaction two writes wide keeps it
    // fast and conflict-free. A recompute failure is swallowed (warned)
    // inside recomputeSessionOf: the trace IS stored, so the outcome
    // below must stay 'inserted' (re-audit item 5).
    await recomputeSessionOf(trace.sessionId, this.logger);

    return 'inserted';
  }

  async updateAttribution(
    traceId: string,
    attribution: TraceAttribution,
  ): Promise<AttributionUpdateResult> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);
    let modelPinnedByStamp = false;

    // The whole read-modify-write runs in ONE transaction (decision 81):
    // the before-snapshot, the attribution merge, the counter delta and
    // the unclassified recompute commit or abort together — no partial
    // state, no counter delta applied against a torn document.
    const sessionId = await MongoDb.withTransaction<string | null>(
      async (session) => {
        // Snapshot BEFORE the correction: agent/domain/subdomain are facet
        // cube dimensions, so a correction must move the trace's count from
        // its old tuple to the new one (decision 77).
        // audit F-2: project ONLY the fields the callback consumes — the
        // dims, the model, the session, the stamp status and the
        // correction guard. The unprojected read pulled the whole trace
        // (full transcript + every span, ~6.8KB avg) to touch ~200 bytes;
        // over a 1M-trace backfill that is ~6.8GB of pure cache eviction
        // against a 512m default, flushing the working set /traces and
        // /billing depend on.
        const before = (await traces.findOne(
          { traceId },
          { session, projection: ATTRIBUTION_FIELDS },
        )) as unknown as
          (TraceModel & { attributionCorrectedAt?: Date }) | null;

        // Runbook-corrected traces are off-limits to source refreshes
        // (decision 79): the source still carries the value the correction
        // fixed, so refreshing would silently revert it on every re-sync.
        if (!before || before.attributionCorrectedAt) {
          return null;
        }

        // audit F-2: only fields whose value actually CHANGED enter the
        // $set — a re-sync (the steady state) carrying the same attribution
        // must produce NO write, not a pointless rewrite + oplog entry per
        // backfilled trace. `differs` compares the canonical shapes.
        const set: Record<string, unknown> = {};

        if (attribution.agent !== undefined) {
          // Canonical block: version/instance always present (null when absent).
          const nextAgent = {
            id: attribution.agent.id,
            version: attribution.agent.version ?? null,
            instance: attribution.agent.instance ?? null,
          };

          if (differs(before.agent ?? null, nextAgent)) {
            set['agent'] = nextAgent;
          }
        }

        if (attribution.model !== undefined) {
          // audit A-5: the MODEL is the one attribution field the immutable
          // stamp depends on — /billing groups money by it, and the stamp
          // records the applied price but NOT the model key it was resolved
          // for, so a post-stamp rewrite re-attributes frozen money to a
          // model whose price it never used, undetectably. stampPendingTrace
          // pins the model on the write side (audit B-5); this is the same
          // pin on the refresh side: once stamped, the stored model is part
          // of the stamp's meaning and a source refresh may not touch it.
          // (Token counts got this treatment first — tokenDivergence, Q3.)
          if (before.pricingStatus === 'stamped') {
            modelPinnedByStamp = true;
          } else {
            // Canonical block: provider always present (null when unknown).
            const nextModel = {
              id: attribution.model.id,
              provider: attribution.model.provider ?? null,
            };

            if (differs(before.model ?? null, nextModel)) {
              set['model'] = nextModel;
            }
          }
        }

        for (const field of ['domain', 'subdomain'] as const) {
          if (
            attribution[field] !== undefined &&
            differs(before[field] ?? null, attribution[field] ?? null)
          ) {
            set[field] = attribution[field];
          }
        }

        if (Object.keys(set).length > 0) {
          await traces.updateOne({ traceId }, { $set: set }, { session });
        }

        // The unclassified flag is derived from the MERGED document, so a
        // stored correction is never re-flagged by a payload lacking the
        // field and a flag is never cleared while the stored value is
        // still absent.
        const stored = (await traces.findOne(
          { traceId },
          { session, projection: ATTRIBUTION_FIELDS },
        )) as unknown as (TraceModel & { unclassified?: unknown }) | null;

        if (!stored) {
          return null;
        }

        const beforeDims = toFilterCounterDims(before);
        const afterDims = toFilterCounterDims(stored as unknown as TraceModel);

        if (JSON.stringify(beforeDims) !== JSON.stringify(afterDims)) {
          await filterCounters.applyDelta(beforeDims, afterDims, session);
        }

        const unclassified = deriveUnclassified({
          agentId: stored.agent?.id ?? undefined,
          model: stored.model ?? undefined,
        });

        // audit F-2: write the flag ONLY when it changed — the old code
        // issued this updateOne UNCONDITIONALLY on every skipped re-sync
        // (each backfilled trace took a pointless write + oplog entry even
        // when nothing moved).
        const nextUnclassified = unclassified ?? null;
        const storedUnclassified = stored.unclassified ?? null;

        if (
          JSON.stringify(nextUnclassified) !==
          JSON.stringify(storedUnclassified)
        ) {
          await traces.updateOne(
            { traceId },
            { $set: { unclassified: nextUnclassified } },
            { session },
          );
        }

        return stored.sessionId ?? null;
      },
    );

    // Attribution feeds the session's first-trace block — refresh the
    // materialized summary (decision 80); outside the transaction, same
    // rationale as insertIfAbsent (self-healing by design, failures
    // warned and swallowed — the committed correction stands).
    await recomputeSessionOf(sessionId, this.logger);

    return { modelPinnedByStamp };
  }

  async stampPendingTrace(
    traceId: string,
    stamp: PendingStamp,
    pinnedModel: ModelRef | null,
  ): Promise<'stamped' | 'skipped'> {
    // The pricingStatus guard makes stamped traces immutable here by
    // construction (invariant 1): only a still-pending trace can match.
    //
    // audit B-5: the CAS also pins the model the prices were resolved
    // for — exact-match on the two nested fields ('model.id',
    // 'model.provider'), never whole-doc equality (key order pitfalls).
    // A concurrent attribution correction changing the model makes the
    // filter miss → 'skipped' → the next sweep re-reads fresh. A pending
    // trace without a model pins the stored null (storage convention:
    // optional fields are explicit null).
    const modelFilter = pinnedModel
      ? {
          'model.id': pinnedModel.id,
          'model.provider': pinnedModel.provider ?? null,
        }
      : { model: null };

    const result = await MongoDb.getCollection(TRACES_COLLECTION).updateOne(
      { traceId, pricingStatus: 'pending_price', ...modelFilter },
      {
        $set: {
          pricingStatus: 'stamped',
          stampedCosts: stamp.stampedCosts,
          totalCostMicrocents: stamp.totalCostMicrocents,
          stampedAt: stamp.stampedAt,
          pendingPrice: null,
        },
      },
    );

    if (result.matchedCount === 0) {
      return 'skipped';
    }

    // The stamp moved this session's cost/pending totals — refresh the
    // materialized summary (decision 80). POST-COMMIT: the CAS above
    // already stamped the trace, so a failure in this tail (the sessionId
    // lookup included) must never turn into a reported stamp failure —
    // warn and answer with the committed outcome (re-audit item 5).
    try {
      const stamped = await MongoDb.getCollection(TRACES_COLLECTION).findOne(
        { traceId },
        { projection: { _id: 0, sessionId: 1 } },
      );

      await recomputeSessionOf(
        stamped?.['sessionId'] as string | null,
        this.logger,
      );
    } catch (error) {
      this.logger.warn(
        'post-stamp session lookup failed — summary stays stale until the ' +
          'next touch or rebuild (decision 80)',
        { traceId, err: error },
      );
    }

    return 'stamped';
  }

  async findPendingPrice(
    limit: number,
    after?: PendingPriceCursor,
    filter?: PendingPriceFilter,
  ): Promise<PendingPriceTrace[]> {
    // Slim projection (decision 79): re-stamping needs four small fields;
    // the embedded input/output/spans (decision 47) stay in the store.
    // audit B-5: the LIMIT is what actually keeps the sweep bounded — the
    // projection bounds bytes per document, not the number of documents,
    // and this read used to materialize every pending trace at once.
    // Rides pricingStatus_1_startedAt_1; the sort makes pages stable.
    const documents = await MongoDb.getCollection(TRACES_COLLECTION)
      .find(
        {
          pricingStatus: 'pending_price',
          // Tuple cursor (audit B-5): strictly after the previous page's
          // last trace, so unstampable traces (blocked closed months) are
          // walked past instead of re-read at the head forever.
          ...(after
            ? {
                $or: [
                  { startedAt: { $gt: after.startedAt } },
                  {
                    startedAt: after.startedAt,
                    traceId: { $gt: after.traceId },
                  },
                ],
              }
            : {}),
          // Decision 183: residual filters on the same index. The model match
          // uses the stored canonical shape (parseModelRef), the same one the
          // stamper resolves prices from; `$ne: null` also drops a missing field.
          ...(filter?.model
            ? {
                'model.id': filter.model.id,
                'model.provider': filter.model.provider ?? null,
              }
            : {}),
          ...(filter?.withModelOnly ? { model: { $ne: null } } : {}),
        },
        {
          projection: { _id: 0, traceId: 1, model: 1, startedAt: 1, tokens: 1 },
        },
      )
      .sort({ startedAt: 1, traceId: 1 })
      .limit(limit)
      .toArray();

    return documents as unknown as PendingPriceTrace[];
  }

  async countPendingPrice(): Promise<number> {
    return MongoDb.getCollection(TRACES_COLLECTION).countDocuments({
      pricingStatus: 'pending_price',
    });
  }

  async reconcileQuarantineAfterClose(
    monthStart: Date,
    monthEnd: Date,
    snapshotTraceIds: string[],
    snapshotVersion: number,
    // Parameterized (default: the 16MB-safe constant) so the chunking
    // logic itself is testable with a tiny size.
    chunkSize: number = RECONCILE_CHUNK_SIZE,
  ): Promise<QuarantineReconciliation> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);

    // Decision 100, pass 1 — FLAG STRAGGLERS: whatever the ingest-vs-close
    // interleaving let through unflagged, if the snapshot did not bill it,
    // it is quarantined now. The straggler set is computed CLIENT-SIDE
    // (item 3): a `$nin` of the full month's ids rode one update command
    // into the 16MB ceiling, so instead the month's traceIds stream
    // through a projected cursor, the snapshot's id Set is subtracted in
    // memory, and the resulting diff — tiny by construction, it is only
    // the stragglers — is flagged via chunked $in. Matching on the absent
    // reason keeps the pass idempotent (a retry re-matches nothing) and
    // preserves the original quarantinedAt of traces the ingestor already
    // flagged.
    const snapshotIdSet = new Set(snapshotTraceIds);
    const stragglerIds: string[] = [];
    const monthIds = traces.find(
      { startedAt: { $gte: monthStart, $lt: monthEnd } },
      { projection: { _id: 0, traceId: 1 } },
    );

    for await (const document of monthIds) {
      const traceId = document['traceId'] as string;

      if (!snapshotIdSet.has(traceId)) {
        stragglerIds.push(traceId);
      }
    }

    const quarantinedAt = new Date();
    let flaggedStragglers = 0;

    // traceId is globally unique (the ingest idempotency index), and every
    // id below came from the month scan above — no window re-filter needed.
    for (const chunk of chunksOf(stragglerIds, chunkSize)) {
      const flagged = await traces.updateMany(
        {
          traceId: { $in: chunk },
          'billingQuarantine.reason': { $exists: false },
        },
        {
          $set: {
            billingQuarantine: {
              reason: 'period_closed',
              quarantinedAt,
            },
          },
        },
      );

      flaggedStragglers += flagged.modifiedCount;
    }

    // Pass 2 — ABSORB THE ADJUDICATED: flagged traces this snapshot DID
    // bill (the reopen→re-close correction flow, decision 89). The
    // historical mark stays; the absorbed version resolves it, so readers
    // (dailyRollup, countQuarantined) stop treating it as outside the
    // bill. Idempotent: re-setting the same version modifies nothing.
    // Chunked $in for the same 16MB reason; the snapshot's ids are
    // month-scoped by construction (they come from the month's own usage
    // records).
    let absorbed = 0;

    for (const chunk of chunksOf(snapshotTraceIds, chunkSize)) {
      const result = await traces.updateMany(
        {
          traceId: { $in: chunk },
          'billingQuarantine.reason': { $exists: true },
        },
        {
          $set: {
            'billingQuarantine.absorbedInSnapshotVersion': snapshotVersion,
          },
        },
      );

      absorbed += result.modifiedCount;
    }

    return { flaggedStragglers, absorbed };
  }
}
