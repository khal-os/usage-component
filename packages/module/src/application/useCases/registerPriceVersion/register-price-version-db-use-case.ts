import {
  PriceVersionRepository,
  RegisterPriceVersionInput,
  RegisterPriceVersionUseCase,
  RegisteredPriceVersion,
  ReprocessPendingUseCase,
} from './register-price-version-protocols.js';
import {
  modelKey,
  parseModelRef,
} from '@observability/core/domain/models/model-ref.js';

/**
 * THE single registration path for a price version — the HTTP endpoint and
 * the runbook job (`npm run price:insert`) share it verbatim, so the two
 * doors cannot diverge on canonicalization or on the immediate reprocess
 * (same one-path rule as ingestSourceTrace).
 *
 * DuplicatePriceVersionError propagates untouched (invariant 9): callers
 * answer it their own way (HTTP 409 / CLI exit code).
 */
/** audit B-5: one page's worth of immediate stamping per HTTP registration. */
const HTTP_REPROCESS_CAP = 1_000;

export class RegisterPriceVersionDbUseCase implements RegisterPriceVersionUseCase {
  private readonly priceVersionRepository: PriceVersionRepository;
  private readonly reprocessPending: ReprocessPendingUseCase;

  constructor(args: {
    priceVersionRepository: PriceVersionRepository;
    reprocessPending: ReprocessPendingUseCase;
  }) {
    this.priceVersionRepository = args.priceVersionRepository;
    this.reprocessPending = args.reprocessPending;
  }

  async register(
    input: RegisterPriceVersionInput,
  ): Promise<RegisteredPriceVersion> {
    // Same canonical key the stamper looks up (decision 82): a price
    // registered under a bare id lands under `provider/id` and matches.
    const modelRef = parseModelRef(input.model);
    const canonicalModel = modelKey(modelRef);

    await this.priceVersionRepository.insertVersion({
      model: canonicalModel,
      tokenType: input.tokenType,
      // Registration declares a fixed R$ price; resolution dispatches on
      // this discriminator (decision 96 — future computed types plug in
      // with their own resolver, never by touching this path).
      pricingType: 'fixed_brl',
      priceMicrocentsPerMillion: input.priceMicrocentsPerMillion,
      effectiveFrom: input.effectiveFrom,
    });

    // Decision 57: stamp what the new price unblocks NOW; the worker's
    // periodic sweep stays as backstop. CAPPED (audit B-5): uncapped, a
    // day of an unpriced model's backlog (~33k traces) ran ~165k serial
    // Mongo ops inside this one HTTP request — minutes of wall time, and
    // a proxy timeout aborted the response while the loop kept running
    // (the retry then 409'd without re-running the sweep). The report's
    // pendingRemaining tells the operator what the backstop still owes.
    // TARGETED (decision 183): only this model's traces — an untargeted
    // capped run read the oldest page of the WHOLE queue, which could be
    // all other-model or model-less traces and stamp nothing (seen on
    // 2026-09-29: the sonnet-4-6 backlog was stamped by the worker, not here).
    const reprocess = await this.reprocessPending.reprocess({
      maxTraces: HTTP_REPROCESS_CAP,
      model: modelRef,
    });

    return {
      model: canonicalModel,
      tokenType: input.tokenType,
      priceMicrocentsPerMillion: input.priceMicrocentsPerMillion,
      effectiveFrom: input.effectiveFrom,
      reprocess,
    };
  }
}
