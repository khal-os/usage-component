import { PriceVersionModel } from '../../../domain/models/price-version-model.js';
import { ReprocessPendingDbUseCase } from './reprocess-pending-db-use-case.js';
import {
  EffectivePrices,
  PendingPriceFilter,
  PendingPriceTrace,
  PendingStamp,
  PriceVersionRepository,
  TraceRepository,
} from './reprocess-pending-protocols.js';
import { TraceAttribution } from '../../interfaces/trace-repository.js';
import { ModelRef } from '../../../domain/models/model-ref.js';
import { InMemoryBillingPeriodRepository } from '../../testSupport/billing-test-fakes.js';

/**
 * audit M2: the reprocess sweep finally gets its own spec — the closed-
 * month guard, the per-trace failure isolation (decision 79g), the
 * concurrent-skipped accounting and the B-5 model pin were all previously
 * asserted only incidentally (or only at zero).
 */

const JUNE_1 = new Date('2026-06-01T00:00:00.000Z');

const GPT: ModelRef = { id: 'gpt-5-mini', provider: 'openai' };

const pendingTrace = (
  overrides: Partial<PendingPriceTrace> & { traceId: string },
): PendingPriceTrace => ({
  model: GPT,
  startedAt: new Date('2026-07-05T12:00:00.000Z'),
  tokens: { input: 1000 },
  ...overrides,
});

class PriceVersionRepositoryStub implements PriceVersionRepository {
  /** Models with a registered input price; others resolve to {} (pending). */
  pricedModels = new Set<string>(['openai/gpt-5-mini']);
  failOnModel: string | null = null;
  readonly lookups: { model: string; atDate: Date }[] = [];

  async findEffectivePrices(
    model: string,
    atDate: Date,
  ): Promise<EffectivePrices> {
    this.lookups.push({ model, atDate });

    if (model === this.failOnModel) {
      throw new Error(`price table unreachable for ${model}`);
    }

    if (!this.pricedModels.has(model)) return {};

    return {
      input: {
        model,
        tokenType: 'input',
        pricingType: 'fixed_brl',
        priceMicrocentsPerMillion: 275_000_000,
        effectiveFrom: JUNE_1,
      },
    };
  }

  async insertVersion(): Promise<void> {}

  async listAllVersions(): Promise<PriceVersionModel[]> {
    return [];
  }
}

class TraceRepositoryStub implements TraceRepository {
  pending: PendingPriceTrace[] = [];
  stampResult: 'stamped' | 'skipped' = 'stamped';
  readonly stamps: {
    traceId: string;
    stamp: PendingStamp;
    pinnedModel: ModelRef | null;
  }[] = [];

  readonly filtersSeen: (PendingPriceFilter | undefined)[] = [];

  async findPendingPrice(
    limit: number,
    after?: { startedAt: Date; traceId: string },
    filter?: PendingPriceFilter,
  ): Promise<PendingPriceTrace[]> {
    this.filtersSeen.push(filter);

    // Adapter semantics: pending set, tuple-sorted, strictly after the
    // cursor, narrowed by the filter; stamped traces have left the set.
    const stillPending = this.pending.filter(
      (trace) =>
        !this.stamps.some((stamp) => stamp.traceId === trace.traceId) &&
        (!filter?.withModelOnly || trace.model !== undefined) &&
        (!filter?.model ||
          (trace.model?.id === filter.model.id &&
            trace.model.provider === filter.model.provider)),
    );
    const sorted = [...stillPending].sort(
      (a, b) =>
        a.startedAt.getTime() - b.startedAt.getTime() ||
        (a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0),
    );
    const fromCursor = after
      ? sorted.filter(
          (trace) =>
            trace.startedAt.getTime() > after.startedAt.getTime() ||
            (trace.startedAt.getTime() === after.startedAt.getTime() &&
              trace.traceId > after.traceId),
        )
      : sorted;

    return fromCursor.slice(0, limit);
  }

  async countPendingPrice(): Promise<number> {
    return this.pending.filter(
      (trace) => !this.stamps.some((stamp) => stamp.traceId === trace.traceId),
    ).length;
  }

