import { ToolDefinition } from '../tool-definition.js';
import {
  RecordingController,
  billRow,
  errorResponse,
  fakeCodec,
  fixedClock,
  okResponse,
  priceRow,
  TEST_CALLER,
} from '../mcp-test-fakes.js';
import { priceWriteTools } from './price-write-tools.js';

const NOW = '2026-09-11T12:00:00.000Z';

const makeTools = (
  options: {
    existing?: Record<string, unknown>[];
    bills?: Record<string, unknown>[];
    registerResponse?: ReturnType<typeof okResponse>;
    now?: string;
  } = {},
) => {
  const listPrices = new RecordingController(
    okResponse({ items: options.existing ?? [] }),
  );
  const listBills = new RecordingController(
    okResponse({ bills: options.bills ?? [billRow()] }),
  );
  const registerPrice = new RecordingController(
    options.registerResponse ??
      okResponse({ model: 'openai/gpt-5-mini', reprocess: { stamped: 3 } }),
  );
  const tools = priceWriteTools({
    listPrices,
    listBills,
    registerPrice,
    codec: fakeCodec(),
    clock: fixedClock(options.now ?? NOW),
  });
  const byName = (name: string): ToolDefinition =>
    tools.find((tool) => tool.name === name) as ToolDefinition;

  return {
    preview: byName('preview_register_price'),
    register: byName('register_price'),
    listPrices,
    listBills,
    registerPrice,
  };
};

const VALID_ARGS = {
  model: 'openai/gpt-5-mini',
  token_type: 'input',
  price_brl_per_million: '2.75',
  effective_from: '2026-06-15',
};

describe('preview_register_price (decisions 177/178)', () => {
  it('MUST write NOTHING and hand back a token bound to the request', async () => {
    const sut = makeTools();

    const outcome = await sut.preview.run(VALID_ARGS, TEST_CALLER);

    expect(outcome.ok).toBe(true);
    expect(sut.registerPrice.requests).toEqual([]);

    const structured = outcome.ok ? outcome.value.structured : {};
    expect(structured['writes_nothing']).toBe(true);
    expect(structured['canonical_model']).toBe('openai/gpt-5-mini');
    expect(String(structured['confirmation_token']).length).toBeGreaterThan(0);
    expect(structured['expires_at']).toBe('2026-09-11T12:10:00.000Z');
  });

  it('MUST show the CANONICAL key a bare model id will be stored under', async () => {
    const sut = makeTools();

    const outcome = await sut.preview.run(
      { ...VALID_ARGS, model: 'GPT-5-mini' },
      TEST_CALLER,
    );

    expect(outcome.ok && outcome.value.structured['canonical_model']).toBe(
      'openai/gpt-5-mini',
    );
    // The existing-versions lookup uses the canonical key, not what was typed.
    expect(sut.listPrices.requests[0]?.query).toEqual({
      model: 'openai/gpt-5-mini',
      token_type: 'input',
    });
  });

  it('MUST refuse a duplicate version instead of minting a token that would 409', async () => {
    const sut = makeTools({
      existing: [priceRow({ effective_from: '2026-06-15T00:00:00.000Z' })],
    });

    const outcome = await sut.preview.run(VALID_ARGS, TEST_CALLER);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? undefined : outcome.error.code).toBe('CONFLICT');
  });

  it('MUST warn when the date falls in a CLOSED month (a closed month is never re-priced)', async () => {
    const sut = makeTools({
      bills: [billRow({ period_status: 'closed', snapshot_version: 1 })],
    });

    const outcome = await sut.preview.run(VALID_ARGS, TEST_CALLER);

    const warnings = outcome.ok
      ? (outcome.value.structured['warnings'] as string[])
      : [];
    expect(warnings.join(' ')).toContain('CLOSED');
  });

  it('MUST say when nothing is priced yet for that model and token type', async () => {
    const sut = makeTools();

    const outcome = await sut.preview.run(VALID_ARGS, TEST_CALLER);

    const warnings = outcome.ok
      ? (outcome.value.structured['warnings'] as string[])
      : [];
    expect(warnings.join(' ')).toContain('No price exists yet');
  });

  it.each([
    ['a zero price', { price_brl_per_million: '0' }, 'price_brl_per_million'],
    [
      'a number-shaped price',
      { price_brl_per_million: 2.75 },
      'price_brl_per_million',
    ],
    [
      'a timezone-less datetime',
      { effective_from: '2026-06-01T00:00:00' },
      'effective_from',
    ],
    ['an unknown token type', { token_type: 'embedding' }, 'token_type'],
  ])(
    'MUST refuse %s at the same border POST /prices uses',
    async (_case, override, field) => {
      const sut = makeTools();

      const outcome = await sut.preview.run(
        { ...VALID_ARGS, ...override },
        TEST_CALLER,
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? '' : outcome.error.code).toBe('INVALID_INPUT');
      expect(outcome.ok ? '' : outcome.error.message).toContain(field);
    },
  );
});

