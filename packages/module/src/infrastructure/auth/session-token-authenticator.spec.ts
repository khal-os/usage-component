import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import type { JSONWebKeySet, JWK, KeyLike } from 'jose';
import { SessionTokenAuthenticator } from './session-token-authenticator.js';

/**
 * Real crypto, fake transport: an RSA pair is generated in-test, tokens are
 * SIGNED with the private key, and global.fetch is stubbed to serve the
 * matching JWKS — so every acceptance below proves the actual RS256
 * verification path, not a mock of it.
 */
const AUTH_URL = 'https://auth.khal-usage.com';
// Multi-audience (comma-list KHAL_TOKEN_AUDIENCE): tokens for EITHER app
// pass — Tracing and Billing read the same module data.
const AUDIENCES = ['tracing', 'billing'];
const TENANT = 'namastex';

type KeyMaterial = {
  privateKey: KeyLike;
  publicJwk: JWK;
};

let keys: KeyMaterial;
let rogueKeys: KeyMaterial;

const makeKeys = async (kid: string): Promise<KeyMaterial> => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256' };
  return { privateKey, publicJwk };
};

beforeAll(async () => {
  keys = await makeKeys('key-1');
  rogueKeys = await makeKeys('key-1'); // same kid, DIFFERENT key material
});

const jwksOf = (...jwks: JWK[]): JSONWebKeySet => ({ keys: jwks });

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const serveJwks = (jwks: JSONWebKeySet): jest.Mock => {
  const mock = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => jwks });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
};

const signToken = async (overrides?: {
  issuer?: string;
  audience?: string;
  tenant?: string;
  expiresAt?: number;
  kid?: string;
  privateKey?: KeyLike;
}): Promise<string> => {
  const jwt = new SignJWT({ tenant: overrides?.tenant ?? TENANT })
    .setProtectedHeader({ alg: 'RS256', kid: overrides?.kid ?? 'key-1' })
    .setIssuer(overrides?.issuer ?? AUTH_URL)
    .setAudience(overrides?.audience ?? 'tracing')
    .setIssuedAt();

  if (overrides?.expiresAt !== undefined) {
    jwt.setExpirationTime(overrides.expiresAt);
  } else {
    jwt.setExpirationTime('5m');
  }

  return jwt.sign(overrides?.privateKey ?? keys.privateKey);
};

const makeSut = () =>
  new SessionTokenAuthenticator({
    authUrl: AUTH_URL,
    audiences: AUDIENCES,
    tenant: TENANT,
  });

describe('SessionTokenAuthenticator', () => {
  it('MUST accept a valid RS256 session token (right iss, aud, tenant, unexpired)', async () => {
    const mock = serveJwks(jwksOf(keys.publicJwk));

    await expect(makeSut().isAuthenticated(await signToken())).resolves.toBe(
      true,
    );
    expect(mock).toHaveBeenCalledWith(
      `${AUTH_URL}/.well-known/jwks.json`,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('MUST refuse a token signed by a different key (bad signature, same kid)', async () => {
    serveJwks(jwksOf(keys.publicJwk));

    const forged = await signToken({ privateKey: rogueKeys.privateKey });

    await expect(makeSut().isAuthenticated(forged)).resolves.toBe(false);
  });

  it('MUST refuse a wrong `iss`', async () => {
    serveJwks(jwksOf(keys.publicJwk));

    const token = await signToken({ issuer: 'https://evil.example.com' });

    await expect(makeSut().isAuthenticated(token)).resolves.toBe(false);
  });

  it('MUST accept `aud=billing` — the second configured audience (Billing app)', async () => {
    serveJwks(jwksOf(keys.publicJwk));

    const token = await signToken({ audience: 'billing' });

    await expect(makeSut().isAuthenticated(token)).resolves.toBe(true);
  });

  it('MUST refuse an `aud` outside the configured list', async () => {
    serveJwks(jwksOf(keys.publicJwk));

    const token = await signToken({ audience: 'metrics' });

    await expect(makeSut().isAuthenticated(token)).resolves.toBe(false);
  });

  it('MUST still enforce the list when it has a single entry (backward compat)', async () => {
    serveJwks(jwksOf(keys.publicJwk));

    const sut = new SessionTokenAuthenticator({
      authUrl: AUTH_URL,
      audiences: ['tracing'],
      tenant: TENANT,
    });

    await expect(
      sut.isAuthenticated(await signToken({ audience: 'tracing' })),
    ).resolves.toBe(true);
    await expect(
      sut.isAuthenticated(await signToken({ audience: 'billing' })),
    ).resolves.toBe(false);
  });

  it('MUST refuse a wrong `tenant` claim (physical isolation doublecheck)', async () => {
    serveJwks(jwksOf(keys.publicJwk));

    const token = await signToken({ tenant: 'other-tenant' });

    await expect(makeSut().isAuthenticated(token)).resolves.toBe(false);
  });

  it('MUST refuse an expired token', async () => {
    serveJwks(jwksOf(keys.publicJwk));

    const token = await signToken({
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });

    await expect(makeSut().isAuthenticated(token)).resolves.toBe(false);
  });

  it('MUST refuse garbage that is not a JWT at all', async () => {
    serveJwks(jwksOf(keys.publicJwk));

    await expect(makeSut().isAuthenticated('not-a-jwt')).resolves.toBe(false);
  });

  it('MUST cache the JWKS in memory — one fetch across many verifications', async () => {
    const mock = serveJwks(jwksOf(keys.publicJwk));
    const sut = makeSut();

    await expect(sut.isAuthenticated(await signToken())).resolves.toBe(true);
    await expect(sut.isAuthenticated(await signToken())).resolves.toBe(true);
    await expect(sut.isAuthenticated(await signToken())).resolves.toBe(true);

    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('MUST re-fetch the JWKS on an unknown `kid` (key rotation) and accept the rotated token', async () => {
    const rotated = await makeKeys('key-2');
    const mock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => jwksOf(keys.publicJwk),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => jwksOf(keys.publicJwk, rotated.publicJwk),
      });
    global.fetch = mock as unknown as typeof fetch;

    const sut = makeSut();
    // Warm the cache with the old key set…
    await expect(sut.isAuthenticated(await signToken())).resolves.toBe(true);

    // …then a token signed by the rotated key forces exactly one re-fetch.
    const rotatedToken = await signToken({
      kid: 'key-2',
      privateKey: rotated.privateKey,
    });
    await expect(sut.isAuthenticated(rotatedToken)).resolves.toBe(true);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('MUST fail closed (not cache the miss) when the JWKS endpoint is down, then recover', async () => {
    const mock = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => jwksOf(keys.publicJwk),
      });
    global.fetch = mock as unknown as typeof fetch;

    const sut = makeSut();
    const token = await signToken();

    await expect(sut.isAuthenticated(token)).resolves.toBe(false);
    // Next request re-fetches and succeeds — an auth blip never lingers.
    await expect(sut.isAuthenticated(token)).resolves.toBe(true);
  });

  it('MUST fail closed on a non-200 JWKS answer', async () => {
    const mock = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });
    global.fetch = mock as unknown as typeof fetch;

    await expect(makeSut().isAuthenticated(await signToken())).resolves.toBe(
      false,
    );
  });
});
