import {
  BillingCloseBlockedError,
  BillingPeriodStateError,
  CloseBillingPeriodResult,
  CloseBillingPeriodUseCase,
} from '@observability/core/domain/useCases/close-billing-period-use-case.js';
import {
  ReopenBillingPeriodResult,
  ReopenBillingPeriodUseCase,
} from '@observability/core/domain/useCases/reopen-billing-period-use-case.js';
import { ToolDefinition } from '../tool-definition.js';
import {
  RecordingController,
  billRow,
  fakeCodec,
  fixedClock,
  okResponse,
  TEST_CALLER,
} from '../mcp-test-fakes.js';
import { billingLifecycleTools } from './billing-lifecycle-tools.js';

// The clock sits in September, so 2026-06 is a fully past month and 2026-09
// is the current one (client timezone — decision 130).
const NOW = '2026-09-11T12:00:00.000Z';

const CLOSE_RESULT: CloseBillingPeriodResult = {
  year: 2026,
  month: 6,
  snapshotVersion: 1,
  totalCostMicrocents: 1_000_000_000,
  totalDisplayCents: 1_000,
  stampedTraceCount: 5,
  ingestionWatermark: new Date('2026-07-01T00:00:00.000Z'),
  quarantine: { flaggedStragglers: 0, absorbed: 0 },
};

class FakeClose implements CloseBillingPeriodUseCase {
  readonly calls: { year: number; month: number; actor: string }[] = [];

  constructor(
    private readonly actor: string,
    private readonly outcome: CloseBillingPeriodResult | Error = CLOSE_RESULT,
  ) {}

  async close(year: number, month: number): Promise<CloseBillingPeriodResult> {
    this.calls.push({ year, month, actor: this.actor });

    if (this.outcome instanceof Error) throw this.outcome;

    return this.outcome;
  }
}

class FakeReopen implements ReopenBillingPeriodUseCase {
  readonly calls: {
    year: number;
    month: number;
    reason: string;
    actor: string;
  }[] = [];

  constructor(
    private readonly actor: string,
    private readonly outcome: ReopenBillingPeriodResult | Error = {
      year: 2026,
      month: 6,
      previousSnapshotVersion: 1,
    },
  ) {}

  async reopen(
    year: number,
    month: number,
    reason: string,
  ): Promise<ReopenBillingPeriodResult> {
    this.calls.push({ year, month, reason, actor: this.actor });

    if (this.outcome instanceof Error) throw this.outcome;

    return this.outcome;
  }
}

const makeTools = (
  options: {
    bills?: Record<string, unknown>[];
    billsAfterPreview?: Record<string, unknown>[];
    pendingModels?: string[];
    closeOutcome?: CloseBillingPeriodResult | Error;
    reopenOutcome?: ReopenBillingPeriodResult | Error;
    now?: string;
  } = {},
) => {
  const bills = options.bills ?? [billRow({ period_status: 'open' })];
  const listBills = new RecordingController(
    ...(options.billsAfterPreview
      ? [
          okResponse({ bills }),
          okResponse({ bills: options.billsAfterPreview }),
        ]
      : [okResponse({ bills })]),
  );
  const billingSummary = new RecordingController(
    okResponse({ pending_price: { models: options.pendingModels ?? [] } }),
  );
  const closes: FakeClose[] = [];
  const reopens: FakeReopen[] = [];
  const tools = billingLifecycleTools({
    listBills,
    billingSummary,
    closeForActor: (actor) => {
      const use = new FakeClose(actor, options.closeOutcome);
      closes.push(use);
      return use;
    },
    reopenForActor: (actor) => {
      const use = new FakeReopen(actor, options.reopenOutcome);
      reopens.push(use);
      return use;
    },
    codec: fakeCodec(),
    clock: fixedClock(options.now ?? NOW),
  });
  const byName = (name: string): ToolDefinition =>
    tools.find((tool) => tool.name === name) as ToolDefinition;

  return {
    previewClose: byName('preview_close_billing_period'),
    close: byName('close_billing_period'),
    previewReopen: byName('preview_reopen_billing_period'),
    reopen: byName('reopen_billing_period'),
    listBills,
    closes,
    reopens,
  };
};

