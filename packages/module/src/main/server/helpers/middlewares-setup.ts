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
  // After CORS (preflights must answer), before routes. Docs are mounted
  // BEFORE middlewares in app.ts and stay open — they are the healthcheck.
  // Session gate (khal-auth JWT; replaced the interim Basic gate of
  // decision 141): passthrough only when KHAL_AUTH_URL is unset.
  app.use(makeAuthMiddleware());
  app.use(defaultContentTypeMiddleware);
  // audit D-7: no-store + nosniff defaults; controllers override for the
  // provably-cacheable (closed months).
  app.use(cacheHeadersMiddleware);
};
