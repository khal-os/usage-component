import { runInLanes } from './run-in-lanes.js';

const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe('runInLanes (issue #102)', () => {
  it('MUST process every item exactly once', async () => {
    const seen: number[] = [];

    await runInLanes(
      [1, 2, 3, 4, 5, 6],
      (n) => String(n % 3),
      2,
      async (n) => {
        await tick();
        seen.push(n);
      },
    );

    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('MUST never run more than `concurrency` items at once', async () => {
    let inFlight = 0;
    let peak = 0;

    await runInLanes(
      Array.from({ length: 20 }, (_, i) => i),
      (n) => `lane-${n}`,
      4,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        await tick();
        inFlight -= 1;
      },
    );

    expect(peak).toBe(4);
  });

  it('MUST run same-key items one at a time and in input order', async () => {
    const events: string[] = [];
    let sessionInFlight = 0;
    let sessionPeak = 0;

    await runInLanes(
      [
        { id: 'a1', session: 'A' },
        { id: 'b1', session: 'B' },
        { id: 'a2', session: 'A' },
        { id: 'a3', session: 'A' },
        { id: 'b2', session: 'B' },
      ],
      (item) => item.session,
      8,
      async (item) => {
        if (item.session === 'A') {
          sessionInFlight += 1;
          sessionPeak = Math.max(sessionPeak, sessionInFlight);
        }

        await tick();
        events.push(item.id);

        if (item.session === 'A') sessionInFlight -= 1;
      },
    );

    expect(sessionPeak).toBe(1);
    expect(events.filter((id) => id.startsWith('a'))).toEqual([
      'a1',
      'a2',
      'a3',
    ]);
    expect(events.filter((id) => id.startsWith('b'))).toEqual(['b1', 'b2']);
  });

  it('MUST stop starting new items after a failure, let in-flight ones finish, and rethrow the first error', async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const boom = new Error('store down');

    await expect(
      runInLanes(
        Array.from({ length: 10 }, (_, i) => i),
        (n) => `lane-${n}`,
        2,
        async (n) => {
          started.push(n);
          await tick();

          if (n === 1) throw boom;

          await tick();
          finished.push(n);
        },
      ),
    ).rejects.toBe(boom);

    // Items 0 and 1 started together; 0 finished after 1 failed; nothing new started.
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([0]);
  });

  it('MUST behave as the old sequential loop with concurrency 1', async () => {
    const order: number[] = [];

    await runInLanes(
      [3, 1, 2],
      (n) => `lane-${n}`,
      1,
      async (n) => {
        await tick();
        order.push(n);
      },
    );

    expect(order).toEqual([3, 1, 2]);
  });

  it('MUST do nothing for an empty batch', async () => {
    const work = jest.fn(async () => undefined);

    await runInLanes([], () => 'x', 8, work);

    expect(work).not.toHaveBeenCalled();
  });
});
