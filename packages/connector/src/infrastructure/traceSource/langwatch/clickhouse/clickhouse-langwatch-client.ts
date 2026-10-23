import { createClient } from '@clickhouse/client';
import {
  SourceTrace,
  SyncWindow,
  TraceSourceClient,
} from '../../../../application/interfaces/trace-source-client.js';
import {
  SyncCursor,
  TraceBatch,
  TraceBatchSource,
} from '../../../../application/interfaces/trace-batch-source.js';
import { PoisonRowRepository } from '../../../../application/interfaces/poison-row-repository.js';
import {
  SalvageableTokenField,
  SpanRow,
  SummaryRow,
  parseSummaryRow,
  spanRowSchema,
} from './clickhouse-row-schema.js';
import {
  corruptTokenCounts,
  mapSummaryTrace,
} from './clickhouse-row-mapper.js';
import { tokenSalvageIsSafe } from '../../token-salvage-gate.js';
import { Logger } from '@observability/core/common/logging/logger.js';
import { nullLogger } from '@observability/core/common/logging/null-logger.js';
import {
  DEFAULT_QUIET_PERIOD_MS,
  clampWindowToQuietPeriod,
} from '../quiet-period.js';

/**
 * The goose migration version of langwatch/langwatch:3.5.0 — the version
 * this client's SELECTs and mapper were validated against. Upgrading the
 * LangWatch image bumps this value in ClickHouse; the worker then refuses
 * to start (visibly, in a crash loop) instead of syncing through an
 * unverified schema. Re-validate the queries, then update this constant —
 * that IS the upgrade procedure (decision 59).
 */
export const EXPECTED_LANGWATCH_SCHEMA_VERSION = 35;

/**
 * Internal page size for the windowed backfill (audit C-6.3): bounds
 * memory to one page of summaries + spans + content, whatever the window
 * size — a 49-day onboarding backfill used to buffer everything and OOM
 * before the first insert. Matches the continuous loop's default batch.
 */
export const WINDOW_PAGE_SIZE = 1000;

export type QueryFn = (
  query: string,
  params: Record<string, unknown>,
) => Promise<unknown[]>;

const SUMMARY_SELECT = `
  SELECT
    s.TraceId                                 AS traceId,
    toUnixTimestamp64Milli(s.OccurredAt)      AS occurredAtMs,
    toUnixTimestamp64Milli(s.UpdatedAt)       AS updatedAtMs,
    s.Attributes                              AS attributes,
    s.ComputedInput                           AS computedInput,
    s.ComputedOutput                          AS computedOutput,
    s.TotalDurationMs                         AS totalDurationMs,
    s.ContainsErrorStatus                     AS containsError,
    s.ErrorMessage                            AS errorMessage,
    s.TotalPromptTokenCount                   AS promptTokens,
    s.TotalCompletionTokenCount               AS completionTokens,
    s.RootSpanType                            AS rootSpanType
  FROM trace_summaries AS s FINAL`;

/**
 * How far the span query looks before the batch's earliest trace start and
 * after its latest trace end. stored_spans is partitioned by the week of
 * StartTime and sorted by (TenantId, TraceId, SpanId); without a StartTime
 * bound and the tenant prefix, `TraceId IN (...)` under FINAL reads every
 * partition, and the query grew with the table until it passed the client
 * timeout (measured on 2026-10-22/23: 50 traces took 8s, then 99s; the same
 * batch with the window takes 0.4s, and 500 traces take 0.54s). The margin
 * covers clock skew between the trace summary and its spans; a span outside
 * [earliest start - margin, latest end + margin] would be a span of another
 * trace, not this batch's.
 */
export const SPAN_WINDOW_MARGIN_MS = 60 * 60 * 1000;

