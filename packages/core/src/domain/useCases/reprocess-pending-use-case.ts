import { ModelRef } from '../models/model-ref.js';
import { PendingPriceCursor } from '../models/pending-price-cursor.js';

export interface ReprocessReport {
  examined: number;
  /** Includes traces a concurrent reprocess stamped first — they ARE stamped. */
  stamped: number;
  stillPending: number;
  /** Per-trace errors — isolated so one bad trace never loses the run (decision 79). */
  failed: number;
  /**
   * Traces dated inside a CLOSED month (T6): stamping them is blocked —
   * only the audited reopen flow unblocks. Counted, never touched.
   */
  blockedClosedMonth: number;
  /**
   * Pending traces left AFTER this run (audit B-5): a capped run (the
   * POST /prices door) stamps one page and reports the honest remainder —
   * the worker's periodic sweep drains it (decision 57's backstop).
   */
  pendingRemaining: number;
  /**
   * Decision 183: set only when the run stopped at `maxTraces` with queue
   * left to walk — pass it back as `after` to resume. Absent means the run
   * reached the end of the queue (for the filters it was given).
   */
  resumeAfter?: PendingPriceCursor;
}

export interface ReprocessOptions {
  /**
   * audit B-5: caps one run. The HTTP price door passes it so a day-sized
   * backlog never rides one request; the worker sweep passes it so a big
   * queue never holds ingestion for hours (decision 183). The runbook job
   * stays uncapped. pendingRemaining is the honest remainder either way.
   */
  maxTraces?: number;
  /** Decision 183: resume strictly after this position (a previous resumeAfter). */
  after?: PendingPriceCursor;
  /** Decision 183: only traces served by this model — the price door's target. */
  model?: ModelRef;
  /**
   * Decision 183: skip traces with no model. No price can stamp them; only
   * an attribution correction can, after which the next run picks them up.
   */
  onlyWithModel?: boolean;
}

export interface ReprocessPendingUseCase {
  reprocess(options?: ReprocessOptions): Promise<ReprocessReport>;
}
