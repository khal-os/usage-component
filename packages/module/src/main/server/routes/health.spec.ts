import express from 'express';
import request from 'supertest';
import { registerHealthRoute } from './health.js';
import { healthResponseSchema } from '../../../presentation/helpers/docs-schemas.js';

/**
 * The route's own contract (decision 172). Whether it stays OPEN under the
 * auth gate is the ordering test's job (app-auth-gating.test.ts) — here we
 * pin what the probe reads once it gets through.
 */
const makeApp = () => {
  const app = express();
  registerHealthRoute(app);
  return app;
};

describe('GET /health', () => {
  it('MUST answer 200 with the documented strict shape', async () => {
    const response = await request(makeApp()).get('/health').expect(200);

    expect(() => healthResponseSchema.parse(response.body)).not.toThrow();
  });

  it('MUST NOT be cacheable — a cached "ok" defeats the probe', async () => {
    const response = await request(makeApp()).get('/health').expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
  });
});