const spansSelect = (withTenant: boolean): string => `
  SELECT
    TraceId                                   AS traceId,
    SpanId                                    AS spanId,
    ParentSpanId                              AS parentSpanId,
    SpanName                                  AS name,
    toUnixTimestamp64Milli(StartTime)         AS startedAtMs,
    toUnixTimestamp64Milli(EndTime)           AS endedAtMs,
    StatusCode                                AS statusCode,
    StatusMessage                             AS statusMessage,
    mapUpdate(ResourceAttributes, SpanAttributes) AS attributes
  FROM stored_spans FINAL
  WHERE TraceId IN {traceIds:Array(String)}
    AND StartTime >= fromUnixTimestamp64Milli({spansFromMs:Int64})
    AND StartTime <= fromUnixTimestamp64Milli({spansToMs:Int64})
    ${withTenant ? 'AND TenantId = {tenantId:String}' : ''}
  ORDER BY StartTime ASC, SpanId ASC`;

/**
 * A summary row that passed the boundary, carried alongside the raw row it
 * came from: the salvage decision below needs BOTH the counts the schema
 * nulled and the untouched raw row (forensics for the durable record).
 */
interface ParsedSummary {
  row: SummaryRow;
  nulledTokenFields: SalvageableTokenField[];
  raw: unknown;
}

/**
 * decision 59 — LangWatch source read straight from its ClickHouse store
 * (same compose network) instead of the HTTP API: the search API returns
 * at most the newest ~100 traces per window and spans only via an N+1
 * detail GET, which does not survive real volume. Implements BOTH ports:
 * cursor-paged batches for the continuous worker (TraceBatchSource) and
 * the paged half-open window contract (TraceSourceClient) so `make sync`
 * keeps working unchanged.
 *
 * Rows that fail validation/mapping are POISON: skipped, logged with
 * their id AND persisted to the poison_rows collection (audit C-6.2 —
 * container logs rotate; the durable record is the recovery trail), never
 * fatal, and the cursor advances past them (decision 62 — one bad row
 * must not stall ingestion). Summary rows whose ONLY defect is a bad
 * token count MAY be salvaged instead — but only when the span-level
 * usage sums rebuild every corrupt count (see toSourceTraces; every
 * salvage leaves its own durable `summary_salvaged` record). EXCEPT when a
 * whole non-trivial batch is poison (decision 79): that is
 * indistinguishable from schema drift (the startup tripwire runs once —
 * a LangWatch upgrade mid-run would otherwise convert 100% of traffic to
 * skipped-and-logged rows while the cursor advances past them, a silent
 * permanent archive hole). All-poison batches throw instead.
 */
