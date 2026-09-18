import {
  traceDetailResponseSchema,
  traceFilterOptionsResponseSchema,
  traceListResponseSchema,
} from '../../controllers/traces/trace-view-schemas.js';
import { traceFilterQueryShape } from '../../controllers/traces/trace-filter-query.js';
import { paginationSchema } from '../../helpers/query-validation.js';
import { Controller } from '../../interfaces/index.js';
import { jsonFromController } from '../controller-tool.js';
import { toQuery } from '../query-args.js';
import { READ_ONLY, ToolDefinition } from '../tool-definition.js';
import { idArg, paginationArgs, traceFilterArgs } from './read-args.js';

/** The query contracts these tools mirror — the drift guard parses against them. */
export const TRACE_QUERY_SHAPES = {
  list_traces: { ...traceFilterQueryShape, ...paginationSchema },
  get_trace_filter_options: traceFilterQueryShape,
  get_trace: {},
} as const;

export interface TraceControllers {
  readonly listTraces: Controller;
  readonly traceFilterOptions: Controller;
  readonly traceDetail: Controller;
}

export const traceTools = (controllers: TraceControllers): ToolDefinition[] => [
  {
    name: 'list_traces',
    title: 'List executions (traces)',
    description:
      'Real executions, most recent first, with the cost each one was stamped with at ingestion (R$, immutable). ' +
      'Counting stops at 10,000 with or without filters: up to that ceiling `total` is exact and `total_capped` is false; beyond it the answer carries total 10000, total_capped true and displays suffixed with "+" — the honest number is `total_display`. ' +
      'An execution whose model had no applicable price shows pricing_status pending_price and NO cost, never R$ 0.00.',
    inputSchema: { ...traceFilterArgs, ...paginationArgs },
    outputSchema: traceListResponseSchema,
    annotations: READ_ONLY,
    run: async (args) =>
      jsonFromController(controllers.listTraces, { query: toQuery(args) }),
  },
  {
    name: 'get_trace_filter_options',
    title: 'Filter options for executions',
    description:
      'The values each filter field actually has in the archive, with a count per option — use it before guessing an agent id or a channel. ' +
      'Cascading with self-exclusion: the options of field X honour every filter EXCEPT X, so a selected dropdown still lists its alternatives.',
    inputSchema: traceFilterArgs,
    outputSchema: traceFilterOptionsResponseSchema,
    annotations: READ_ONLY,
    run: async (args) =>
      jsonFromController(controllers.traceFilterOptions, {
        query: toQuery(args),
      }),
  },
  {
    name: 'get_trace',
    title: 'Anatomy of one execution',
    description:
      'Everything about one execution: metrics, the agent and channel build that served it, ordered spans, the full input and output content, and the cost account (applied price x tokens, full precision per line).',
    inputSchema: idArg('execution (trace)'),
    outputSchema: traceDetailResponseSchema,
    annotations: READ_ONLY,
    run: async (args) =>
      jsonFromController(controllers.traceDetail, {
        params: { id: String(args['id']) },
        query: {},
      }),
  },
];