const structuredOf = (outcome: Awaited<ReturnType<ToolDefinition['run']>>) =>
  outcome.ok ? outcome.value.structured : {};

const JUNE = { year: 2026, month: 6 };

describe('preview_close_billing_period (decision 179)', () => {
  it('MUST allow a clean past month and mint a token bound to its state', async () => {
    const sut = makeTools();

    const outcome = await sut.previewClose.run(JUNE, TEST_CALLER);
    const structured = structuredOf(outcome);

    expect(structured['can_close']).toBe(true);
    expect(structured['blockers']).toEqual([]);
    expect(structured['writes_nothing']).toBe(true);
    expect(String(structured['confirmation_token']).length).toBeGreaterThan(0);
    expect(sut.closes).toEqual([]);
  });

  it('MUST refuse to mint a token for a month that cannot close', async () => {
    const sut = makeTools({
      bills: [billRow({ period_status: 'closed', snapshot_version: 2 })],
    });

    const structured = structuredOf(
      await sut.previewClose.run(JUNE, TEST_CALLER),
    );

    expect(structured['can_close']).toBe(false);
    expect(structured['confirmation_token']).toBeNull();
    expect(String(structured['blockers'])).toContain('already closed');
  });

  it('MUST refuse a month BEFORE the archive begins (no row, so every other blocker skips)', async () => {
    const sut = makeTools({ bills: [billRow({ year: 2026, month: 6 })] });

    const structured = structuredOf(
      await sut.previewClose.run({ year: 2019, month: 3 }, TEST_CALLER),
    );

    expect(structured['can_close']).toBe(false);
    expect(structured['confirmation_token']).toBeNull();
    expect(String(structured['blockers'])).toContain('no data before');
    expect(structured['period']).toMatchObject({
      period_status: 'absent',
      total_cost_brl_display: 'R$ 0,00',
    });
  });

  it('MUST still allow a GAP month inside the archive — closing it is how the bound advances', async () => {
    const sut = makeTools({
      bills: [
        billRow({
          year: 2026,
          month: 4,
          period_status: 'closed',
          snapshot_version: 1,
        }),
        billRow({
          year: 2026,
          month: 6,
          period_status: 'closed',
          snapshot_version: 1,
        }),
      ],
    });

    const structured = structuredOf(
      await sut.previewClose.run({ year: 2026, month: 5 }, TEST_CALLER),
    );

    expect(structured['can_close']).toBe(true);
    expect(String(structured['confirmation_token']).length).toBeGreaterThan(0);
  });

  it('MUST block the CURRENT month — a month still running is partial by definition', async () => {
    const sut = makeTools({
      bills: [billRow({ year: 2026, month: 9, period_status: 'in_progress' })],
    });

    const structured = structuredOf(
      await sut.previewClose.run({ year: 2026, month: 9 }, TEST_CALLER),
    );

    expect(structured['can_close']).toBe(false);
    expect(String(structured['blockers'])).toContain('has not ended');
  });

  it('MUST block an older OPEN month even when its executions are neither stamped nor pending', async () => {
    // decision 128: an execution with a model and zero measured tokens is
    // `no_measured_usage` — counted in NEITHER total, so a count-based test
    // called this month trace-free and promised a close that would be refused.
    const sut = makeTools({
      bills: [
        billRow({
          year: 2026,
          month: 5,
          period_status: 'open',
          stamped_trace_count: 0,
          pending_trace_count: 0,
        }),
        billRow({ year: 2026, month: 6, period_status: 'open' }),
      ],
    });

    const structured = structuredOf(
      await sut.previewClose.run(JUNE, TEST_CALLER),
    );

    expect(structured['can_close']).toBe(false);
    expect(String(structured['blockers'])).toContain('2026-05');
    expect(structured['confirmation_token']).toBeNull();
  });

  it('MUST block when an OLDER month with executions was never closed (oldest first)', async () => {
    const sut = makeTools({
      bills: [
        billRow({
          year: 2026,
          month: 5,
          period_status: 'open',
          stamped_trace_count: 3,
        }),
        billRow({ year: 2026, month: 6, period_status: 'open' }),
      ],
    });

    const structured = structuredOf(
      await sut.previewClose.run(JUNE, TEST_CALLER),
    );

    expect(structured['can_close']).toBe(false);
    expect(String(structured['blockers'])).toContain('2026-05');
  });

  it('MUST block on executions waiting for a price and name the models that lack one', async () => {
    const sut = makeTools({
      bills: [billRow({ period_status: 'open', pending_trace_count: 4 })],
      pendingModels: ['anthropic/claude-sonnet-5'],
    });

    const structured = structuredOf(
      await sut.previewClose.run(JUNE, TEST_CALLER),
    );

    expect(structured['can_close']).toBe(false);
    expect(structured['models_without_price']).toEqual([
      'anthropic/claude-sonnet-5',
    ]);
  });
});