export class ClickHouseLangWatchClient
  implements TraceSourceClient, TraceBatchSource
{
  private readonly tenantId?: string;
  private readonly quietPeriodMs: number;
  private readonly queryFn: QueryFn;
  private readonly poisonRowRepository?: PoisonRowRepository;
  private readonly logger: Logger;

  constructor(args: {
    url: string;
    username: string;
    password: string;
    database: string;
    /** LangWatch project id — filters rows when the instance hosts more than one project. */
    tenantId?: string;
    /** Windowed-sync clamp (decision 61) — defaults to 15 min. */
    quietPeriodMs?: number;
    /** audit C-6.2: durable poison trail — optional so tests/fixtures stay log-only. */
    poisonRowRepository?: PoisonRowRepository;
    /** Test seam, like the HTTP client's fetchFn. */
    queryFn?: QueryFn;
    logger?: Logger;
  }) {
    this.tenantId = args.tenantId;
    this.quietPeriodMs = args.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
    this.poisonRowRepository = args.poisonRowRepository;
    this.queryFn = args.queryFn ?? makeClickHouseQueryFn(args);
    this.logger = args.logger ?? nullLogger;
  }

  /**
   * The schema tripwire: refuses to operate on a LangWatch schema version
   * other than the one this code was validated against. Called by the
   * worker at startup — a mismatch is FATAL by design, never skipped.
   */
  async assertCompatibleSchema(): Promise<void> {
    const rows = await this.queryFn(
      'SELECT max(version_id) AS version FROM goose_db_version WHERE is_applied = 1',
      {},
    );

    const version = Number((rows[0] as { version?: unknown })?.version);

    if (version !== EXPECTED_LANGWATCH_SCHEMA_VERSION) {
      throw new Error(
        `LangWatch ClickHouse schema version ${version} does not match the ` +
          `validated version ${EXPECTED_LANGWATCH_SCHEMA_VERSION}. The ` +
          'LangWatch image changed under this client — re-validate the ' +
          'SELECTs/mapper against the new schema and update ' +
          'EXPECTED_LANGWATCH_SCHEMA_VERSION (see decision 59).',
      );
    }
  }

  /**
   * The SOURCE's clock (audit C-6.4): the quiet period is measured on
   * UpdatedAt — the source's write times — so it must be anchored to the
   * source's clock, not the worker's. One cheap SELECT per cycle.
   */
  async sourceNow(): Promise<Date> {
    const rows = await this.queryFn(
      'SELECT toUnixTimestamp64Milli(now64(3)) AS nowMs',
      {},
    );

    const nowMs = Number((rows[0] as { nowMs?: unknown })?.nowMs);

    if (!Number.isFinite(nowMs)) {
      throw new Error(
        'Sync: ClickHouse clock read (now64) returned no usable value — ' +
          'refusing to guess the quiet-period ceiling (audit C-6.4).',
      );
    }

    return new Date(nowMs);
  }

  async fetchBatch(args: {
    after: SyncCursor | null;
    limit: number;
    updatedBefore: Date;
  }): Promise<TraceBatch> {
    // Tuple comparison gives a total order over (UpdatedAt, TraceId) — the
    // tie-breaker matters because many rows share one millisecond.
    const rows = await this.queryFn(
      `${SUMMARY_SELECT}
  WHERE (s.UpdatedAt, s.TraceId) > (fromUnixTimestamp64Milli({afterUpdatedAtMs:Int64}), {afterTraceId:String})
    AND s.UpdatedAt < fromUnixTimestamp64Milli({updatedBeforeMs:Int64})
    ${this.tenantId ? 'AND s.TenantId = {tenantId:String}' : ''}
  ORDER BY s.UpdatedAt ASC, s.TraceId ASC
  LIMIT {limit:UInt32}`,
      {
        afterUpdatedAtMs: args.after?.updatedAt.getTime() ?? 0,
        afterTraceId: args.after?.traceId ?? '',
        updatedBeforeMs: args.updatedBefore.getTime(),
        limit: args.limit,
        ...(this.tenantId ? { tenantId: this.tenantId } : {}),
      },
    );

    const context = args.after
      ? `cursor=(${args.after.updatedAt.toISOString()}, ${args.after.traceId})`
      : 'cursor=start';
    const traces = await this.toSourceTraces(rows, context);

    assertNotAllPoison(rows.length, traces.length);

    return {
      traces,
      nextCursor: nextCursorOf(rows),
      scanned: rows.length,
    };
  }

  /**
   * Half-open [from, to) on the trace's own start instant — CLI contract,
   * served in bounded pages (audit C-6.3) keyed by the (OccurredAt,
   * TraceId) tuple cursor, the windowed twin of fetchBatch's machinery.
   */
  async *fetchTracesPaged(
    requestedWindow: SyncWindow,
  ): AsyncIterable<SourceTrace[]> {
    // Same quiet period as the continuous loop (decision 61): an in-flight
    // trace ingested mid-build freezes a partial, immutable stamp. The
    // clock is the SOURCE's (audit C-6.4), same as the ceiling below.
    const now = await this.sourceNow();
    const safe = clampWindowToQuietPeriod(
      requestedWindow,
      this.quietPeriodMs,
      now,
    );

    if (!safe) {
      this.logger.warn(
        'Sync: window entirely inside the quiet period — nothing fetched ' +
          '(decision 61: in-flight traces would freeze partial stamps)',
      );

      return;
    }

    if (safe.clamped) {
      this.logger.warn(
        'Sync: window upper bound clamped (quiet period, decision 61) — ' +
          're-run later to cover the rest',
        { clampedTo: safe.window.to.toISOString() },
      );
    }

    // audit B-4: the quiet period must hold on the UPDATE axis too — a
    // trace STARTED long ago but still receiving spans (long agent run,
    // human-in-the-loop pause) passes the OccurredAt clamp and would be
    // stamped with partial tokens, immutably. Defer any row updated after
    // the ceiling; the warn tells the operator a later re-run may fetch
    // more (the deferred rows stay in the source).
    const updatedBefore = new Date(now.getTime() - this.quietPeriodMs);

    this.logger.warn(
      'Sync: rows still updating past the ceiling are deferred (quiet ' +
        'period on the update axis, audit B-4) — re-run the window later ' +
        'to pick up traces that were still receiving spans',
      { updatedBefore: updatedBefore.toISOString() },
    );

    const window = safe.window;
    const context = `window=[${window.from.toISOString()}, ${window.to.toISOString()})`;
    let afterOccurredAtMs = 0;
    let afterTraceId = '';

    for (;;) {
      const rows = await this.queryFn(
        `${SUMMARY_SELECT}
  WHERE s.OccurredAt >= fromUnixTimestamp64Milli({fromMs:Int64})
    AND s.OccurredAt < fromUnixTimestamp64Milli({toMs:Int64})
    AND s.UpdatedAt < fromUnixTimestamp64Milli({updatedBeforeMs:Int64})
    AND (s.OccurredAt, s.TraceId) > (fromUnixTimestamp64Milli({afterOccurredAtMs:Int64}), {afterTraceId:String})
    ${this.tenantId ? 'AND s.TenantId = {tenantId:String}' : ''}
  ORDER BY s.OccurredAt ASC, s.TraceId ASC
  LIMIT {limit:UInt32}`,
        {
          fromMs: window.from.getTime(),
          toMs: window.to.getTime(),
          updatedBeforeMs: updatedBefore.getTime(),
          afterOccurredAtMs,
          afterTraceId,
          limit: WINDOW_PAGE_SIZE,
          ...(this.tenantId ? { tenantId: this.tenantId } : {}),
        },
      );

      if (rows.length === 0) {
        return;
      }

      const traces = await this.toSourceTraces(rows, context);

      assertNotAllPoison(rows.length, traces.length);

      if (traces.length > 0) {
        yield traces;
      }

      if (rows.length < WINDOW_PAGE_SIZE) {
        return;
      }

      const next = windowCursorOf(rows);

      if (!next) {
        // Unreachable past the all-poison breaker (a full page with no
        // representable row would have thrown) — defensive stop, never
        // an infinite re-read of the same page.
        return;
      }

      // Strict monotonicity or crash (audit A-3): a cursor that fails to
      // advance re-reads the same page forever — a silent spin the epoch-0
      // coercion bug reached once. A future regression must be a loud
      // error, never an infinite backfill.
      if (
        next.occurredAtMs < afterOccurredAtMs ||
        (next.occurredAtMs === afterOccurredAtMs &&
          next.traceId <= afterTraceId)
      ) {
        throw new Error(
          `Sync: window cursor failed to advance (${context}) — ` +
            `page cursor (${next.occurredAtMs}, ${next.traceId}) is not ` +
            `strictly after (${afterOccurredAtMs}, ${afterTraceId}). ` +
            'Refusing to loop on the same page (audit A-3).',
        );
      }

      afterOccurredAtMs = next.occurredAtMs;
      afterTraceId = next.traceId;
    }
  }

  private async toSourceTraces(
    rawRows: unknown[],
    context: string,
  ): Promise<SourceTrace[]> {
    const summaries: ParsedSummary[] = [];

    for (const raw of rawRows) {
      const parsed = parseSummaryRow(raw);

      if (parsed.ok) {
        summaries.push({
          row: parsed.row,
          nulledTokenFields: parsed.nulledTokenFields,
          raw,
        });
        continue;
      }

      const rowId = String(
        (raw as { traceId?: unknown })?.traceId ?? 'unknown',
      );

      this.logger.warn('Sync: poison summary row skipped', {
        traceId: rowId,
        err: String(parsed.error),
      });
      await this.poisonRowRepository?.record({
        kind: 'summary',
        id: rowId,
        context,
        error: parsed.error,
        seenAt: new Date(),
        rawRow: raw,
      });
    }

    if (summaries.length === 0) {
      return [];
    }

    const spansByTrace = await this.fetchSpans(
      summaries.map((summary) => summary.row.traceId),
      spanWindowOf(summaries.map((summary) => summary.row)),
      context,
    );

    const traces: SourceTrace[] = [];

    for (const { row, nulledTokenFields, raw } of summaries) {
      let trace: SourceTrace;

      try {
        trace = mapSummaryTrace(row, spansByTrace.get(row.traceId) ?? []);
      } catch (error) {
        this.logger.warn('Sync: poison trace skipped', {
          traceId: row.traceId,
          err: error,
        });
        await this.poisonRowRepository?.record({
          kind: 'summary',
          id: row.traceId,
          context,
          error: String(error),
          seenAt: new Date(),
          rawRow: raw,
        });
        continue;
      }

      // The second half of the C-6.2 salvage rule (audit iteration 1,
      // invariant 2) — the schema nulled the corrupt counts, the SHARED
      // gate decides whether the span-level `gen_ai.usage.*` sums rebuilt
      // them (re-audit iteration 2: one rule for every source adapter, so
      // a sibling adapter cannot ingest what this one refuses). Refused or
      // salvaged, the outcome is recorded durably; a refused row is
      // skipped and the cursor advances past it like any other poison row
      // (decision 62).
      if (
        nulledTokenFields.length > 0 &&
        !(await tokenSalvageIsSafe({
          trace,
          corrupt: corruptTokenCounts(nulledTokenFields),
          kind: 'summary',
          context,
          rawRow: raw,
          poisonRowRepository: this.poisonRowRepository,
          logger: this.logger,
        }))
      ) {
        continue;
      }

      traces.push(trace);
    }

    return traces;
  }

  private async fetchSpans(
    traceIds: string[],
    window: { fromMs: number; toMs: number },
    context: string,
  ): Promise<Map<string, SpanRow[]>> {
    const rows = await this.queryFn(spansSelect(Boolean(this.tenantId)), {
      traceIds,
      spansFromMs: window.fromMs,
      spansToMs: window.toMs,
      ...(this.tenantId ? { tenantId: this.tenantId } : {}),
    });
    const spansByTrace = new Map<string, SpanRow[]>();

    for (const raw of rows) {
      const parsed = spanRowSchema.safeParse(raw);

      if (!parsed.success) {
        const rowId = String(
          (raw as { spanId?: unknown })?.spanId ?? 'unknown',
        );

        this.logger.warn('Sync: poison span row skipped', {
          spanId: rowId,
          err: parsed.error.message,
        });
        await this.poisonRowRepository?.record({
          kind: 'span',
          id: rowId,
          context,
          error: parsed.error.message,
          seenAt: new Date(),
          rawRow: raw,
        });
        continue;
      }

      const spans = spansByTrace.get(parsed.data.traceId) ?? [];

      spans.push(parsed.data);
      spansByTrace.set(parsed.data.traceId, spans);
    }

    return spansByTrace;
  }
}

