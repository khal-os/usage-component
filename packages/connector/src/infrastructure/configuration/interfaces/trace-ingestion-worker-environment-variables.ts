export interface TraceIngestionWorkerEnvironmentVariables {
  /**
   * The ONLY real trace source (decisions 59 + 127): LangWatch's OWN
   * ClickHouse store. When absent, the continuous worker idles and
   * `make sync` refuses to run — there is no fallback source. The HTTP
   * LangWatch client was removed by decision 127 (no client will ever
   * ingest over HTTP); the fixture fake exists but only behind the
   * EXPLICIT `traceSource: 'fixtures'` opt-in below.
   */
  langwatchClickhouseUrl?: string;
  langwatchClickhouseUser?: string;
  langwatchClickhousePassword?: string;
  langwatchClickhouseDatabase?: string;
  /** LangWatch project id — row filter when the instance hosts more than one project. */
  langwatchProjectId?: string;
  /**
   * EXPLICIT fixture opt-in (decision 127): 'fixtures' selects the
   * FakeTraceSourceClient for offline demos. It is never inferred — a
   * missing real source is a crash, not a silent fall-through: the old
   * inference chain once let an empty API key "sync" nine fabricated demo
   * traces into a real client's permanent archive with exit code 0.
   */
  traceSource?: 'fixtures';
  /** Seconds between catch-up cycles once caught up (default 60). */
  traceIngestionIntervalSeconds?: number;
  /** Max rows per batch — the loop's memory bound (default 1000). */
  traceIngestionBatchSize?: number;
  /** decision 61: seconds a trace must be quiet before syncing (default 900). */
  traceIngestionQuietPeriodSeconds?: number;
  /** Seconds between periodic reprocess sweeps in the worker (default 3600). */
  reprocessIntervalSeconds?: number;
  /** decision 183: max pending traces one sweep chunk examines per worker cycle (default 500). */
  reprocessMaxTracesPerCycle?: number;
}