describe('close_billing_period (the confirming half)', () => {
  const tokenFrom = async (
    sut: ReturnType<typeof makeTools>,
  ): Promise<string> =>
    String(
      structuredOf(await sut.previewClose.run(JUNE, TEST_CALLER))[
        'confirmation_token'
      ],
    );

  it('MUST refuse without a token and NEVER reach the use case', async () => {
    const sut = makeTools();

    const outcome = await sut.close.run(JUNE, TEST_CALLER);

    expect(outcome.ok ? '' : outcome.error.code).toBe('CONFIRMATION_MISSING');
    expect(sut.closes).toEqual([]);
  });

  it('MUST close through the use case composed with the CALLER as actor', async () => {
    const sut = makeTools();
    const confirmation_token = await tokenFrom(sut);

    const outcome = await sut.close.run(
      { ...JUNE, confirmation_token },
      TEST_CALLER,
    );
    const structured = structuredOf(outcome);

    expect(sut.closes[0]?.calls).toEqual([
      { year: 2026, month: 6, actor: TEST_CALLER.subject },
    ]);
    expect(structured['trigger']).toBe('mcp');
    expect(structured['actor']).toBe(TEST_CALLER.subject);
    expect(structured['snapshot_version']).toBe(1);
    expect(structured['total_cost_brl_display']).toBe('R$ 10,00');
  });

  it('MUST refuse when the month CHANGED after the preview (someone else closed it)', async () => {
    const sut = makeTools({
      bills: [billRow({ period_status: 'open' })],
      billsAfterPreview: [
        billRow({ period_status: 'closed', snapshot_version: 1 }),
      ],
    });
    const confirmation_token = await tokenFrom(sut);

    const outcome = await sut.close.run(
      { ...JUNE, confirmation_token },
      TEST_CALLER,
    );

    expect(outcome.ok ? '' : outcome.error.code).toBe('STALE_PERIOD');
    expect(outcome.ok ? {} : outcome.error.details?.['current']).toMatchObject({
      period_status: 'closed',
    });
    expect(sut.closes).toEqual([]);
  });

  it('MUST refuse a token after a close→REOPEN cycle, which leaves the state string identical', async () => {
    // /bills reports snapshot_version only while a month is CLOSED, so a
    // reopened month reads `open` with no version again — a state-only stamp
    // would let this stale token through. The numbers in the stamp catch it.
    const sut = makeTools({
      bills: [billRow({ period_status: 'open' })],
      billsAfterPreview: [
        billRow({ period_status: 'open', stamped_trace_count: 9 }),
      ],
    });
    const confirmation_token = await tokenFrom(sut);

    const outcome = await sut.close.run(
      { ...JUNE, confirmation_token },
      TEST_CALLER,
    );

    expect(outcome.ok ? '' : outcome.error.code).toBe('STALE_PERIOD');
    expect(sut.closes).toEqual([]);
  });

  it('MUST report a blocked close as BLOCKED with what is missing', async () => {
    const sut = makeTools({
      closeOutcome: new BillingCloseBlockedError({
        pendingTraceCount: 2,
        modelsWithoutPrice: ['openai/gpt-5-mini'],
      }),
    });
    const confirmation_token = await tokenFrom(sut);

    const outcome = await sut.close.run(
      { ...JUNE, confirmation_token },
      TEST_CALLER,
    );

    expect(outcome.ok ? '' : outcome.error.code).toBe('BLOCKED');
    expect(outcome.ok ? {} : outcome.error.details).toEqual({
      pending_trace_count: 2,
      models_without_price: ['openai/gpt-5-mini'],
    });
  });

  it('MUST report a period-state refusal as INVALID_STATE', async () => {
    const sut = makeTools({
      closeOutcome: new BillingPeriodStateError('já está fechado'),
    });
    const confirmation_token = await tokenFrom(sut);

    const outcome = await sut.close.run(
      { ...JUNE, confirmation_token },
      TEST_CALLER,
    );

    expect(outcome.ok ? '' : outcome.error.code).toBe('INVALID_STATE');
  });
});

