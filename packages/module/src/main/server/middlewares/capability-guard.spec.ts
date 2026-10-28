import express from 'express';
import request from 'supertest';
import { SessionCaller } from '../../../application/interfaces/token-authenticator.js';
import {
  BILLING_LEDGER,
  TRACING_SESSIONS,
} from '../../../presentation/capabilities.js';
import { SESSION_CALLER } from './auth.js';
import {
  AudienceCapabilities,
  buildCapabilityGuard,
  CapabilityRule,
} from './capability-guard.js';

/**
 * Decision 184: a token opens only the capabilities of the app it was
 * minted for. The caller is planted as the session gate leaves it.
 */
const MAP: AudienceCapabilities = {
  tracing: [TRACING_SESSIONS],
  billing: [BILLING_LEDGER],
  legacy: 'all',
};

const makeApp = (caller: SessionCaller | undefined, rule: CapabilityRule) => {
  const app = express();
  app.use((_req, res, next) => {
    if (caller) res.locals[SESSION_CALLER] = caller;
    next();
  });
  app.get('/data', buildCapabilityGuard(MAP)(rule), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
};

const tracingToken: SessionCaller = { audience: 'tracing', role: 'member' };
const billingToken: SessionCaller = { audience: 'billing', role: 'member' };

describe('Capability guard (decision 184)', () => {
  it("MUST let a token through to its own app's data", async () => {
    await request(makeApp(tracingToken, { capability: TRACING_SESSIONS }))
      .get('/data')
      .expect(200, { ok: true });
  });

  it("MUST answer 403 for another app's data: the Tracing token never reads billing", async () => {
    const response = await request(
      makeApp(tracingToken, { capability: BILLING_LEDGER }),
    )
      .get('/data')
      .expect(403);

    expect(response.body).toMatchObject({ name: 'ForbiddenError' });
  });

  it('MUST answer 403 for an audience the map does not name', async () => {
    await request(
      makeApp(
        { audience: 'other', role: 'master' },
        { capability: TRACING_SESSIONS },
      ),
    )
      .get('/data')
      .expect(403);
  });

  it('MUST let a bare (older-form) audience read everything', async () => {
    await request(
      makeApp(
        { audience: 'legacy', role: 'member' },
        { capability: BILLING_LEDGER },
      ),
    )
      .get('/data')
      .expect(200);
  });

  it('MUST demand the master role on a master-only route, on top of the data', async () => {
    const rule: CapabilityRule = {
      capability: BILLING_LEDGER,
      masterOnly: true,
    };
    await request(makeApp(billingToken, rule)).get('/data').expect(403);
    await request(makeApp({ audience: 'billing', role: 'master' }, rule))
      .get('/data')
      .expect(200);
  });

  it('MUST let everything through with the gate off (no caller: KHAL_AUTH_URL unset)', async () => {
    await request(
      makeApp(undefined, { capability: BILLING_LEDGER, masterOnly: true }),
    )
      .get('/data')
      .expect(200);
  });
});
