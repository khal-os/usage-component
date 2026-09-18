import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type { JWK, KeyLike } from 'jose';
import { JwksKeySource } from './jwks-key-source.js';
import { KhalAuthClaimsVerifier } from './session-claims-verifier.js';

/**
 * Real crypto, no network: tokens are SIGNED here and the key set is handed
 * to the verifier, so every case exercises the actual RS256 path.
 *
 * What this pins is the ONE difference from the /api/v1 gate: the MCP door
 * is audience-STRICT. The reading apps share an audience-tolerant gate; a
 * resource server must only accept tokens minted for itself (RFC 8707),
 * or any app token would drive the operator tools.
 */
const AUTH_URL = 'https://auth-dev.example.com';
const AUDIENCE = 'usage-mcp';
const TENANT = 'acme';

let keys: { privateKey: KeyLike; publicJwk: JWK };

const makeKeys = async (kid: string) => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');

  return {
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256' },
  };
};

beforeAll(async () => {
  keys = await makeKeys('key-1');
});

const sign = async (
  overrides: {
    audience?: string;
    issuer?: string;
    tenant?: string;
    roles?: string | undefined;
    subject?: string | undefined;
    privateKey?: KeyLike;
    kid?: string;
    expiresIn?: string;
  } = {},
): Promise<string> => {
  const payload: Record<string, unknown> = {
    tenant: overrides.tenant ?? TENANT,
    roles: overrides.roles ?? 'master',
  };

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: overrides.kid ?? 'key-1' })
    .setIssuer(overrides.issuer ?? AUTH_URL)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '5m');

  if (overrides.subject !== undefined) jwt.setSubject(overrides.subject);
  else if (!('subject' in overrides)) jwt.setSubject('user_01');

  return jwt.sign(overrides.privateKey ?? keys.privateKey);
};

/** A key source that answers from memory — the fetch path has its own suite. */
const sourceOf = (...jwks: JWK[]): JwksKeySource => {
  const keySet = createLocalJWKSet({ keys: jwks });

  return {
    current: async () => keySet,
    refresh: async () => keySet,
  } as unknown as JwksKeySource;
};

const makeSut = (keySource = sourceOf(keys?.publicJwk)) =>
  new KhalAuthClaimsVerifier({
    authUrl: AUTH_URL,
    audience: AUDIENCE,
    tenant: TENANT,
    keySource,
  });

describe('KhalAuthClaimsVerifier (the MCP door)', () => {
  it('MUST return the subject and role of a valid token', async () => {
    await expect(makeSut().verify(await sign())).resolves.toEqual({
      subject: 'user_01',
      role: 'master',
      tenant: TENANT,
    });
  });

  it('MUST refuse a token minted for another audience — even a valid platform one', async () => {
    await expect(
      makeSut().verify(await sign({ audience: 'tracing' })),
    ).resolves.toBeUndefined();
    await expect(
      makeSut().verify(await sign({ audience: 'billing' })),
    ).resolves.toBeUndefined();
  });

  it('MUST refuse a wrong issuer', async () => {
    await expect(
      makeSut().verify(await sign({ issuer: 'https://evil.example.com' })),
    ).resolves.toBeUndefined();
  });

  it('MUST refuse a wrong tenant (physical isolation doublecheck)', async () => {
    await expect(
      makeSut().verify(await sign({ tenant: 'other' })),
    ).resolves.toBeUndefined();
  });

  it('MUST refuse a token with no subject: an audited write needs a person to name', async () => {
    await expect(
      makeSut().verify(await sign({ subject: undefined })),
    ).resolves.toBeUndefined();
  });

  it('MUST refuse an expired token', async () => {
    await expect(
      makeSut().verify(await sign({ expiresIn: '-1m' })),
    ).resolves.toBeUndefined();
  });

  it('MUST refuse a token signed by another key with the same kid', async () => {
    const rogue = await makeKeys('key-1');

    await expect(
      makeSut().verify(await sign({ privateKey: rogue.privateKey })),
    ).resolves.toBeUndefined();
  });

  it('MUST refuse garbage that is not a JWT', async () => {
    await expect(makeSut().verify('not-a-jwt')).resolves.toBeUndefined();
  });

  it('MUST report an EMPTY role rather than inventing one (the gate then refuses it)', async () => {
    const withoutRoles = await new SignJWT({ tenant: TENANT })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(AUTH_URL)
      .setAudience(AUDIENCE)
      .setSubject('user_01')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);

    await expect(makeSut().verify(withoutRoles)).resolves.toEqual({
      subject: 'user_01',
      role: '',
      tenant: TENANT,
    });
  });

  it('MUST fail closed when the key source cannot answer', async () => {
    const dead = {
      current: async () => undefined,
      refresh: async () => undefined,
    } as unknown as JwksKeySource;

    await expect(makeSut(dead).verify(await sign())).resolves.toBeUndefined();
  });

  it('MUST retry ONCE against a refreshed key set on an unknown kid (rotation)', async () => {
    const rotated = await makeKeys('key-2');
    const stale = createLocalJWKSet({ keys: [keys.publicJwk] });
    const fresh = createLocalJWKSet({
      keys: [keys.publicJwk, rotated.publicJwk],
    });
    let refreshes = 0;
    const source = {
      current: async () => stale,
      refresh: async () => {
        refreshes += 1;
        return fresh;
      },
    } as unknown as JwksKeySource;

    const token = await sign({ kid: 'key-2', privateKey: rotated.privateKey });

    await expect(makeSut(source).verify(token)).resolves.toMatchObject({
      subject: 'user_01',
    });
    expect(refreshes).toBe(1);
  });
});
