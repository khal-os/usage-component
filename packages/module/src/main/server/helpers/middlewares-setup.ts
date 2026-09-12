import { Application } from 'express';
import { Logger } from '@observability/core/common/logging/logger.js';
import {
  bodyParserMiddleware,
  corsMiddleware,
  cacheHeadersMiddleware,
  requireJsonMiddleware,
  defaultContentTypeMiddleware,
  makeRequestLoggerMiddleware,
} from '../middlewares/index.js';
import { makeAuthMiddleware } from '../../factories/auth-factory.js';
import { makeMcpRuntime } from '../../factories/mcp-factory.js';
import { registerMcpRoutes } from '../../mcp/mcp-routes.js';
import { registerHealthRoute } from '../routes/health.js';

export const setupMiddlewares = (app: Application, logger: Logger): void => {
  // Fingerprinting header — no reason to advertise the framework.
  app.disable('x-powered-by');
  app.use(makeRequestLoggerMiddleware(logger));
  // JSON only ON PURPOSE: no urlencoded parser — this is a JSON API and a
  // form-encoded body must never be silently accepted (C-1). The 415 gate
  // runs FIRST (audit D-2): body-parser turns a non-JSON body into {} and
  // the controllers then misdiagnose it as missing fields.
  app.use(requireJsonMiddleware);
  app.use(bodyParserMiddleware);
  app.use(corsMiddleware);
  // Open GET /health sits EXACTLY here (decision 172 — position is the
  // contract): AFTER the CORS middleware, because the Catalog Console
  // probes it cross-origin from the browser and must read the 200 (a
  // route registered before corsMiddleware would answer without the
  // allow-origin echo, like the docs do); and BEFORE the session gate,
  // because liveness has no token — the platform convention every
  // register follows.
  registerHealthRoute(app);
  // The MCP endpoint (T12, decision 175) sits EXACTLY here, for the same
  // reason /health does — position is the contract. AFTER corsMiddleware,
  // because a browser-hosted client must be able to read the allow-origin
  // echo; BEFORE the /api/v1 session gate, because this door has its own
  // gate: a different (strict) audience and a master-only role check. Absent
  // MCP_CANONICAL_URL the factory returns undefined and nothing is mounted,
  // so every deployment that does not configure it is byte-for-byte the
  // server it was before.
  const mcp = makeMcpRuntime();
  if (mcp) registerMcpRoutes(app, mcp);
  // After CORS (preflights must answer), before routes. Docs are mounted
  // BEFORE middlewares in app.ts and stay open — they are the path the
  // chart's probes still check (PENDENTE-1 flips them to /health).
  // Session gate (khal-auth JWT; replaced the interim Basic gate of
  // decision 141): passthrough only when KHAL_AUTH_URL is unset.
  app.use(makeAuthMiddleware());
  app.use(defaultContentTypeMiddleware);
  // audit D-7: no-store + nosniff defaults; controllers override for the
  // provably-cacheable (closed months).
  app.use(cacheHeadersMiddleware);
};