describe('reopen (audited, the exception)', () => {
  const closedBills = [
    billRow({ period_status: 'closed', snapshot_version: 1 }),
  ];
  const REASON = 'correção de atribuição do agente X';

  it('MUST block a reopen of a month that is not closed', async () => {
    const sut = makeTools();

    const structured = structuredOf(
      await sut.previewReopen.run({ ...JUNE, reason: REASON }, TEST_CALLER),
    );

    expect(structured['can_reopen']).toBe(false);
    expect(structured['confirmation_token']).toBeNull();
  });

  it('MUST preview a closed month, warning that the frozen bill stops being current', async () => {
    const sut = makeTools({ bills: closedBills });

    const structured = structuredOf(
      await sut.previewReopen.run({ ...JUNE, reason: REASON }, TEST_CALLER),
    );

    expect(structured['can_reopen']).toBe(true);
    expect(String(structured['warnings'])).toContain('v1 is preserved');
    expect(sut.reopens).toEqual([]);
  });

  it('MUST reopen with the reason, the caller as actor, and report the next version', async () => {
    const sut = makeTools({ bills: closedBills });
    const confirmation_token = String(
      structuredOf(
        await sut.previewReopen.run({ ...JUNE, reason: REASON }, TEST_CALLER),
      )['confirmation_token'],
    );

    const structured = structuredOf(
      await sut.reopen.run(
        { ...JUNE, reason: REASON, confirmation_token },
        TEST_CALLER,
      ),
    );

    expect(sut.reopens[0]?.calls).toEqual([
      { year: 2026, month: 6, reason: REASON, actor: TEST_CALLER.subject },
    ]);
    expect(structured['previous_snapshot_version']).toBe(1);
    expect(structured['next_snapshot_version']).toBe(2);
    expect(structured['trigger']).toBe('mcp');
  });

  it('MUST refuse a token when the REASON changed — the person approved that text', async () => {
    const sut = makeTools({ bills: closedBills });
    const confirmation_token = String(
      structuredOf(
        await sut.previewReopen.run({ ...JUNE, reason: REASON }, TEST_CALLER),
      )['confirmation_token'],
    );

    const outcome = await sut.reopen.run(
      { ...JUNE, reason: 'outro motivo qualquer', confirmation_token },
      TEST_CALLER,
    );

    expect(outcome.ok ? '' : outcome.error.code).toBe('CONFIRMATION_MISMATCH');
    expect(outcome.ok ? [] : outcome.error.details?.['fields']).toEqual([
      'hash',
    ]);
    expect(sut.reopens).toEqual([]);
  });
});
