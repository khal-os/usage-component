import { MongoDb } from '../mongo-db.js';
import { runMigrations } from '../helpers/migration-runner.js';
import { migrations } from '../migrations/index.js';
import { MongoDbBillingQueryRepository } from './mongodb-billing-query-repository.js';
import { MongoDbTraceRepository } from '../trace/mongodb-trace-repository.js';
import { TRACES_COLLECTION } from '../collections.js';
import {
  makeContractStampedCosts,
  makeContractTrace,
} from '../../../../application/interfaces/trace-repository.contract.js';
import { monthWindow } from '../../../../domain/models/billing-period-model.js';

/**
 * The WINDOW arguments of the billing-query port, proven against the REAL
 * adapter (audit E-2): the unit fakes truncated these parameters for
 * months — `accruedCostMicrocents()` took ZERO arguments against a port
 * that takes two — so a regression in the adapter's `$lt` bound was
 * structurally unfalsifiable: drop `startOfToday` from the projection's
 * numerator and every spec stayed green while every current-month
 * run-rate silently inflated. These cases fail on exactly those reverts.
 */
const JUNE_START = new Date('2026-06-01T00:00:00.000Z');
const JULY_START = new Date('2026-07-01T00:00:00.000Z');

describe('Billing query windows against the real adapter (audit E-2)', () => {
  const repository = new MongoDbBillingQueryRepository();
  const traces = new MongoDbTraceRepository();

  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env['MONGO_URL'] as string);
  });

  beforeEach(async () => {
    await MongoDb.getCollection(TRACES_COLLECTION).deleteMany({});
    await runMigrations(MongoDb.getClient().db(), migrations);
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  const seed = async (
    traceId: string,
    startedAt: Date,
    ingestedAt: Date,
    costMicrocents: number,
  ) => {
    await traces.insertIfAbsent(
      makeContractTrace({
        traceId,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 1000),
        ingestedAt,
        totalCostMicrocents: costMicrocents,
      }),
    );
  };

  it("accruedCostMicrocents MUST honor BOTH window bounds — the projection depends on excluding today's partial day", async () => {
    await seed(
      'w-1',
      new Date('2026-06-05T10:00:00Z'),
      new Date('2026-06-05T11:00:00Z'),
      100_000,
    );
    await seed(
      'w-2',
      new Date('2026-06-20T10:00:00Z'),
      new Date('2026-06-20T11:00:00Z'),
      200_000,
    );
    await seed(
      'w-3',
      new Date('2026-07-02T10:00:00Z'),
      new Date('2026-07-02T11:00:00Z'),
      400_000,
    );

    const upToMidJune = new Date('2026-06-15T00:00:00.000Z');

    expect(
      await repository.accruedCostMicrocents(JUNE_START, upToMidJune),
    ).toBe(100_000);
    expect(await repository.accruedCostMicrocents(JUNE_START, JULY_START)).toBe(
      300_000,
    );
  });

  it("ingestionWatermark MUST stay inside the month window — a closed month's frozen audit must never carry a LATER month's freshness", async () => {
    await seed(
      'm-1',
      new Date('2026-06-10T10:00:00Z'),
      new Date('2026-06-10T12:00:00Z'),
      100_000,
    );
    // Ingested much later AND started in July: outside June's window on
    // the axis the adapter filters by.
    await seed(
      'm-2',
      new Date('2026-07-03T10:00:00Z'),
      new Date('2026-07-03T12:00:00Z'),
      100_000,
    );

    const juneWatermark = await repository.ingestionWatermark(
      JUNE_START,
      JULY_START,
    );

    expect(juneWatermark?.toISOString()).toBe('2026-06-10T12:00:00.000Z');
  });

  describe('countNoMeasuredUsage (decision 128)', () => {
    it('MUST count ONLY no_measured_usage traces inside the month window', async () => {
      const traces = new MongoDbTraceRepository();

      await traces.insertIfAbsent(
        makeContractTrace({
          traceId: 'nmu-in-window',
          startedAt: new Date('2026-06-10T12:00:00Z'),
          tokens: {},
          tokensTotal: 0,
          pricingStatus: 'no_measured_usage',
          stampedCosts: undefined,
          totalCostMicrocents: undefined,
          stampedAt: undefined,
        }),
      );
      await traces.insertIfAbsent(
        makeContractTrace({
          traceId: 'nmu-out-of-window',
          startedAt: new Date('2026-07-10T12:00:00Z'),
          tokens: {},
          tokensTotal: 0,
          pricingStatus: 'no_measured_usage',
          stampedCosts: undefined,
          totalCostMicrocents: undefined,
          stampedAt: undefined,
        }),
      );
      // A stamped trace in-window must NOT count.
      await traces.insertIfAbsent(
        makeContractTrace({
          traceId: 'nmu-stamped-neighbor',
          startedAt: new Date('2026-06-11T12:00:00Z'),
        }),
      );

      const repository = new MongoDbBillingQueryRepository();
      const count = await repository.countNoMeasuredUsage(
        new Date('2026-06-01T00:00:00Z'),
        new Date('2026-07-01T00:00:00Z'),
      );

      expect(count).toBe(1);
    });
  });
});

