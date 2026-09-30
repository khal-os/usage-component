import type { PendingPriceCursor } from '@observability/core/domain/models/pending-price-cursor.js';

/**
 * Decision 183 — how the worker paces the reprocess sweep. A round is one
 * walk of the pending queue, oldest to newest, done in capped chunks: one
 * chunk per worker cycle, after that cycle's ingestion drain, so a big queue
 * never holds ingestion for hours (2026-09-28 incident). A new round only
 * starts when the cadence has elapsed since the last round ended.
 *
 * Pure: the loop owns the clock and the state, this owns the rule.
 */
export interface SweepState {
  /** Where the round in progress stopped; absent when no round is open. */
  cursor?: PendingPriceCursor;
  /** When the last round reached the end of the queue; 0 = never. */
  lastRoundEndedAt: number;
}

export type SweepAction =
  { kind: 'skip' } | { kind: 'run-chunk'; after?: PendingPriceCursor };

export const nextSweepAction = (
  state: SweepState,
  now: number,
  reprocessIntervalMs: number,
): SweepAction => {
  if (state.cursor) return { kind: 'run-chunk', after: state.cursor };

  if (now - state.lastRoundEndedAt >= reprocessIntervalMs) {
    return { kind: 'run-chunk' };
  }

  return { kind: 'skip' };
};

/**
 * Folds a chunk's outcome into the state. A chunk either moves the cursor
 * strictly forward (the use case hands back the last trace it read) or
 * ends the round; a round never restarts from its own head mid-way.
 */
export const afterSweepChunk = (
  resumeAfter: PendingPriceCursor | undefined,
  now: number,
  previous: SweepState,
): SweepState =>
  resumeAfter
    ? { cursor: resumeAfter, lastRoundEndedAt: previous.lastRoundEndedAt }
    : { lastRoundEndedAt: now };