  async stampPendingTrace(
    traceId: string,
    stamp: PendingStamp,
    pinnedModel: ModelRef | null,
  ): Promise<'stamped' | 'skipped'> {
    this.stamps.push({ traceId, stamp, pinnedModel });

    return this.stampResult;
  }

  async insertIfAbsent(): Promise<'inserted'> {
    return 'inserted';
  }

  async updateAttribution(
    _traceId: string,
    _attribution: TraceAttribution,
  ): Promise<{ modelPinnedByStamp: boolean }> {
    return { modelPinnedByStamp: false };
  }

  async reconcileQuarantineAfterClose(): Promise<{
    flaggedStragglers: number;
    absorbed: number;
  }> {
    return { flaggedStragglers: 0, absorbed: 0 };
  }
}

const makeSut = () => {
  const priceVersionRepository = new PriceVersionRepositoryStub();
  const traceRepository = new TraceRepositoryStub();
  const billingPeriodRepository = new InMemoryBillingPeriodRepository();

  const sut = new ReprocessPendingDbUseCase({
    priceVersionRepository,
    traceRepository,
    billingPeriodRepository,
  });

  return {
    sut,
    priceVersionRepository,
    traceRepository,
    billingPeriodRepository,
  };
};

const closeMonth = (
  billingPeriodRepository: InMemoryBillingPeriodRepository,
  year: number,
  month: number,
) =>
  billingPeriodRepository.markClosed({
    year,
    month,
    closedAt: new Date('2026-07-01T03:00:00.000Z'),
    snapshotVersion: 1,
    audit: {
      at: new Date('2026-07-01T03:00:00.000Z'),
      action: 'close',
      trigger: 'runbook',
      snapshotVersion: 1,
    },
  });