describe('register_price (the confirming half)', () => {
  const tokenFor = async (
    sut: ReturnType<typeof makeTools>,
    args: Record<string, unknown> = VALID_ARGS,
  ): Promise<string> => {
    const preview = await sut.preview.run(args, TEST_CALLER);

    return String(
      preview.ok ? preview.value.structured['confirmation_token'] : '',
    );
  };

  it('MUST refuse with no token and NOT touch the store', async () => {
    const sut = makeTools();

    const outcome = await sut.register.run(VALID_ARGS, TEST_CALLER);

    expect(outcome.ok ? '' : outcome.error.code).toBe('CONFIRMATION_MISSING');
    expect(sut.registerPrice.requests).toEqual([]);
  });

  it('MUST register through the SAME controller POST /prices uses, body verbatim', async () => {
    const sut = makeTools();
    const confirmation_token = await tokenFor(sut);

    const outcome = await sut.register.run(
      { ...VALID_ARGS, confirmation_token },
      TEST_CALLER,
    );

    expect(outcome.ok).toBe(true);
    expect(sut.registerPrice.requests).toEqual([
      { body: VALID_ARGS, query: {} },
    ]);
    expect(outcome.ok && outcome.value.structured['reprocess']).toEqual({
      stamped: 3,
    });
  });

  it('MUST refuse a token whose preview showed a DIFFERENT price, naming the drift', async () => {
    const sut = makeTools();
    const confirmation_token = await tokenFor(sut);

    const outcome = await sut.register.run(
      { ...VALID_ARGS, price_brl_per_million: '9.99', confirmation_token },
      TEST_CALLER,
    );

    expect(outcome.ok ? '' : outcome.error.code).toBe('CONFIRMATION_MISMATCH');
    expect(outcome.ok ? [] : outcome.error.details?.['fields']).toEqual([
      'hash',
    ]);
    expect(sut.registerPrice.requests).toEqual([]);
  });

  it('MUST refuse a token issued to another user (a token is not transferable)', async () => {
    const sut = makeTools();
    const confirmation_token = await tokenFor(sut);

    const outcome = await sut.register.run(
      { ...VALID_ARGS, confirmation_token },
      { subject: 'user_99', tenant: TEST_CALLER.tenant },
    );

    expect(outcome.ok ? '' : outcome.error.code).toBe('CONFIRMATION_MISMATCH');
    expect(sut.registerPrice.requests).toEqual([]);
  });

  it('MUST refuse a token past its window', async () => {
    const minted = makeTools();
    const confirmation_token = await tokenFor(minted);
    // Same key, a later clock: eleven minutes after the preview.
    const later = makeTools({ now: '2026-09-11T12:11:00.000Z' });

    const outcome = await later.register.run(
      { ...VALID_ARGS, confirmation_token },
      TEST_CALLER,
    );

    expect(outcome.ok ? '' : outcome.error.code).toBe('CONFIRMATION_EXPIRED');
    expect(later.registerPrice.requests).toEqual([]);
  });

  it('MUST surface a 409 from the store as CONFLICT', async () => {
    const sut = makeTools({
      registerResponse: errorResponse(409, 'ConflictError', 'already exists'),
    });
    const confirmation_token = await tokenFor(sut);

    const outcome = await sut.register.run(
      { ...VALID_ARGS, confirmation_token },
      TEST_CALLER,
    );

    expect(outcome.ok ? '' : outcome.error.code).toBe('CONFLICT');
  });
});
