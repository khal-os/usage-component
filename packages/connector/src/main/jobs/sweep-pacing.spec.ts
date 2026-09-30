import { afterSweepChunk, nextSweepAction } from './sweep-pacing.js';

const HOUR = 3_600_000;
const cursor = (traceId: string) => ({
  startedAt: new Date('2026-09-28T12:00:00.000Z'),
  traceId,
});

describe('sweep pacing (decision 183)', () => {
  it('starts the first round on the first cycle', () => {
    expect(nextSweepAction({ lastRoundEndedAt: 0 }, 10 * HOUR, HOUR)).toEqual({
      kind: 'run-chunk',
    });
  });

  it('with no open round, waits for the cadence after the last round ended', () => {
    const state = { lastRoundEndedAt: 10 * HOUR };

    expect(nextSweepAction(state, 10 * HOUR + HOUR - 1, HOUR)).toEqual({
      kind: 'skip',
    });
    expect(nextSweepAction(state, 11 * HOUR, HOUR)).toEqual({
      kind: 'run-chunk',
    });
  });

  it('with a round open, runs the next chunk right away from the cursor, cadence or not', () => {
    const state = { cursor: cursor('t-500'), lastRoundEndedAt: 10 * HOUR };

    expect(nextSweepAction(state, 10 * HOUR + 60_000, HOUR)).toEqual({
      kind: 'run-chunk',
      after: cursor('t-500'),
    });
  });

  it('a capped chunk keeps the round open at the handed-back cursor', () => {
    const next = afterSweepChunk(cursor('t-1000'), 5 * HOUR, {
      cursor: cursor('t-500'),
      lastRoundEndedAt: 2 * HOUR,
    });

    expect(next).toEqual({
      cursor: cursor('t-1000'),
      lastRoundEndedAt: 2 * HOUR,
    });
  });

  it('a chunk that reaches the end closes the round and stamps the time', () => {
    const next = afterSweepChunk(undefined, 5 * HOUR, {
      cursor: cursor('t-1000'),
      lastRoundEndedAt: 2 * HOUR,
    });

    expect(next).toEqual({ lastRoundEndedAt: 5 * HOUR });
    expect(nextSweepAction(next, 5 * HOUR + 1, HOUR)).toEqual({ kind: 'skip' });
  });

  it('invariant: every chunk either carries the round forward or ends it — never back to its head', () => {
    let state = afterSweepChunk(cursor('t-500'), 1, { lastRoundEndedAt: 0 });
    const seen = [state.cursor?.traceId];

    state = afterSweepChunk(cursor('t-1000'), 2, state);
    seen.push(state.cursor?.traceId);
    state = afterSweepChunk(undefined, 3, state);

    expect(seen).toEqual(['t-500', 't-1000']);
    expect(state.cursor).toBeUndefined();
    expect(nextSweepAction(state, 3, HOUR)).toEqual({ kind: 'skip' });
  });
});
