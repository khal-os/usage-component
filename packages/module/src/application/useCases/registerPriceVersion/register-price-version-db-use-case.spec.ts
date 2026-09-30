import { RegisterPriceVersionDbUseCase } from './register-price-version-db-use-case.js';
import {
  EffectivePrices,
  PriceVersionRepository,
  ReprocessOptions,
  ReprocessPendingUseCase,
  ReprocessReport,
} from './register-price-version-protocols.js';
import { PriceVersionModel } from '@observability/core/domain/models/price-version-model.js';
import { DuplicatePriceVersionError } from '@observability/core/domain/errors/duplicate-price-version-error.js';

const JUNE_1 = new Date('2026-06-01T00:00:00.000Z');

class PriceVersionRepositoryStub implements PriceVersionRepository {
  inserted: PriceVersionModel[] = [];

  async findEffectivePrices(): Promise<EffectivePrices> {
    return {};
  }

  async insertVersion(version: PriceVersionModel): Promise<void> {
    this.inserted.push(version);
  }

  async listAllVersions(): Promise<PriceVersionModel[]> {
    return [];
  }
}

class ReprocessPendingStub implements ReprocessPendingUseCase {
  calls = 0;
  lastOptions: ReprocessOptions | undefined;
  report: ReprocessReport = {
    examined: 3,
    stamped: 2,
    stillPending: 1,
    failed: 0,
    blockedClosedMonth: 0,
    pendingRemaining: 0,
  };

  async reprocess(options?: ReprocessOptions): Promise<ReprocessReport> {
    this.calls += 1;
    this.lastOptions = options;

    return this.report;
  }
}

const makeSut = () => {
  const priceVersionRepository = new PriceVersionRepositoryStub();
  const reprocessPending = new ReprocessPendingStub();
  const sut = new RegisterPriceVersionDbUseCase({
    priceVersionRepository,
    reprocessPending,
  });

  return { sut, priceVersionRepository, reprocessPending };
};

describe('RegisterPriceVersionDbUseCase', () => {
  it('MUST store the CANONICAL model key — a bare id lands under provider/id (decision 82)', async () => {
    const { sut, priceVersionRepository } = makeSut();

    const registered = await sut.register({
      model: 'gemini-2.5-pro',
      tokenType: 'input',
      priceMicrocentsPerMillion: 275_000_000,
      effectiveFrom: JUNE_1,
    });

    expect(priceVersionRepository.inserted[0]?.model).toBe(
      'google/gemini-2.5-pro',
    );
    expect(registered.model).toBe('google/gemini-2.5-pro');
  });

  it('MUST keep an already-canonical key unchanged (round-trip)', async () => {
    const { sut, priceVersionRepository } = makeSut();

    await sut.register({
      model: 'openai/gpt-5-mini',
      tokenType: 'output',
      priceMicrocentsPerMillion: 825_000_000,
      effectiveFrom: JUNE_1,
    });

    expect(priceVersionRepository.inserted[0]?.model).toBe('openai/gpt-5-mini');
  });

  it('MUST reprocess pending traces IMMEDIATELY after the insert (decision 57) and report it', async () => {
    const { sut, reprocessPending } = makeSut();

    const registered = await sut.register({
      model: 'openai/gpt-5-mini',
      tokenType: 'input',
      priceMicrocentsPerMillion: 275_000_000,
      effectiveFrom: JUNE_1,
    });

    expect(reprocessPending.calls).toBe(1);
    expect(registered.reprocess).toEqual({
      blockedClosedMonth: 0,
      examined: 3,
      stamped: 2,
      stillPending: 1,
      failed: 0,
      pendingRemaining: 0,
    });
  });

  it('decision 183: MUST target the reprocess at the registered model, canonicalized, keeping the HTTP cap', async () => {
    const { sut, reprocessPending } = makeSut();

    await sut.register({
      model: 'Claude-Sonnet-4-6',
      tokenType: 'input',
      priceMicrocentsPerMillion: 1_563_960_000,
      effectiveFrom: JUNE_1,
    });

    expect(reprocessPending.lastOptions).toEqual({
      maxTraces: 1_000,
      model: { id: 'claude-sonnet-4-6', provider: 'anthropic' },
    });
  });

  it('MUST always declare the fixed_brl pricing type on the inserted version (decision 96)', async () => {
    const { sut, priceVersionRepository } = makeSut();

    await sut.register({
      model: 'openai/gpt-5-mini',
      tokenType: 'input',
      priceMicrocentsPerMillion: 275_000_000,
      effectiveFrom: JUNE_1,
    });

    // Decision 96: registration always declares the fixed_brl type — the
    // resolution seam future computed pricing dispatches on.
    expect(priceVersionRepository.inserted[0]).toMatchObject({
      pricingType: 'fixed_brl',
    });
  });

  it('MUST propagate DuplicatePriceVersionError untouched and NOT reprocess', async () => {
    const { sut, priceVersionRepository, reprocessPending } = makeSut();

    jest.spyOn(priceVersionRepository, 'insertVersion').mockRejectedValueOnce(
      new DuplicatePriceVersionError({
        model: 'openai/gpt-5-mini',
        tokenType: 'input',
        effectiveFrom: JUNE_1,
      }),
    );

    await expect(
      sut.register({
        model: 'openai/gpt-5-mini',
        tokenType: 'input',
        priceMicrocentsPerMillion: 275_000_000,
        effectiveFrom: JUNE_1,
      }),
    ).rejects.toBeInstanceOf(DuplicatePriceVersionError);

    expect(reprocessPending.calls).toBe(0);
  });
});