describe('ReprocessPendingDbUseCase', () => {
  it('T6 guard: a pending trace inside a CLOSED month is counted, never stamped', async () => {
    const { sut, traceRepository, billingPeriodRepository } = makeSut();
    await closeMonth(billingPeriodRepository, 2026, 6);

    traceRepository.pending = [
      pendingTrace({
        traceId: 'closed-june',
        startedAt: new Date('2026-06-10T00:00:00.000Z'),
      }),
      pendingTrace({ traceId: 'open-july' }),
    ];

    const report = await sut.reprocess();

    expect(report).toEqual({
      examined: 2,
      stamped: 1,
      stillPending: 0,
      failed: 0,
      blockedClosedMonth: 1,
      // The blocked trace stays pending — reported, never hidden.
      pendingRemaining: 1,
    });
    expect(traceRepository.stamps.map((stamp) => stamp.traceId)).toEqual([
      'open-july',
    ]);
  });

  it('QA19: resolves prices as-of the TRACE date, per trace', async () => {
    const { sut, priceVersionRepository, traceRepository } = makeSut();
    traceRepository.pending = [
      pendingTrace({
        traceId: 't1',
        startedAt: new Date('2026-07-03T09:00:00.000Z'),
      }),
    ];

    await sut.reprocess();

    expect(priceVersionRepository.lookups).toEqual([
      {
        model: 'openai/gpt-5-mini',
        atDate: new Date('2026-07-03T09:00:00.000Z'),
      },
    ]);
  });

  it('per-trace isolation (decision 79g): one throwing trace never loses the run', async () => {
    const { sut, priceVersionRepository, traceRepository } = makeSut();
    priceVersionRepository.pricedModels.add('meta/llama-4-scout');
    priceVersionRepository.failOnModel = 'anthropic/claude-haiku-4-5';

    traceRepository.pending = [
      pendingTrace({ traceId: 'ok-1' }),
      pendingTrace({
        traceId: 'poison',
        model: { id: 'claude-haiku-4-5', provider: 'anthropic' },
      }),
      pendingTrace({
        traceId: 'ok-2',
        model: { id: 'llama-4-scout', provider: 'meta' },
      }),
    ];

    const report = await sut.reprocess();

    expect(report).toEqual({
      examined: 3,
      stamped: 2,
      stillPending: 0,
      failed: 1,
      blockedClosedMonth: 0,
      // The failed trace stays pending for the next sweep.
      pendingRemaining: 1,
    });
    expect(traceRepository.stamps.map((stamp) => stamp.traceId)).toEqual([
      'ok-1',
      'ok-2',
    ]);
  });

  it('a model still without price stays pending — never R$ 0 (invariant 2)', async () => {
    const { sut, traceRepository } = makeSut();
    traceRepository.pending = [
      pendingTrace({
        traceId: 'no-price',
        model: { id: 'nova-2', provider: 'amazon' },
      }),
      // No model at all: nothing to look prices up for — stays pending.
      pendingTrace({ traceId: 'no-model', model: undefined }),
    ];

    const report = await sut.reprocess();

    expect(report.stillPending).toBe(2);
    expect(report.stamped).toBe(0);
    expect(traceRepository.stamps).toEqual([]);
  });

  it('concurrent-skipped counts as STAMPED: the trace IS stamped either way (or the model moved and the next sweep settles it)', async () => {
    const { sut, traceRepository } = makeSut();
    traceRepository.pending = [pendingTrace({ traceId: 'raced' })];
    traceRepository.stampResult = 'skipped';

    const report = await sut.reprocess();

    expect(report).toEqual({
      examined: 1,
      stamped: 1,
      stillPending: 0,
      failed: 0,
      blockedClosedMonth: 0,
      pendingRemaining: 0,
    });
  });

  it('audit B-5: passes the model the prices were resolved for as the CAS pin', async () => {
    const { sut, traceRepository } = makeSut();
    traceRepository.pending = [pendingTrace({ traceId: 'pin-me' })];

    await sut.reprocess();

    expect(traceRepository.stamps).toEqual([
      expect.objectContaining({
        traceId: 'pin-me',
        pinnedModel: GPT,
      }),
    ]);
    // The pin is the exact ref the price lookup used — never re-read, so
    // a concurrent correction makes the CAS miss instead of mis-stamping.
    expect(traceRepository.stamps[0]?.pinnedModel).toBe(
      traceRepository.pending[0]?.model,
    );
  });

  it('audit B-5: maxTraces caps ONE run and reports the honest remainder — the HTTP door never drags a day of backlog', async () => {
    const { sut, traceRepository } = makeSut();
    traceRepository.pending = [
      pendingTrace({
        traceId: 'p1',
        startedAt: new Date('2026-07-05T10:00:00Z'),
      }),
      pendingTrace({
        traceId: 'p2',
        startedAt: new Date('2026-07-05T11:00:00Z'),
      }),
      pendingTrace({
        traceId: 'p3',
        startedAt: new Date('2026-07-05T12:00:00Z'),
      }),
    ];

    const report = await sut.reprocess({ maxTraces: 2 });

    expect(report.examined).toBe(2);
    expect(report.stamped).toBe(2);
    expect(report.pendingRemaining).toBe(1);
    expect(traceRepository.stamps.map((stamp) => stamp.traceId)).toEqual([
      'p1',
      'p2',
    ]);
  });

  it('audit B-5: a page-sized clog of closed-month traces at the HEAD must not starve the stampable ones behind it', async () => {
    const { sut, traceRepository, billingPeriodRepository } = makeSut();
    await closeMonth(billingPeriodRepository, 2026, 6);

    // 501 blocked traces (closed June) older than one stampable July trace:
    // a head-anchored re-read would fetch the same blocked page forever and
    // never reach 'reachable'. The tuple cursor walks past them.
    traceRepository.pending = [
      ...Array.from({ length: 501 }, (_, i) =>
        pendingTrace({
          traceId: `blocked-${String(i).padStart(3, '0')}`,
          startedAt: new Date(Date.UTC(2026, 5, 10, 0, 0, i % 60, i)),
        }),
      ),
      pendingTrace({
        traceId: 'reachable',
        startedAt: new Date('2026-07-05T12:00:00Z'),
      }),
    ];

    const report = await sut.reprocess();

    expect(report.blockedClosedMonth).toBe(501);
    expect(report.stamped).toBe(1);
    expect(traceRepository.stamps.map((stamp) => stamp.traceId)).toEqual([
      'reachable',
    ]);
  });
});

