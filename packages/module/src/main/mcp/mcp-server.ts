import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from '@observability/core/common/logging/logger.js';
import {
  McpSurface,
  SERVER_INSTRUCTIONS,
} from '../../presentation/mcp/surface.js';
import {
  ToolCaller,
  ToolOutcome,
} from '../../presentation/mcp/tool-definition.js';
import { toolError } from '../../presentation/mcp/tool-error.js';
import { registerDiscover } from './discover.js';

export const SERVER_NAME = 'khal-usage-mcp';

const CAPABILITIES = { tools: {}, prompts: {}, resources: {} } as const;

/**
 * A tool result on the wire. `structuredContent` is what a modern client
 * reads and what the SDK validates against the tool's output schema; the
 * text block is the same payload for clients that only render text. A
 * failure is a RESULT with `isError` (never a thrown exception, never a
 * JSON-RPC error): the model has to be able to read it and fix the call.
 */
const toCallResult = (outcome: ToolOutcome): CallToolResult => {
  if (!outcome.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.error, null, 2) }],
      isError: true,
    };
  }

  const { structured, text, document } = outcome.value;

  return {
    content: [
      { type: 'text', text: text ?? JSON.stringify(structured, null, 2) },
      ...(document
        ? [
            {
              type: 'resource' as const,
              resource: {
                uri: document.uri,
                mimeType: document.mimeType,
                text: document.text,
              },
            },
          ]
        : []),
    ],
    structuredContent: structured,
  };
};

/**
 * The error boundary of this door, and the twin of `adaptRoute`'s on the HTTP
 * door: an UNEXPECTED throw — a store outage, a domain error no tool maps —
 * must reach the caller as an opaque INTERNAL and reach the operator as a log
 * line. Without it the SDK turns the exception into a tool error carrying
 * `error.message` verbatim, which is how a connection string or an internal
 * class name would travel to a language model, unlogged.
 */
export const guarded = async (
  run: () => Promise<ToolOutcome>,
  context: { tool: string; caller: ToolCaller; logger: Logger },
): Promise<ToolOutcome> => {
  try {
    return await run();
  } catch (error) {
    context.logger.error('mcp: tool failed', {
      tool: context.tool,
      subject: context.caller.subject,
      err: error,
    });

    return {
      ok: false,
      error: toolError(
        'INTERNAL',
        'The component failed to answer this call.',
        'Retry once; if it keeps failing, the operator has to look at the module logs.',
      ),
    };
  }
};

/**
 * ONE server per request (decision 175): the SDK's transport is single-use,
 * and the tools close over the caller verified for THIS request — there is
 * no shared server whose identity could be confused between two sessions.
 */
export const buildMcpServer = (
  surface: McpSurface,
  caller: ToolCaller,
  info: { version: string; logger: Logger },
): McpServer => {
  const server = new McpServer(
    { name: SERVER_NAME, version: info.version },
    { capabilities: CAPABILITIES, instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of surface.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) =>
        toCallResult(
          await guarded(() => tool.run(args ?? {}, caller), {
            tool: tool.name,
            caller,
            logger: info.logger,
          }),
        ),
    );
  }

  for (const prompt of surface.prompts) {
    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema: prompt.argsSchema,
      },
      (args: Record<string, string | undefined>) => ({
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: prompt.build(args ?? {}) },
          },
        ],
      }),
    );
  }

  for (const resource of surface.resources) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
      },
      async () => {
        try {
          return {
            contents: [
              {
                uri: resource.uri,
                mimeType: resource.mimeType,
                text: await resource.read(),
              },
            ],
          };
        } catch (error) {
          // Same boundary as a tool: a resource read touches the store too.
          info.logger.error('mcp: resource read failed', {
            uri: resource.uri,
            subject: caller.subject,
            err: error,
          });

          // `cause` carries the real failure for any handler up the stack; the
          // SDK only ever puts `message` on the wire, so nothing internal
          // travels to the client.
          throw new Error('The component failed to read this resource.', {
            cause: error,
          });
        }
      },
    );
  }

  registerDiscover(
    server,
    { name: SERVER_NAME, version: info.version },
    CAPABILITIES,
  );

  return server;
};
