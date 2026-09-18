import express from 'express';
import request from 'supertest';
import {
  setupDocs,
  setupErrorHandling,
  setupV1Routes,
} from './helpers/index.js';
import { buildAuthMiddleware } from './middlewares/index.js';
import { registerHealthRoute } from './routes/health.js';
import { nullLogger } from '@observability/core/common/logging/null-logger.js';
import { TokenAuthenticator } from '../../application/interfaces/token-authenticator.js';
import { SessionClaimsVerifier } from '../../application/interfaces/session-claims-verifier.js';
import { makeMcpRuntimeFrom } from '../factories/mcp-factory.js';
import { registerMcpRoutes } from '../mcp/mcp-routes.js';

/**
 * Mirrors app.ts's LOAD-BEARING ordering with a real (stubbed-authenticator)
 * auth middleware injected: docs are mounted BEFORE auth on purpose — they
 * are the healthcheck and stay open (decision Q5) — and GET /health sits
 * right before the gate too (decision 172: liveness has no token);
 * everything under /api/v1 behind them answers 401. If someone reorders
 * app.ts or middlewares-setup, this is the test that says which behavior
 * was the contract.
 */
const rejectEverything: TokenAuthenticator = {
  isAuthenticated: async () => false,
};

/** The MCP door refuses everything too — its verifier is the one being tested. */
const rejectEverySession: SessionClaimsVerifier = {
  verify: async () => undefined,
};

const makeAppWithAuth = (options: { withMcp?: boolean } = {}) => {
  const app = express();
  // Same sequence as app.ts: docs first, then /health, then (optionally) the
  // MCP endpoint, then auth, then the API routes, then the 404/error boundary.
  setupDocs(app);
  registerHealthRoute(app);
  if (options.withMcp) {
    app.use(express.json());
    registerMcpRoutes(
      app,
      makeMcpRuntimeFrom(
        {
          canonicalUrl: 'https://api-test.example.com/mcp',
          authUrl: 'https://auth-test.example.com',
          tenant: 'acme',
          audience: 'usage-mcp',
          // qcia:allow-secret — test stub
          confirmationKey: 'gating-suite-key-longer-than-32-characters',
          clientTimezone: 'America/Sao_Paulo',
          allowedOrigins: '',
        },
        { verifier: rejectEverySession },
      ),
    );
  }
  app.use(buildAuthMiddleware(rejectEverything));
  const routes = setupV1Routes(app);
  setupErrorHandling(app, routes, nullLogger);
  return app;
};

describe('App auth gating (env-gated M2M bearer)', () => {
  it('MUST answer /api/v1/traces 401 while /api/v1/docs/ and openapi.json stay open', async () => {
    const app = makeAppWithAuth();

    const traces = await request(app).get('/api/v1/traces').expect(401);
    expect(traces.body).toEqual({
      name: 'UnauthorizedError',
      msg: 'Unauthorized',
    });

    const docs = await request(app).get('/api/v1/docs/').expect(200);
    expect(docs.headers['content-type']).toContain('text/html');

    const openapi = await request(app)
      .get('/api/v1/docs/openapi.json')
      .expect(200);
    expect(openapi.body.openapi).toBe('3.1.0');
  });

  it('MUST keep GET /health open while the gate rejects everything — the probe has no token (decision 172)', async () => {
    const app = makeAppWithAuth();

    const health = await request(app).get('/health').expect(200);
    expect(health.body).toEqual({ status: 'ok', component: 'usage-module' });
  });

  it('MUST gate every API face, not just traces', async () => {
    const app = makeAppWithAuth();

    for (const path of [
      '/api/v1/sessions',
      '/api/v1/bills',
      '/api/v1/billing/summary?year=2026&month=6',
    ]) {
      await request(app).get(path).expect(401);
    }

    await request(app).post('/api/v1/prices').expect(401);
  });
  /**
   * T12: the MCP endpoint carries its OWN gate, and its position in the
   * chain is the contract (decision 175) — mounted before the /api/v1 gate,
   * so a change in one door can never silently open or close the other.
   */
  describe('with the MCP endpoint mounted', () => {
    it('MUST answer POST /mcp 401 with the RFC 9728 challenge, not the API 401', async () => {
      const app = makeAppWithAuth({ withMcp: true });

      const response = await request(app)
        .post('/mcp')
        .set('accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        .expect(401);

      expect(response.headers['www-authenticate']).toContain(
        'resource_metadata=',
      );
    });

    it('MUST keep the protected-resource metadata OPEN — the client has no token yet', async () => {
      const app = makeAppWithAuth({ withMcp: true });

      const response = await request(app)
        .get('/.well-known/oauth-protected-resource/mcp')
        .expect(200);

      expect(response.body.resource).toBe('https://api-test.example.com/mcp');
    });

    it('MUST leave the /api/v1 gate exactly as it was', async () => {
      const app = makeAppWithAuth({ withMcp: true });

      await request(app).get('/api/v1/traces').expect(401);
      await request(app).get('/api/v1/docs/').expect(200);
      await request(app).get('/health').expect(200);
    });

    it('MUST serve NO MCP surface when the endpoint is not configured', async () => {
      const app = makeAppWithAuth();

      // /mcp is then just an unknown path: whatever answers it, it is NOT the
      // MCP door — no RFC 9728 challenge, and no metadata document anywhere.
      const posted = await request(app)
        .post('/mcp')
        .set('accept', 'application/json')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      expect(posted.headers['www-authenticate']).toBeUndefined();

      const metadata = await request(app).get(
        '/.well-known/oauth-protected-resource',
      );

      expect(metadata.status).not.toBe(200);
      expect(metadata.body).not.toHaveProperty('resource');
    });
  });
});
