import {
  canonicalJson,
  decodeConfirmation,
  matchConfirmation,
  mintConfirmation,
  payloadString,
  verifyConfirmation,
  type ConfirmationPayload,
  type ExpectedConfirmation,
} from './confirmation.js';
import { fakeCodec } from './mcp-test-fakes.js';

const NOW = 1_000_000;
const codec = fakeCodec();

const expected: ExpectedConfirmation = {
  tenant: 'namastex',
  subject: 'user_01',
  action: 'register_price',
  kind: 'price',
  id: 'openai/gpt-5-mini#input',
  etag: '',
  hash: codec.sha256('request'),
};

const payload: ConfirmationPayload = {
  ...expected,
  expiresAtMs: NOW + 600_000,
};

describe('confirmation token (decision 177)', () => {
  it('MUST accept the token it minted for the same request', () => {
    const token = mintConfirmation(payload, codec);

    expect(verifyConfirmation(token, expected, NOW, codec).ok).toBe(true);
  });

  it('MUST refuse a missing token as MISSING, not as a malformed one', () => {
    expect(decodeConfirmation(undefined, codec)).toEqual({
      ok: false,
      failure: { code: 'MISSING' },
    });
    expect(decodeConfirmation('', codec)).toEqual({
      ok: false,
      failure: { code: 'MISSING' },
    });
  });

  it.each([
    ['no separator', 'onlypayload'],
    ['too many parts', 'enc(a).mac.extra'],
    [
      'payload that is not one of ours',
      `${Buffer.from('nine|fields|missing').toString('base64url')}.mac`,
    ],
  ])('MUST refuse a %s token as MALFORMED', (_case, token) => {
    expect(decodeConfirmation(token, codec)).toEqual({
      ok: false,
      failure: { code: 'MALFORMED' },
    });
  });

  it('MUST refuse a payload whose fields are not the nine it writes', () => {
    const short = 'v1|namastex|user_01|register_price|price|id';
    const forged = `${codec.encode(short)}.${codec.hmac(short)}`;

    expect(decodeConfirmation(forged, codec).ok).toBe(false);
  });

  it('MUST refuse an unknown action or kind (a token from another server shape)', () => {
    const data = payloadString(payload).replace(
      'register_price',
      'drop_database',
    );
    const forged = `${codec.encode(data)}.${codec.hmac(data)}`;

    expect(decodeConfirmation(forged, codec)).toEqual({
      ok: false,
      failure: { code: 'MALFORMED' },
    });
  });

  it('MUST refuse a token signed with another key — the MAC, not the fields, is the first gate', () => {
    const token = mintConfirmation(payload, fakeCodec('other-key'));

    expect(verifyConfirmation(token, expected, NOW, codec)).toEqual({
      ok: false,
      failure: { code: 'MISMATCH', fields: ['signature'] },
    });
  });

  it('MUST name every field that drifted between preview and confirm', () => {
    const token = mintConfirmation(payload, codec);
    const drifted = {
      ...expected,
      hash: codec.sha256('other'),
      id: 'other#input',
    };

    const result = verifyConfirmation(token, drifted, NOW, codec);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.failure).toEqual({
      code: 'MISMATCH',
      fields: ['id', 'hash'],
    });
  });

  it('MUST refuse a token issued for another user or another tenant', () => {
    const token = mintConfirmation(payload, codec);

    expect(
      verifyConfirmation(token, { ...expected, subject: 'user_02' }, NOW, codec)
        .ok,
    ).toBe(false);
    expect(
      verifyConfirmation(token, { ...expected, tenant: 'other' }, NOW, codec)
        .ok,
    ).toBe(false);
  });

  it('MUST expire exactly at expiresAtMs (the window is closed, not half-open)', () => {
    const token = mintConfirmation(payload, codec);

    expect(
      verifyConfirmation(token, expected, payload.expiresAtMs - 1, codec).ok,
    ).toBe(true);
    expect(
      verifyConfirmation(token, expected, payload.expiresAtMs, codec),
    ).toEqual({
      ok: false,
      failure: { code: 'EXPIRED' },
    });
  });

  it('MUST let a caller compare the etag AFTER its own read (two-phase match)', () => {
    // The lifecycle tools decode first, then re-read the month and compare
    // the etag themselves — so the token can never dictate what is current.
    const withEtag = {
      ...payload,
      kind: 'billing_period' as const,
      etag: 'open:v0',
    };
    const token = mintConfirmation(withEtag, codec);
    const decoded = decodeConfirmation(token, codec);

    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.payload.etag).toBe('open:v0');

    const matched = matchConfirmation(
      decoded.ok ? decoded.payload : withEtag,
      { ...withEtag, etag: 'IGNORED' },
      NOW,
      ['tenant', 'subject', 'action', 'kind', 'id', 'hash'],
    );

    expect(matched.ok).toBe(true);
  });
});

describe('canonicalJson (what the request hash covers)', () => {
  it('MUST be key-order independent so the same request always hashes the same', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('MUST keep array order — it is data, not a set', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('MUST treat an absent key and an undefined value as the same request', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('MUST distinguish values that differ only in type', () => {
    expect(canonicalJson({ a: '1' })).not.toBe(canonicalJson({ a: 1 }));
  });
});
