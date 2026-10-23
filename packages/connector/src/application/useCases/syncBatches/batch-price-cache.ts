import {
  EffectivePrices,
  PriceVersionRepository,
} from '@observability/core/application/interfaces/price-version-repository.js';
import {
  PriceVersionModel,
  TokenType,
} from '@observability/core/domain/models/price-version-model.js';

/**
 * A per-batch read-through cache over findEffectivePrices (issue #102).
 *
 * The effective prices of a model at instant `at` depend only on WHICH
 * versions of that model have effectiveFrom <= at. So the model's distinct
 * effectiveFrom instants cut time into intervals, and every trace inside one
 * interval gets the same answer. The cache loads each model's version dates
 * once, maps a trace date to its interval, and asks the real repository once
 * per interval, which keeps the repository's own resolution rules (latest per
 * token type, resolvable versions only) instead of re-implementing them.
 *
 * Built fresh for every batch: a price registered between batches is seen by
 * the next batch, exactly as before. Concurrent callers share the in-flight
 * promise, so lanes asking for the same interval cause one query, not many.
 */
export class BatchPriceCache implements PriceVersionRepository {
  private readonly inner: PriceVersionRepository;
  private readonly boundaries = new Map<string, Promise<number[]>>();
  private readonly prices = new Map<string, Promise<EffectivePrices>>();

  constructor(inner: PriceVersionRepository) {
    this.inner = inner;
  }

  async findEffectivePrices(
    model: string,
    atDate: Date,
  ): Promise<EffectivePrices> {
    const boundaries = await this.boundariesOf(model);
    const at = atDate.getTime();
    // How many version instants are already in effect at `at`: the interval.
    let interval = 0;

    while (interval < boundaries.length && boundaries[interval]! <= at) {
      interval += 1;
    }

    const key = `${model}\u0000${interval}`;
    let pending = this.prices.get(key);

    if (!pending) {
      pending = this.inner.findEffectivePrices(model, atDate);
      this.prices.set(key, pending);
    }

    return pending;
  }

  insertVersion(version: PriceVersionModel): Promise<void> {
    return this.inner.insertVersion(version);
  }

  listAllVersions(filter?: {
    model?: string;
    tokenType?: TokenType;
  }): Promise<PriceVersionModel[]> {
    return this.inner.listAllVersions(filter);
  }

  private boundariesOf(model: string): Promise<number[]> {
    let pending = this.boundaries.get(model);

    if (!pending) {
      pending = this.inner
        .listAllVersions({ model })
        .then((versions) =>
          [...new Set(versions.map((v) => v.effectiveFrom.getTime()))].sort(
            (a, b) => a - b,
          ),
        );
      this.boundaries.set(model, pending);
    }

    return pending;
  }
}