/**
 * The poison circuit breaker (decision 79): decision 62's skip-and-log is
 * right for an ISOLATED malformed row, but a batch where EVERY row fails
 * validation/mapping is a different animal — that is what schema drift
 * looks like from here (the startup tripwire runs once; a LangWatch
 * upgrade mid-run is invisible to it), and advancing the cursor over it
 * silently loses the whole stream to rotating container logs. Below the
 * threshold, N independent malformed rows in sequence stays plausible and
 * the skip-and-advance behavior is preserved; at or above it, halt loudly
 * without advancing. Also closes the sleepless-poll corner: an all-poison
 * FULL batch used to yield nextCursor=null + caughtUp=false, re-fetching
 * the identical batch in a tight loop.
 */
const POISON_BREAKER_MIN_ROWS = 10;

const assertNotAllPoison = (rowCount: number, traceCount: number): void => {
  if (rowCount >= POISON_BREAKER_MIN_ROWS && traceCount === 0) {
    throw new Error(
      `Sync: all ${rowCount} rows in this batch failed validation/mapping — ` +
        'this looks like LangWatch schema drift, not isolated poison rows. ' +
        'Halting WITHOUT advancing the cursor (the rows stay fetchable). ' +
        'Restart the worker to re-run the schema tripwire; if the LangWatch ' +
        'image changed, re-validate the SELECTs/mapper first (decision 59). ' +
        'The poison_rows records say which boundary rejected each row — a ' +
        'whole batch of refused salvages (corrupt token counts no span ' +
        'usage could rebuild) is an instrumentation defect at the source, ' +
        'not drift here.',
    );
  }
};

