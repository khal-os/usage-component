import { z } from 'zod';
import { toQuery } from '../query-args.js';
import { ToolDefinition } from '../tool-definition.js';
import { RecordingController, okResponse } from '../mcp-test-fakes.js';
import { BILLING_QUERY_SHAPES, billingTools } from './billing-tools.js';
import { PRICE_QUERY_SHAPES, priceReadTools } from './prices-tools.js';
import { SESSION_QUERY_SHAPES, sessionTools } from './sessions-tools.js';
import { TRACE_QUERY_SHAPES, traceTools } from './traces-tools.js';

/**
 * THE drift guard between the two doors (decision 175). MCP arguments are
 * typed JSON; the controllers are the HTTP door's controllers and validate
 * query STRINGS with strict schemas. This suite proves, tool by tool, that
 * what a tool advertises is exactly what its controller accepts:
 *
 *  - every argument a tool declares survives `toQuery` and parses against
 *    the controller's own schema (so no tool can advertise a parameter the
 *    controller would answer 400 to), and
 *  - no tool declares a parameter the controller does not know.
 *
 * Add a filter to an endpoint and forget the tool: the keys diverge and
 * this suite says which one.
 */
const controller = () => new RecordingController(okResponse({}));

const allTools: ToolDefinition[] = [
  ...traceTools({
    listTraces: controller(),
    traceFilterOptions: controller(),
    traceDetail: controller(),
  }),
  ...sessionTools({
    listSessions: controller(),
    sessionFilterOptions: controller(),
    sessionDetail: controller(),
  }),
  ...billingTools({
    listBills: controller(),
    billingSummary: controller(),
    billingSeries: controller(),
    billingProjection: controller(),
    statement: controller(),
  }),
  ...priceReadTools({ listPrices: controller() }),
];

const QUERY_SHAPES: Record<string, z.ZodRawShape> = {
  ...TRACE_QUERY_SHAPES,
  ...SESSION_QUERY_SHAPES,
  ...BILLING_QUERY_SHAPES,
  ...PRICE_QUERY_SHAPES,
};

/**
 * Detail tools address a resource by PATH, not by query (`GET /traces/:id`):
 * their `id` argument must travel as a path param and leave the query empty,
 * which is what the controller's empty strict schema demands.
 */
const PATH_ARGS: Record<string, readonly string[]> = {
  get_trace: ['id'],
  get_session: ['id'],
};

/** One fully-populated example per tool — every argument at once. */
const FULL_ARGS: Record<string, Record<string, unknown>> = {
  list_traces: {
    from: '2026-06-01',
    to: '2026-07-01',
    agent: ['agent-atendimento', 'agent-cobranca'],
    status: 'error',
    type: ['chat'],
    channel: ['whatsapp'],
    domain: ['varejo'],
    subdomain: ['sp'],
    search: 'trace-001',
    quarantined: true,
    page: 2,
    page_size: 50,
  },
  get_trace_filter_options: {
    from: '2026-06-01T00:00:00Z',
    to: '2026-07-01T00:00:00Z',
    agent: ['agent-atendimento'],
    status: 'ok',
    type: ['chat'],
    channel: ['web'],
    domain: ['varejo'],
    subdomain: ['sp'],
    search: 'sess-001',
    quarantined: false,
  },
  get_trace: {},
  list_sessions: {
    from: '2026-06-01',
    to: '2026-07-01',
    agent: 'agent-atendimento',
    status: 'error',
    page: 3,
    page_size: 10,
  },
  get_session_filter_options: {
    from: '2026-06-01',
    to: '2026-07-01',
    agent: 'agent-atendimento',
    status: 'ok',
  },
  get_session: {},
  list_bills: {},
  get_billing_summary: { year: 2026, month: 6 },
  get_billing_series: { granularity: 'day', months: 12, days: 30 },
  get_billing_projection: {},
  export_statement: { year: 2026, month: 6, format: 'html' },
  list_prices: { model: 'openai/gpt-5-mini', token_type: 'input' },
};

describe('MCP tool arguments vs the HTTP query contract', () => {
  it('covers every read tool that maps arguments to a query', () => {
    expect(Object.keys(QUERY_SHAPES).sort()).toEqual(
      Object.keys(FULL_ARGS).sort(),
    );
  });

  for (const tool of allTools) {
    const shape = QUERY_SHAPES[tool.name];
    const args = FULL_ARGS[tool.name];

    if (!shape || !args) continue;

    describe(tool.name, () => {
      it('MUST declare only parameters the controller knows', () => {
        const pathArgs = PATH_ARGS[tool.name] ?? [];
        const unknown = Object.keys(tool.inputSchema).filter(
          (key) => !(key in shape) && !pathArgs.includes(key),
        );

        expect(unknown).toEqual([]);
      });

      it('MUST produce a query the controller ACCEPTS with every argument set', () => {
        const parsed = z.strictObject(shape).safeParse(toQuery(args));

        expect(parsed.error?.issues ?? []).toEqual([]);
        expect(parsed.success).toBe(true);
      });

      it('MUST declare every argument the example exercises', () => {
        const missing = Object.keys(args).filter(
          (key) => !(key in tool.inputSchema),
        );

        expect(missing).toEqual([]);
      });
    });
  }

  describe.each(Object.keys(PATH_ARGS))('%s (path-addressed)', (name) => {
    it('MUST send the id as a path param and an EMPTY query', async () => {
      const recorder = new RecordingController(okResponse({ ok: true }));
      const tools = [
        ...traceTools({
          listTraces: controller(),
          traceFilterOptions: controller(),
          traceDetail: recorder,
        }),
        ...sessionTools({
          listSessions: controller(),
          sessionFilterOptions: controller(),
          sessionDetail: recorder,
        }),
      ];
      const tool = tools.find((candidate) => candidate.name === name);

      await tool?.run(
        { id: 'abc' },
        { subject: 'user_01', tenant: 'namastex' },
      );

      expect(recorder.requests).toEqual([{ params: { id: 'abc' }, query: {} }]);
    });
  });
});
