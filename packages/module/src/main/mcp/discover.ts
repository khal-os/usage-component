import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const DISCOVER_METHOD = 'server/discover';

/** What the transport actually negotiates, newest first — read from the SDK, never hardcoded. */
export const PROTOCOL_VERSIONS: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;

const discoverRequestSchema = z.object({
  method: z.literal(DISCOVER_METHOD),
  params: z.looseObject({}).optional(),
});

/**
 * The 2026-07-28 revision of the spec makes `server/discover` mandatory and
 * drops `initialize`; the published SDK still speaks 2025-11-25, where
 * `initialize` is the handshake. Registering discover as a custom method
 * serves both: today's clients initialize, tomorrow's discover, and the
 * server does not have to be rewritten in between.
 */
export const registerDiscover = (
  server: McpServer,
  info: { name: string; version: string },
  capabilities: Record<string, unknown>,
): void => {
  server.server.setRequestHandler(discoverRequestSchema, () => ({
    protocolVersions: [...PROTOCOL_VERSIONS],
    capabilities,
    serverInfo: { name: info.name, version: info.version },
  }));
};
