/**
 * Runs `work` over every item with at most `concurrency` items in flight,
 * keeping items that share a lane key strictly sequential and in input
 * order (issue #102).
 *
 * Why lanes: inserting a trace recomputes its session summary from the
 * traces collection OUTSIDE the insert transaction (decision 80). Two
 * traces of the same session written concurrently could each recompute
 * before seeing the other, and the later $merge would overwrite the
 * summary with a stale view. Same session, same lane, one at a time.
 * Different sessions share nothing but the facet counters, whose $inc
 * conflicts the driver's withTransaction retries on its own.
 *
 * Failure: the first error thrown by `work` stops new items from
 * starting; items already in flight finish, then that first error is
 * rethrown. The caller decides what is fatal by throwing or not.
 */
export const runInLanes = async <T>(
  items: readonly T[],
  laneKeyOf: (item: T) => string,
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> => {
  const lanes = new Map<string, T[]>();

  for (const item of items) {
    const key = laneKeyOf(item);
    const lane = lanes.get(key);

    if (lane) {
      lane.push(item);
    } else {
      lanes.set(key, [item]);
    }
  }

  const queue = [...lanes.values()];
  const workers = Math.max(1, Math.min(Math.floor(concurrency), queue.length));
  let failure: { error: unknown } | null = null;

  const drain = async (): Promise<void> => {
    for (;;) {
      if (failure) return;

      const lane = queue.shift();

      if (!lane) return;

      for (const item of lane) {
        if (failure) return;

        try {
          await work(item);
        } catch (error) {
          failure ??= { error };

          return;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, () => drain()));

  if (failure) {
    throw (failure as { error: unknown }).error;
  }
};
