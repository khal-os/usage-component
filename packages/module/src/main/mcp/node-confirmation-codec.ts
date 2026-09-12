import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ConfirmationCodec } from '../../presentation/mcp/confirmation.js';

const BASE64URL = /^[\w-]*$/;

/**
 * The crypto behind a confirmation token, at the composition root: node's
 * HMAC-SHA256 (hex) under MCP_CONFIRMATION_KEY, SHA-256 (hex) for the
 * request hash, a constant-time compare, and base64url for the payload.
 * The token logic itself stays pure (presentation/mcp/confirmation.ts).
 */
export const makeNodeConfirmationCodec = (key: string): ConfirmationCodec => ({
  hmac: (data) => createHmac('sha256', key).update(data, 'utf8').digest('hex'),
  sha256: (data) => createHash('sha256').update(data, 'utf8').digest('hex'),
  equals: (a, b) => {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');

    // Length is compared first because timingSafeEqual throws on a mismatch;
    // the length of a MAC is not a secret.
    return left.length === right.length && timingSafeEqual(left, right);
  },
  encode: (text) => Buffer.from(text, 'utf8').toString('base64url'),
  decode: (encoded) => {
    if (!BASE64URL.test(encoded)) return undefined;

    const text = Buffer.from(encoded, 'base64url').toString('utf8');

    // Buffer tolerates stray bits: only what re-encodes to the input was ours.
    return Buffer.from(text, 'utf8').toString('base64url') === encoded
      ? text
      : undefined;
  },
});