/**
 * The cursor advances over RAW rows — a poison row moves it forward like
 * any other, so it can never stall the loop. Raw field access REJECTS
 * non-numeric timestamps outright (audit A-3): the old guard coerced with
 * Number(), and Number(null) === 0 passes isFinite — so a page whose last
 * row carried a JSON null timestamp built an EPOCH-0 cursor, and the sync
 * re-read the same window forever with no error and no backoff. A row too
 * broken to carry (updatedAtMs, traceId) is skipped here; the batch still
 * advances via the later well-formed rows.
 */
const cursorTimestamp = (raw: unknown): number | null =>
  typeof raw === 'number' && Number.isFinite(raw) ? raw : null;

const nextCursorOf = (rawRows: unknown[]): SyncCursor | null => {
  for (let i = rawRows.length - 1; i >= 0; i -= 1) {
    const row = rawRows[i] as { updatedAtMs?: unknown; traceId?: unknown };
    const updatedAtMs = cursorTimestamp(row?.updatedAtMs);

    if (updatedAtMs !== null && typeof row.traceId === 'string') {
      return { updatedAt: new Date(updatedAtMs), traceId: row.traceId };
    }
  }

  return null;
};

/**
 * Windowed twin of nextCursorOf (audit C-6.3): the page cursor rides
 * (OccurredAt, TraceId) — the window's ORDER BY axis — with the same
 * poison-tolerant backwards scan.
 */
