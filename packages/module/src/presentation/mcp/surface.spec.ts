import { CloseBillingPeriodUseCase } from '@observability/core/domain/useCases/close-billing-period-use-case.js';
import { ReopenBillingPeriodUseCase } from '@observability/core/domain/useCases/reopen-billing-period-use-case.js';
import { SERVER_INSTRUCTIONS, buildMcpSurface } from './surface.js';
import {
  RecordingController,
  fakeCodec,
  fixedClock,
  okResponse,
} from './mcp-test-fakes.js';

const controller = () => new RecordingController(okResponse({}));
const never = (): never => {
  throw new Error('not used in this suite');
};

const surface = buildMcpSurface({
  identity: {
    clientName: 'acme',
    clientTimezone: 'America/Sao_Paulo',
    tenant: 'acme',
  },
  traces: {
    listTraces: controller(),
    traceFilterOptions: controller(),
    traceDetail: controller(),
  },
  sessions: {
    listSessions: controller(),
    sessionFilterOptions: controller(),
    sessionDetail: controller(),
  },
  billing: {
    listBills: controller(),
    billingSummary: controller(),
    billingSeries: controller(),
    billingProjection: controller(),
    statement: controller(),
  },
  prices: { listPrices: controller() },
  overview: {
    listBills: controller(),
    billingProjection: controller(),
    listPrices: controller(),
  },
  priceWrites: {
    listPrices: controller(),
    listBills: controller(),
    registerPrice: controller(),
    codec: fakeCodec(),
    clock: fixedClock('2026-09-11T12:00:00.000Z'),
  },
  lifecycle: {
    listBills: controller(),
    billingSummary: controller(),
    closeForActor: () => never() as unknown as CloseBillingPeriodUseCase,
    reopenForActor: () => never() as unknown as ReopenBillingPeriodUseCase,
    codec: fakeCodec(),
    clock: fixedClock('2026-09-11T12:00:00.000Z'),
  },
  resources: {
    openApiJson: () => '{}',
    listBills: controller(),
    listPrices: controller(),
  },
});

const names = surface.tools.map((tool) => tool.name);
const byName = (name: string) =>
  surface.tools.find((tool) => tool.name === name);

describe('the MCP surface (T12 inventory)', () => {
  it('MUST expose exactly the published tool list', () => {
    expect([...names].sort()).toEqual([
      'close_billing_period',
      'export_statement',
      'get_billing_projection',
      'get_billing_series',
      'get_billing_summary',
      'get_overview',
      'get_session',
      'get_session_filter_options',
      'get_trace',
      'get_trace_filter_options',
      'list_bills',
      'list_prices',
      'list_sessions',
      'list_traces',
      'preview_close_billing_period',
      'preview_register_price',
      'preview_reopen_billing_period',
      'register_price',
      'reopen_billing_period',
    ]);
  });

  it('MUST name every tool in snake_case and never twice', () => {
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => !/^[a-z][a-z0-9_]*$/.test(name))).toEqual([]);
  });

  it('MUST describe and title every tool (this text is the whole contract for a model)', () => {
    for (const tool of surface.tools) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });

  it('MUST pair every confirming write with a preview and nothing else', () => {
    const previews = names.filter((name) => name.startsWith('preview_'));
    const confirmations = names.filter(
      (name) => byName(name)?.annotations.readOnlyHint === false,
    );

    expect([...previews].sort()).toEqual(
      [...confirmations.map((name) => `preview_${name}`)].sort(),
    );
  });

  it('MUST mark reads read-only and idempotent', () => {
    const reads = surface.tools.filter(
      (tool) =>
        !tool.name.startsWith('preview_') && tool.annotations.readOnlyHint,
    );

    expect(reads.length).toBe(13);
    for (const tool of reads) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
      });
    }
  });

  it('MUST mark a preview read-only but NOT idempotent (each one mints a new token)', () => {
    for (const tool of surface.tools.filter((candidate) =>
      candidate.name.startsWith('preview_'),
    )) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        idempotentHint: false,
        destructiveHint: false,
      });
    }
  });

  it('MUST flag ONLY the reopen as destructive — it rewrites a bill that was final', () => {
    expect(
      names.filter((name) => byName(name)?.annotations.destructiveHint),
    ).toEqual(['reopen_billing_period']);
  });

  it('MUST require a confirmation_token on every confirming write', () => {
    for (const tool of surface.tools.filter(
      (candidate) => !candidate.annotations.readOnlyHint,
    )) {
      expect(Object.keys(tool.inputSchema)).toContain('confirmation_token');
    }
  });

  it('MUST NOT take a confirmation_token on anything that is not a confirming write', () => {
    for (const tool of surface.tools.filter(
      (candidate) => candidate.annotations.readOnlyHint,
    )) {
      expect(Object.keys(tool.inputSchema)).not.toContain('confirmation_token');
    }
  });
});

describe('prompts and resources', () => {
  it('MUST expose the four playbooks', () => {
    expect(surface.prompts.map((prompt) => prompt.name).sort()).toEqual([
      'close-month',
      'explain-bill',
      'find-cost-driver',
      'register-price',
    ]);
  });

  it('MUST build a prompt body that carries the money rules and the write rule', () => {
    const closeMonth = surface.prompts.find(
      (prompt) => prompt.name === 'close-month',
    );

    const text = closeMonth?.build({ year: '2026', month: '6' }) ?? '';

    expect(text).toContain('2026-6');
    expect(text).toContain('preview');
    expect(text).toContain('pending_price');
  });

  it('MUST expose reference resources under one scheme', () => {
    expect(surface.resources.map((resource) => resource.uri).sort()).toEqual([
      'usage://bills',
      'usage://openapi.json',
      'usage://prices',
    ]);
  });

  it('MUST read a resource as text (the openapi document comes from the deployment)', async () => {
    const openapi = surface.resources.find(
      (resource) => resource.uri === 'usage://openapi.json',
    );

    await expect(openapi?.read()).resolves.toBe('{}');
  });
});

describe('server instructions', () => {
  it('MUST state the invariants a schema cannot carry', () => {
    expect(SERVER_INSTRUCTIONS).toContain('R$');
    expect(SERVER_INSTRUCTIONS).toContain('pending_price');
    expect(SERVER_INSTRUCTIONS).toContain('never changes');
    expect(SERVER_INSTRUCTIONS).toContain('partial');
  });

  it('MUST put the approval in the PERSON hands, not the model', () => {
    expect(SERVER_INSTRUCTIONS).toContain('explicit approval');
    expect(SERVER_INSTRUCTIONS).toContain('has not seen');
  });

  it('MUST stay vendor-blind (the package-wide rule applies to prose too)', () => {
    // The forbidden words are assembled, never written: this file lives in
    // the package the vendor-blind boundary spec scans, and spelling them
    // here would make THIS suite the violation it exists to prevent.
    const forbidden = new RegExp(
      [['lang', 'watch'].join(''), ['click', 'house'].join('')].join('|'),
    );

    expect(SERVER_INSTRUCTIONS.toLowerCase()).not.toMatch(forbidden);
  });
});
