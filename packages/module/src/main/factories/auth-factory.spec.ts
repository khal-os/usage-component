import express from 'express';
import request from 'supertest';

/**
 * The factory reads `config` at call time, so each case mocks the
 * infrastructure barrel with the env shape under test, resets the module
 * registry and re-imports (same technique as environment-setup.spec).
 * What is pinned here is the WIRING, not the JWT math (the validator has
 * its own spec): which gate the env produces, and that the open posture
 * is warned about while the misconfigured one fails closed.
 */
const warnMock = jest.fn();
const errorMock = jest.fn();

const loadFactory = async (config: {
  khalAuthUrl?: string;
  khalTenant?: string;
  khalTokenAudience: string;
}): Promise<typeof import('./auth-factory.js').makeAuthMiddleware> => {
  jest.resetModules();
  jest.doMock('../../infrastructure/index.js', () => ({ config }));
  jest.doMock('./logger-factory.js', () => ({
    makeLogger: () => ({
      warn: warnMock,
      error: errorMock,
      info: jest.fn(),
      debug: jest.fn(),
      fatal: jest.fn(),
    }),
  }));

  const { makeAuthMiddleware } = await import('./auth-factory.js');
  return makeAuthMiddleware;
};

const appWith = (
  middleware: ReturnType<Awaited<ReturnType<typeof loadFactory>>>,
) => {
  const app = express();
  app.use(middleware);
  app.get('/probe', (_, res) => {
    res.json({ ok: true });
  });
  return app;
};

afterEach(() => {
  jest.resetModules();
  jest.dontMock('../../infrastructure/index.js');
  jest.dontMock('./logger-factory.js');
});

describe('makeAuthMiddleware (session gate wiring)', () => {
  it('MUST pass requests through AND warn loudly when KHAL_AUTH_URL is unset (open mode, PoC posture)', async () => {
    const makeAuthMiddleware = await loadFactory({
      khalTokenAudience: 'tracing',
    });

    const app = appWith(makeAuthMiddleware());

    await request(app).get('/probe').expect(200, { ok: true });
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('KHAL_AUTH_URL is unset'),
    );
  });

  it('MUST gate /probe behind a Bearer token when KHAL_AUTH_URL + KHAL_TENANT are set', async () => {
    const makeAuthMiddleware = await loadFactory({
      khalAuthUrl: 'https://auth.khal-usage.com',
      khalTenant: 'namastex',
      khalTokenAudience: 'tracing',
    });

    const app = appWith(makeAuthMiddleware());

    // No token → 401 at the middleware, before any JWKS traffic.
    const refused = await request(app).get('/probe').expect(401);
    expect(refused.body).toEqual({
      name: 'UnauthorizedError',
      msg: 'Unauthorized',
    });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('MUST fail closed on a garbage token when the JWKS endpoint is unreachable (real validator wired)', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    try {
      const makeAuthMiddleware = await loadFactory({
        khalAuthUrl: 'https://auth.khal-usage.com',
        khalTenant: 'namastex',
        khalTokenAudience: 'tracing',
      });

      const app = appWith(makeAuthMiddleware());

      await request(app)
        .get('/probe')
        .set('Authorization', 'Bearer not-a-real-token')
        .expect(401);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('MUST fail closed (all 401) and log an error when KHAL_AUTH_URL is set without KHAL_TENANT', async () => {
    const makeAuthMiddleware = await loadFactory({
      khalAuthUrl: 'https://auth.khal-usage.com',
      khalTokenAudience: 'tracing',
    });

    const app = appWith(makeAuthMiddleware());

    // Even a well-formed Bearer header is refused — the guard authenticator
    // answers false unconditionally.
    await request(app)
      .get('/probe')
      .set('Authorization', 'Bearer some-token')
      .expect(401);
    expect(errorMock).toHaveBeenCalledWith(
      expect.stringContaining('KHAL_TENANT is not'),
    );
  });
});