const windowCursorOf = (
  rawRows: unknown[],
): { occurredAtMs: number; traceId: string } | null => {
  for (let i = rawRows.length - 1; i >= 0; i -= 1) {
    const row = rawRows[i] as { occurredAtMs?: unknown; traceId?: unknown };
    const occurredAtMs = cursorTimestamp(row?.occurredAtMs);

    if (occurredAtMs !== null && typeof row.traceId === 'string') {
      return { occurredAtMs, traceId: row.traceId };
    }
  }

  return null;
};

const makeClickHouseQueryFn = (args: {
  url: string;
  username: string;
  password: string;
  database: string;
}): QueryFn => {
  const client = createClient({
    url: args.url,
    username: args.username,
    password: args.password,
    database: args.database,
    application: 'platform-sync',
  });

  return async (query, params) => {
    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
      clickhouse_settings: {
        // Int64 (our epoch-ms aliases) as JSON numbers, not strings —
        // epoch ms fits far below 2^53, so no precision is at risk.
        output_format_json_quote_64bit_integers: 0,
      },
    });

    return result.json();
  };
};

/**
 * The StartTime window that holds every span of a batch: from the earliest
 * trace start to the latest trace end, widened by SPAN_WINDOW_MARGIN_MS on
 * both sides. A negative or missing duration counts as zero, so a corrupt
 * summary only narrows the end to its own start plus the margin.
 */
export const spanWindowOf = (
  rows: ReadonlyArray<{ occurredAtMs: number; totalDurationMs: number }>,
): { fromMs: number; toMs: number } => {
  let fromMs = Number.POSITIVE_INFINITY;
  let toMs = Number.NEGATIVE_INFINITY;

  for (const row of rows) {
    const durationMs =
      Number.isFinite(row.totalDurationMs) && row.totalDurationMs > 0
        ? row.totalDurationMs
        : 0;

    fromMs = Math.min(fromMs, row.occurredAtMs);
    toMs = Math.max(toMs, row.occurredAtMs + durationMs);
  }

  return {
    fromMs: fromMs - SPAN_WINDOW_MARGIN_MS,
    toMs: toMs + SPAN_WINDOW_MARGIN_MS,
  };
};
