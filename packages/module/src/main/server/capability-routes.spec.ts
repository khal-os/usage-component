import express from 'express';
import request from 'supertest';
import { nullLogger } from '@observability/core/common/logging/null-logger.js';
import { SessionCaller } from '../../application/interfaces/token-authenticator.js';
import { setupErrorHandling, setupV1Routes } from './helpers/index.js';
import { SESSION_CALLER } from './middlewares/auth.js';

/**
 * Decision 184, route by route: the caller the session gate verified (its
 * spec and app-auth-gating hold the gate itself) opens only the routes of the
 * capabilities its app's KHAL_TOKEN_AUDIENCE entry names. The default maps
 * tracing → tracing.sessions and billing → billing.ledger. Every case is
 * refused before a controller runs, so no store is needed.
 */
const appAs = (caller: SessionCaller) => {
  const app = express();
  // what the gate leaves for the routes after verifying the token
  app.use((_req, res, next) => {
    res.locals[SESSION_CALLER] = caller;
    next();
  });
  const routes = setupV1Routes(app);
  setupErrorHandling(app, routes, nullLogger);
  return app;
};

describe('the routes by capability (decision 184)', () => {
  it('MUST refuse a Tracing token the billing data, 403', async () => {
    const app = appAs({ audience: 'tracing', role: 'member' });

    for (const path of [
      '/api/v1/bills',
      '/api/v1/billing/summary?year=2026&month=6',
      '/api/v1/billing/statement?year=2026&month=6',
      '/api/v1/prices',
    ]) {
      const response = await request(app).get(path).expect(403);
      expect(response.body).toMatchObject({ name: 'ForbiddenError' });
    }
  });

  it('MUST refuse a Billing token the traces and sessions, 403', async () => {
    const app = appAs({ audience: 'billing', role: 'member' });

    for (const path of ['/api/v1/traces', '/api/v1/sessions/s-1']) {
      await request(app).get(path).expect(403);
    }
  });

  it('MUST keep registering a price the master’s, even with the billing data', async () => {
    const app = appAs({ audience: 'billing', role: 'admin' });

    await request(app).post('/api/v1/prices').send({}).expect(403);
  });

  it('MUST refuse an app the configuration does not name', async () => {
    const app = appAs({ audience: 'agent-anatomy', role: 'master' });

    await request(app).get('/api/v1/traces').expect(403);
  });
});