/**
 * Decision 181 — the month bucket is the CLIENT's, in the adapter too.
 *
 * `$year`/`$month` answer in UTC unless told otherwise, so for the UTC-3
 * client every trace started in the last three local hours of a month was
 * filed under the NEXT one. /billing/summary (which cuts with monthWindow,
 * decision 130) and /bills (which cut with the bare operators) therefore
 * disagreed by exactly those traces — observed on hapvida dev, May 2026:
 * 780 traces / R$ 189,25 on the summary against 778 / R$ 189,14 on the
 * bills listing. Invariants 3 and 8 in one defect.
 *
 * 2026-05-31T23:30 in São Paulo is 2026-06-01T02:30Z: a MAY trace whose
 * UTC stamp says June. It is the whole test.
 */
const LAST_LOCAL_HOURS_OF_MAY = new Date('2026-06-01T02:30:00.000Z');
const FIRST_LOCAL_HOUR_OF_JUNE = new Date('2026-06-01T04:00:00.000Z');
const MID_MAY = new Date('2026-05-15T12:00:00.000Z');

describe('Month bucketing cuts at the CLIENT midnight (decision 181)', () => {
  const repository = new MongoDbBillingQueryRepository();
  const traces = new MongoDbTraceRepository();

  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env['MONGO_URL'] as string);
  });

  beforeEach(async () => {
    await MongoDb.getCollection(TRACES_COLLECTION).deleteMany({});
    await runMigrations(MongoDb.getClient().db(), migrations);
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  /** Stamped trace whose stamp and its total agree — invariant 3's diet. */
  const seedStamped = async (
    traceId: string,
    startedAt: Date,
    costMicrocents: number,
  ) => {
    await traces.insertIfAbsent(
      makeContractTrace({
        traceId,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 1000),
        stampedCosts: makeContractStampedCosts().map((cost) => ({
          ...cost,
          costMicrocents,
        })),
        totalCostMicrocents: costMicrocents,
      }),
    );
  };

  const seedTheBoundary = async () => {
    await seedStamped('may-mid', MID_MAY, 100_000);
    await seedStamped('may-last-local-hours', LAST_LOCAL_HOURS_OF_MAY, 7_000);
    await seedStamped('june-first-local-hour', FIRST_LOCAL_HOUR_OF_JUNE, 900);
  };

  it('listBills MUST file a trace started in the last local hours of May under MAY — not June', async () => {
    await seedTheBoundary();

    const bills = await repository.listBills(null, []);
    const may = bills.find((row) => row.year === 2026 && row.month === 5);
    const june = bills.find((row) => row.year === 2026 && row.month === 6);

    expect(may).toMatchObject({
      stampedTraceCount: 2,
      totalCostMicrocents: 107_000,
    });
    // The neighbor one local hour later is genuinely June: the fix moves
    // the boundary, it does not drag the whole month backwards.
    expect(june).toMatchObject({
      stampedTraceCount: 1,
      totalCostMicrocents: 900,
    });
  });

  it('monthlyRollup (T8 series) MUST bucket that same trace under MAY — the chart and the bill are one truth', async () => {
    await seedTheBoundary();

    const rollup = await repository.monthlyRollup(null);
    const may = rollup.find((row) => row.year === 2026 && row.month === 5);
    const june = rollup.find((row) => row.year === 2026 && row.month === 6);

    expect(may?.totalCostMicrocents).toBe(107_000);
    expect(june?.totalCostMicrocents).toBe(900);

    // The per-model split is assembled from the SAME grouping key, so a
    // UTC bucket would have mis-filed the composition lens too.
    expect(may?.byModel).toEqual([
      {
        model: 'openai/gpt-5-mini',
        costMicrocents: 107_000,
        byTokenType: [{ tokenType: 'input', costMicrocents: 107_000 }],
      },
    ]);
  });

  it('invariant 3: the bills row for MAY MUST equal the summary window sum, to the cent', async () => {
    await seedTheBoundary();

    const may = monthWindow(2026, 5);
    // What GET /billing/summary sums (the decision-130 window)...
    const summaryTotal = await repository.accruedCostMicrocents(
      may.start,
      may.end,
    );
    // ...and what GET /bills reports for the same month.
    const billsTotal = (await repository.listBills(null, [])).find(
      (row) => row.year === 2026 && row.month === 5,
    )?.totalCostMicrocents;

    expect(billsTotal).toBe(summaryTotal);
    expect(billsTotal).toBe(107_000);
  });
});
