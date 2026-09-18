import { makeNodeConfirmationCodec } from './node-confirmation-codec.js';

// qcia:allow-secret — test stub
const KEY = 'unit-test-key-with-more-than-32-characters';

const codec = makeNodeConfirmationCodec(KEY);

describe('node confirmation codec', () => {
  it('MUST round-trip a payload through encode/decode', () => {
    const data =
      'v1|acme|user_01|close_period|billing_period|2026-06|open:v0||1757592600000';

    expect(codec.decode(codec.encode(data))).toBe(data);
  });

  it('MUST produce a token body free of the separator a token is split on', () => {
    // An ISO timestamp inside the payload contains dots; base64url never
    // does, which is what keeps `payload.mac` unambiguous.
    expect(codec.encode('2026-06-01T00:00:00.000Z')).not.toContain('.');
  });

  it('MUST refuse anything it did not encode', () => {
    expect(codec.decode('not base64url!!')).toBeUndefined();
    // Padded base64 is not base64URL — this codec never produces '='.
    expect(codec.decode('YQ==')).toBeUndefined();
  });

  it('MUST bind the MAC to both the key and the data', () => {
    const other = makeNodeConfirmationCodec(
      'another-key-with-more-than-32-chars!!',
    );

    expect(codec.hmac('data')).not.toBe(other.hmac('data'));
    expect(codec.hmac('data')).not.toBe(codec.hmac('datb'));
    expect(codec.hmac('data')).toBe(codec.hmac('data'));
  });

  it('MUST compare in constant time without throwing on different lengths', () => {
    expect(codec.equals('abc', 'abc')).toBe(true);
    expect(codec.equals('abc', 'abd')).toBe(false);
    expect(codec.equals('abc', 'abcd')).toBe(false);
    expect(codec.equals('', '')).toBe(true);
  });

  it('MUST hash a request deterministically', () => {
    expect(codec.sha256('{"a":1}')).toBe(codec.sha256('{"a":1}'));
    expect(codec.sha256('{"a":1}')).not.toBe(codec.sha256('{"a":2}'));
  });
});
