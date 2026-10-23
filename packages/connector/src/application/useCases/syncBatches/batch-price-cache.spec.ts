import {
  EffectivePrices,
  PriceVersionRepository,
} from '@observability/core/application/interfaces/price-version-repository.js';
import { PriceVersionModel } from '@observability/core/domain/models/price-version-model.js';
import { BatchPriceCache } from './batch-price-cache.js';

const SEPT = new Date('2026-09-01T00:00:00.000Z');
const OCT_15 = new Date('2026-10-15T12:00:00.000Z');

const version = (
  model: string,
  effectiveFrom: Date,
  tokenType: 'input' | 'output' = 'input',
): PriceVersionModel =>
  ({ model, tokenType, effectiveFrom }) as unknown as PriceVersionModel;

/** Counts calls and answers with the label of the interval the date falls in. */
class CountingPriceRepository implements PriceVersionRepository {
  effectiveCalls: Array<{ model: string; at: number }> = [];
  listCalls = 0;

  constructor(private readonly versions: PriceVersionModel[]) {}

  async findEffectivePrices(
    model: string,
    atDate: Date,
  ): Promise<EffectivePrices> {
    this.effectiveCalls.push({ model, at: atDate.getTime() });
    const inForce = this.versions.filter(
      (v) => v.model === model && v.effectiveFrom.getTime() <= atDate.getTime(),
    );

    return { input: inForce.at(-1) } as EffectivePrices;
  }

  async insertVersion(): Promise<void> {}

  async listAllVersions(filter?: {
    model?: string;
  }): Promise<PriceVersionModel[]> {
    this.listCalls += 1;

    return this.versions.filter(
      (v) => !filter?.model || v.model === filter.model,
    );
  }
}

describe('BatchPriceCache (issue #102)', () => {
  const versions = [
    version('m', SEPT),
    version('m', SEPT, 'output'), // same instant, one boundary
    version('m', OCT_15),
    version('other', SEPT),
  ];

  it('MUST ask the repository once per interval, not once per trace', async () => {
    const inner = new CountingPriceRepository(versions);
    const cache = new BatchPriceCache(inner);

    for (let day = 1; day <= 10; day += 1) {
      await cache.findEffectivePrices(
        'm',
        new Date(`2026-10-0${Math.min(day, 9)}T10:00:00Z`),
      );
    }

    expect(inner.effectiveCalls).toHaveLength(1);
    expect(inner.listCalls).toBe(1);
  });

  it('MUST return what the repository returns for that date, on both sides of a new version', async () => {
    const inner = new CountingPriceRepository(versions);
    const cache = new BatchPriceCache(inner);
    const before = new Date('2026-10-14T23:59:59.999Z');
    const exactly = OCT_15;
    const after = new Date('2026-10-20T00:00:00.000Z');

    expect(await cache.findEffectivePrices('m', before)).toEqual(
      await new CountingPriceRepository(versions).findEffectivePrices(
        'm',
        before,
      ),
    );
    expect(await cache.findEffectivePrices('m', exactly)).toEqual(
      await new CountingPriceRepository(versions).findEffectivePrices(
        'm',
        exactly,
      ),
    );
    expect(await cache.findEffectivePrices('m', after)).toEqual(
      await new CountingPriceRepository(versions).findEffectivePrices(
        'm',
        after,
      ),
    );
    // before is one interval; exactly and after share the next one.
    expect(inner.effectiveCalls).toHaveLength(2);
  });

  it('MUST keep models apart', async () => {
    const inner = new CountingPriceRepository(versions);
    const cache = new BatchPriceCache(inner);

    await cache.findEffectivePrices('m', OCT_15);
    await cache.findEffectivePrices('other', OCT_15);

    expect(inner.effectiveCalls.map((c) => c.model)).toEqual(['m', 'other']);
  });

  it('MUST share one in-flight query among concurrent callers of the same interval', async () => {
    const inner = new CountingPriceRepository(versions);
    const cache = new BatchPriceCache(inner);

    await Promise.all(
      Array.from({ length: 8 }, () =>
        cache.findEffectivePrices('m', new Date('2026-10-02T00:00:00Z')),
      ),
    );

    expect(inner.effectiveCalls).toHaveLength(1);
    expect(inner.listCalls).toBe(1);
  });

  it('MUST still answer for a model with no versions, through the repository', async () => {
    const inner = new CountingPriceRepository(versions);
    const cache = new BatchPriceCache(inner);

    expect(await cache.findEffectivePrices('unknown', OCT_15)).toEqual({
      input: undefined,
    });
    expect(inner.effectiveCalls).toHaveLength(1);
  });
});
