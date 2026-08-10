import express from 'express';
import request from 'supertest';
import { buildBasicAuthMiddleware } from './index.js';

// Local app, same reason as auth.spec.ts: the shared app ends in a 404
// catch-all, so routes registered after import would never be reached.
const makeApp = (credentials?: { user: string; password: string }) => {
  const app = express();
  app.use(buildBasicAuthMiddleware(credentials));
  app.get('/test-basic', (_, res) => {
    res.json({ ok: true });
  });
  return app;
};

const encode = (user: string, password: string) =>
  Buffer.from(`${user}:${password}`).toString('base64');

const CREDS = { user: 'namastex', password: 's3cret:with:colons' };

describe('Basic Auth Middleware (decision 141 — interim edge gate)', () => {
  it('MUST pass every request through when no credentials are configured', async () => {
    await request(makeApp()).get('/test-basic').expect(200, { ok: true });
  });

  it('MUST answer 401 with a WWW-Authenticate challenge when the header is missing', async () => {
    const response = await request(makeApp(CREDS))
      .get('/test-basic')
      .expect(401);

    expect(response.headers['www-authenticate']).toBe(
      'Basic realm="usage-component"',
    );
    expect(response.body).toEqual({
      name: 'UnauthorizedError',
      msg: 'Unauthorized',
    });
  });

  it('MUST answer 401 for a Bearer header (wrong scheme)', async () => {
    await request(makeApp(CREDS))
      .get('/test-basic')
      .set('Authorization', 'Bearer some-token')
      .expect(401);
  });

  it('MUST answer 401 for wrong credentials', async () => {
    await request(makeApp(CREDS))
      .get('/test-basic')
      .set('Authorization', `Basic ${encode('namastex', 'wrong')}`)
      .expect(401);

    await request(makeApp(CREDS))
      .get('/test-basic')
      .set('Authorization', `Basic ${encode('intruder', CREDS.password)}`)
      .expect(401);
  });

  it('MUST answer 401 for a malformed payload (no colon)', async () => {
    await request(makeApp(CREDS))
      .get('/test-basic')
      .set(
        'Authorization',
        `Basic ${Buffer.from('no-separator').toString('base64')}`,
      )
      .expect(401);
  });

  it('MUST pass with correct credentials — including colons in the password (RFC 7617)', async () => {
    await request(makeApp(CREDS))
      .get('/test-basic')
      .set('Authorization', `Basic ${encode(CREDS.user, CREDS.password)}`)
      .expect(200, { ok: true });
  });

  it('MUST accept a lowercase `basic` scheme (RFC 7235: schemes are case-insensitive)', async () => {
    await request(makeApp(CREDS))
      .get('/test-basic')
      .set('Authorization', `basic ${encode(CREDS.user, CREDS.password)}`)
      .expect(200, { ok: true });
  });

  it('MUST let CORS preflights through without credentials', async () => {
    await request(makeApp(CREDS)).options('/test-basic').expect(200);
  });
});
