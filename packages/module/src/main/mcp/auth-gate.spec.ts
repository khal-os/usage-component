import { Request, Response } from 'express';
import { nullLogger } from '@observability/core/common/logging/null-logger.js';
import {
  SessionClaims,
  SessionClaimsVerifier,
} from '../../application/interfaces/session-claims-verifier.js';
import { authenticateMcp, bearerTokenOf } from './auth-gate.js';

const RESOURCE_METADATA_URL =
  'https://api-dev.example.com/.well-known/oauth-protected-resource/mcp';

interface FakeResponse {
  statusCode?: number;
  headers: Record<string, string>;
  body?: unknown;
}

const makeRes = (): { res: Response; sent: FakeResponse } => {
  const sent: FakeResponse = { headers: {} };
  const res = {
    status(code: number) {
      sent.statusCode = code;
      return this;
    },
    set(key: string, value: string) {
      sent.headers[key] = value;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  };

  return { res: res as unknown as Response, sent };
};

const makeReq = (authorization?: string): Request =>
  ({ headers: authorization ? { authorization } : {} }) as unknown as Request;

const verifier = (claims?: SessionClaims): SessionClaimsVerifier => ({
  verify: async () => claims,
});

const MASTER: SessionClaims = {
  subject: 'user_01',
  role: 'master',
  tenant: 'acme',
};

const authenticate = (req: Request, verify: SessionClaimsVerifier) => {
  const { res, sent } = makeRes();

  return authenticateMcp(req, res, {
    verifier: verify,
    resourceMetadataUrl: RESOURCE_METADATA_URL,
    logger: nullLogger,
  }).then((outcome) => ({ outcome, sent }));
};

describe('bearerTokenOf', () => {
  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['Bearer   abc  ', 'abc'],
  ])(
    'MUST accept %s (RFC 6750: the scheme is case-insensitive)',
    (header, token) => {
      expect(bearerTokenOf(header)).toBe(token);
    },
  );

  it.each([undefined, '', 'abc', 'Basic abc', 'Bearer', 'Bearer    '])(
    'MUST refuse %p',
    (header) => {
      expect(bearerTokenOf(header)).toBeUndefined();
    },
  );
});

describe('the MCP door (decision 176)', () => {
  it('MUST answer 401 with a challenge that says WHERE to log in when no token is sent', async () => {
    const { outcome, sent } = await authenticate(makeReq(), verifier(MASTER));

    expect(outcome.ok).toBe(false);
    expect(sent.statusCode).toBe(401);
    expect(sent.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`,
    );
    // The wire shape, not the class: res.json serialises own-enumerable
    // properties, which is the {name, msg} contract the API publishes.
    expect(JSON.parse(JSON.stringify(sent.body))).toEqual({
      name: 'UnauthorizedError',
      msg: 'Unauthorized',
    });
  });

  it('MUST add error="invalid_token" when a token WAS sent and refused (re-authorise, not re-login)', async () => {
    const { outcome, sent } = await authenticate(
      makeReq('Bearer stale'),
      verifier(undefined),
    );

    expect(outcome.ok).toBe(false);
    expect(sent.statusCode).toBe(401);
    expect(sent.headers['www-authenticate']).toBe(
      `Bearer error="invalid_token", resource_metadata="${RESOURCE_METADATA_URL}"`,
    );
  });

  it('MUST answer 403 for a valid session without the master role', async () => {
    const { outcome, sent } = await authenticate(
      makeReq('Bearer ok'),
      verifier({ ...MASTER, role: 'member' }),
    );

    expect(outcome.ok).toBe(false);
    expect(sent.statusCode).toBe(403);
    expect(JSON.parse(JSON.stringify(sent.body))).toMatchObject({
      name: 'ForbiddenError',
    });
    // A 403 must NOT carry a challenge: logging in again changes nothing.
    expect(sent.headers['www-authenticate']).toBeUndefined();
  });

  it('MUST answer 403 for a session with no role at all', async () => {
    const { sent } = await authenticate(
      makeReq('Bearer ok'),
      verifier({ ...MASTER, role: '' }),
    );

    expect(sent.statusCode).toBe(403);
  });

  it('MUST hand the tools the subject and tenant of the verified session', async () => {
    const { outcome, sent } = await authenticate(
      makeReq('Bearer ok'),
      verifier(MASTER),
    );

    expect(outcome).toEqual({
      ok: true,
      caller: { subject: 'user_01', tenant: 'acme' },
    });
    expect(sent.statusCode).toBeUndefined();
  });
});
