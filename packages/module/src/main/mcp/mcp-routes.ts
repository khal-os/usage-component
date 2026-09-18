import { Application, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCP_PATH } from '../../infrastructure/configuration/helpers/environment-setup.js';
import { Logger } from '@observability/core/common/logging/logger.js';
import { SessionClaimsVerifier } from '../../application/interfaces/session-claims-verifier.js';
import { McpSurface } from '../../presentation/mcp/surface.js';
import {
  originAllowedBy,
  parseAllowedOrigins,
} from '../server/middlewares/cors.js';
import { authenticateMcp } from './auth-gate.js';
import { buildMcpServer } from './mcp-server.js';
import {
  registerProtectedResourceRoutes,
  resourceMetadataUrlOf,
} from './protected-resource.js';

// ONE spelling: the env schema validates that MCP_CANONICAL_URL ends in this
// exact path, so a second literal here could drift from the value the boot
// enforces — the repo's own named root cause (one rule, two spellings).
export { MCP_PATH } from '../../infrastructure/configuration/helpers/environment-setup.js';

export interface McpRuntime {
  readonly surface: McpSurface;
  readonly verifier: SessionClaimsVerifier;
  /** MCP_CANONICAL_URL — resource identifier and PRM `resource`. */
  readonly canonicalUrl: string;
  readonly authorizationServer: string;
  readonly resourceName: string;
  /** Browser origins allowed to reach the endpoint (CORS_ALLOWED_ORIGINS). */
  readonly allowedOrigins: string;
  readonly version: string;
  readonly logger: Logger;
}

/** GET and DELETE exist in the protocol for SSE streams and session teardown — a stateless server has neither. */
const methodNotAllowed = (_req: Request, res: Response): void => {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed: the MCP endpoint takes POST.',
      },
      id: null,
    });
};

/**
 * The MCP endpoint (decision 175). Mounted by middlewares-setup BEFORE the
 * /api/v1 session gate and AFTER the CORS middleware — position is the
 * contract, exactly like GET /health (decision 172): this door carries its
 * own gate (a different audience and a role check), and a browser-hosted
 * client must be able to read the CORS echo.
 */
export const registerMcpRoutes = (
  app: Application,
  runtime: McpRuntime,
): void => {
  registerProtectedResourceRoutes(app, {
    canonicalUrl: runtime.canonicalUrl,
    authorizationServer: runtime.authorizationServer,
    resourceName: runtime.resourceName,
  });

  const resourceMetadataUrl = resourceMetadataUrlOf(runtime.canonicalUrl);
  // Desktop clients send no Origin at all; a browser-hosted one is admitted
  // only when its origin is listed — the same allowlist the API uses, so
  // there is no second place to loosen (audit D-1 posture).
  const originAllowed = originAllowedBy(
    parseAllowedOrigins(runtime.allowedOrigins),
  );

  app.post(MCP_PATH, (req: Request, res: Response): void => {
    const origin = req.headers.origin;

    if (origin !== undefined && !originAllowed(origin)) {
      runtime.logger.warn('mcp: origin not allowed', { origin });
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Origin not allowed.' },
        id: null,
      });

      return;
    }

    void (async () => {
      const auth = await authenticateMcp(req, res, {
        verifier: runtime.verifier,
        resourceMetadataUrl,
        logger: runtime.logger,
      });

      if (!auth.ok) return;

      // Stateless: no session id generator, JSON responses (no SSE to keep
      // open through an ALB). Server and transport are single-use by SDK
      // contract, so both are built and closed per request.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = buildMcpServer(runtime.surface, auth.caller, {
        version: runtime.version,
        logger: runtime.logger,
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        runtime.logger.error('mcp: request failed', { err: error });

        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error.' },
            id: null,
          });
        }
      } finally {
        await transport.close();
        await server.close();
      }
    })();
  });

  app.get(MCP_PATH, methodNotAllowed);
  app.delete(MCP_PATH, methodNotAllowed);
};
