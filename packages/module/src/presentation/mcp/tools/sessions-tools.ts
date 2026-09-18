import {
  sessionDetailResponseSchema,
  sessionFilterOptionsResponseSchema,
  sessionListResponseSchema,
} from '../../controllers/sessions/session-view-schemas.js';
import { sessionFilterQueryShape } from '../../controllers/sessions/session-filter-query.js';
import { paginationSchema } from '../../helpers/query-validation.js';
import { Controller } from '../../interfaces/index.js';
import { jsonFromController } from '../controller-tool.js';
import { toQuery } from '../query-args.js';
import { READ_ONLY, ToolDefinition } from '../tool-definition.js';
import { idArg, paginationArgs, sessionFilterArgs } from './read-args.js';

export const SESSION_QUERY_SHAPES = {
  list_sessions: { ...sessionFilterQueryShape, ...paginationSchema },
  get_session_filter_options: sessionFilterQueryShape,
  get_session: {},
} as const;

export interface SessionControllers {
  readonly listSessions: Controller;
  readonly sessionFilterOptions: Controller;
  readonly sessionDetail: Controller;
}

export const sessionTools = (
  controllers: SessionControllers,
): ToolDefinition[] => [
  {
    name: 'list_sessions',
    title: 'List conversations (sessions)',
    description:
      'Conversations — the executions grouped by session id — with summed duration, tokens and cost. The period filter matches the session START. ' +
      'A session holding an execution without an applicable price reports cost_brl null and says it is partial, never a total that reads as final R$ 0.00. ' +
      'Executions with no session id are absent here and present in list_traces.',
    inputSchema: { ...sessionFilterArgs, ...paginationArgs },
    outputSchema: sessionListResponseSchema,
    annotations: READ_ONLY,
    run: async (args) =>
      jsonFromController(controllers.listSessions, { query: toQuery(args) }),
  },
  {
    name: 'get_session_filter_options',
    title: 'Filter options for conversations',
    description:
      'Agents and statuses present among sessions, with a count of SESSIONS per option. Cascading with self-exclusion, like the execution filters.',
    inputSchema: sessionFilterArgs,
    outputSchema: sessionFilterOptionsResponseSchema,
    annotations: READ_ONLY,
    run: async (args) =>
      jsonFromController(controllers.sessionFilterOptions, {
        query: toQuery(args),
      }),
  },
  {
    name: 'get_session',
    title: 'One conversation, in order',
    description:
      'The session aggregates plus its chronological chain of executions — the transcript view. Long chains are truncated and say so.',
    inputSchema: idArg('conversation (session)'),
    outputSchema: sessionDetailResponseSchema,
    annotations: READ_ONLY,
    run: async (args) =>
      jsonFromController(controllers.sessionDetail, {
        params: { id: String(args['id']) },
        query: {},
      }),
  },
];
