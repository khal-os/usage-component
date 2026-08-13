import express from 'express';
import request from 'supertest';
import { buildAuthMiddleware } from './index.js';
import { TokenAuthenticator } from '../../../application/interfaces/token-authenticator.js';

// Local app: the shared app now ends in a 404 catch-all, so routes
// registered after import would never be reached.
const makeApp = (authenticator?: TokenAuthenticator) => {
  const app = express();
  app.use(buildAuthMiddleware(authenticator));
  app.get('/test-auth', (_, res) => {
    res.json({ ok: true });
  });
  return app;
};

const authenticatorAnswering = (answer: boolean): TokenAuthenticator => ({
  isAuthenticated: async () => answer,
});

describe('Auth Middleware', () => {
  it('MUST pass every request through when no authenticator is configured (KHAL_AUTH_URL unset — open mode)', async () => {
    await request(makeApp()).get('/test-auth').expect(200, { ok: true });
  });

  it('MUST answer 401 when the Authorization header is missing', async () => {
    const response = await request(makeApp(authenticatorAnswering(true)))
      .get('/test-auth')
      .expect(401);

    expect(response.body).toEqual({
      name: 'UnauthorizedError',
      msg: 'Unauthorized',
    });
  });

  it('MUST answer 401 when the Authorization header is not a Bearer token', async () => {
    await request(makeApp(authenticatorAnswering(true)))
      .get('/test-auth')
      .set('Authorization', 'Basic abc123')
      .expect(401);
  });

  it('MUST answer 401 when the Auth System rejects the token', async () => {
    await request(makeApp(authenticatorAnswering(false)))
      .get('/test-auth')
      .set('Authorization', 'Bearer some-token')
      .expect(401);
  });

  it('MUST pass the request through when the Auth System accepts the token', async () => {
    await request(makeApp(authenticatorAnswering(true)))
      .get('/test-auth')
      .set('Authorization', 'Bearer some-token')
      .expect(200, { ok: true });
  });

  it('MUST accept a lowercase `bearer` scheme (RFC 7235: schemes are case-insensitive)', async () => {
    const seen: string[] = [];
    const recording: TokenAuthenticator = {
      isAuthenticated: async (token) => {
        seen.push(token);
        return true;
      },
    };

    await request(makeApp(recording))
      .get('/test-auth')
      .set('Authorization', 'bearer some-token')
      .expect(200, { ok: true });

    expect(seen).toEqual(['some-token']);
  });

  it('MUST answer 401 (fail closed) when the authenticator throws', async () => {
    const throwing: TokenAuthenticator = {
      isAuthenticated: async () => {
        throw new Error('auth system down');
      },
    };

    await request(makeApp(throwing))
      .get('/test-auth')
      .set('Authorization', 'Bearer some-token')
      .expect(401);
  });

  it('MUST let CORS preflights through without a token', async () => {
    await request(makeApp(authenticatorAnswering(false)))
      .options('/test-auth')
      .expect(200);
  });
});