describe('ReprocessPendingDbUseCase — resumable chunks and filters (decision 183)', () => {
  const at = (hour: number) => new Date(Date.UTC(2026, 6, 5, hour));

  it('a capped run hands back resumeAfter, and the next run continues WITHOUT re-examining the head', async () => {
    const { sut, traceRepository, priceVersionRepository } = makeSut();
    // Unpriced head: they stay pending, so only the cursor can move past them.
    priceVersionRepository.pricedModels.clear();
    traceRepository.pending = [
      pendingTrace({ traceId: 'a', startedAt: at(1) }),
      pendingTrace({ traceId: 'b', startedAt: at(2) }),
      pendingTrace({ traceId: 'c', startedAt: at(3) }),
    ];

    const first = await sut.reprocess({ maxTraces: 2 });

    expect(first.examined).toBe(2);
    expect(first.resumeAfter).toEqual({ startedAt: at(2), traceId: 'b' });

    const second = await sut.reprocess({
      maxTraces: 2,
      after: first.resumeAfter,
    });

    expect(second.examined).toBe(1);
    expect(second.resumeAfter).toBeUndefined();
    expect(priceVersionRepository.lookups).toHaveLength(3);
  });

  it('a run that reaches the end of the queue reports no resumeAfter', async () => {
    const { sut, traceRepository } = makeSut();
    traceRepository.pending = [pendingTrace({ traceId: 'only' })];

    const report = await sut.reprocess({ maxTraces: 500 });

    expect(report.examined).toBe(1);
    expect(report.resumeAfter).toBeUndefined();
  });

  it('a trace that turns pending BEHIND the cursor waits for the next round (accepted, documented gap)', async () => {
    const { sut, traceRepository, priceVersionRepository } = makeSut();
    priceVersionRepository.pricedModels.clear();
    traceRepository.pending = [
      pendingTrace({ traceId: 'a', startedAt: at(1) }),
      pendingTrace({ traceId: 'c', startedAt: at(3) }),
    ];

    const first = await sut.reprocess({ maxTraces: 1 });
    traceRepository.pending.push(
      pendingTrace({ traceId: 'late', startedAt: at(0) }),
    );
    const second = await sut.reprocess({
      maxTraces: 5,
      after: first.resumeAfter,
    });

    expect(second.examined).toBe(1);
    expect(priceVersionRepository.lookups.map((l) => l.atDate)).not.toContain(
      at(0),
    );
  });

  it('model: stamps only the traces of the model whose price was just registered', async () => {
    const { sut, traceRepository, priceVersionRepository } = makeSut();
    const SONNET: ModelRef = { id: 'claude-sonnet-4-6', provider: 'anthropic' };
    priceVersionRepository.pricedModels.add('anthropic/claude-sonnet-4-6');
    // An older page of other-model traces that must not eat the cap.
    traceRepository.pending = [
      pendingTrace({ traceId: 'gpt-old', startedAt: at(1) }),
      pendingTrace({ traceId: 'sonnet', startedAt: at(2), model: SONNET }),
    ];

    const report = await sut.reprocess({ maxTraces: 1, model: SONNET });

    expect(report.examined).toBe(1);
    expect(traceRepository.stamps.map((stamp) => stamp.traceId)).toEqual([
      'sonnet',
    ]);
  });

  it('onlyWithModel: traces with no model are never examined — no price can stamp them', async () => {
    const { sut, traceRepository } = makeSut();
    traceRepository.pending = [
      pendingTrace({ traceId: 'no-model', model: undefined, startedAt: at(1) }),
      pendingTrace({ traceId: 'with-model', startedAt: at(2) }),
    ];

    const report = await sut.reprocess({ onlyWithModel: true });

    expect(report.examined).toBe(1);
    expect(traceRepository.stamps.map((stamp) => stamp.traceId)).toEqual([
      'with-model',
    ]);
    // pendingRemaining stays the honest whole-queue count.
    expect(report.pendingRemaining).toBe(1);
  });

  it('no options: the runbook path passes no filter and walks everything, as before', async () => {
    const { sut, traceRepository } = makeSut();
    traceRepository.pending = [
      pendingTrace({ traceId: 'no-model', model: undefined }),
    ];

    const report = await sut.reprocess();

    expect(report.examined).toBe(1);
    expect(traceRepository.filtersSeen[0]).toEqual({});
  });
});
