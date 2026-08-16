import express from 'express';
import request from 'supertest';
import { corsMiddleware } from './index.js';
import { originAllowedBy, parseAllowedOrigins } from './cors.js';

/**
 * Same-origin by design (audit D-1). The OLD suite pinned the wildcard —
 * "MUST allow CORS requests from any origin" — which made an exfiltration
 * vector look intentional: with auth off (PoC default), `ACAO: *` let any
 * web page a LAN operator visited read the unmasked archive through the
 * operator's own browser. These tests pin the inverse.
 */
const app = express();
app.use(corsMiddleware);
app.get('/test-cors', (_req, res) => {
  res.json({});
});

describe('CORS Middleware', () => {
  it('MUST NOT emit any allow-origin header when CORS_ALLOWED_ORIGINS is unset — same-origin only', async () => {
    const response = await request(app)
      .get('/test-cors')
      .set('Origin', 'https://evil.example');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-methods']).toBeUndefined();
  });

  it('MUST NOT echo an arbitrary Origin back', async () => {
    const response = await request(app)
      .get('/test-cors')
      .set('Origin', 'http://attacker.internal:8080');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

/**
 * The list itself is parsed once at boot, so the rules are tested as the
 * pure functions they are rather than through a re-imported module.
 *
 * The wildcard-subdomain pattern (decision 149) exists because everything
 * of a client lives under that client's own domain, so a hand-kept
 * per-origin list would be maintenance with no security value — the JWT is
 * the boundary. What it must NOT become is a sloppy suffix match.
 */
describe('CORS allow-list rules', () => {
  const allows = (list: string, origin: string) =>
    originAllowedBy(parseAllowedOrigins(list))(origin);

  it('matches an exact origin', () => {
    expect(allows('https://app.example.com', 'https://app.example.com')).toBe(
      true,
    );
    expect(allows('https://app.example.com', 'https://other.example.com')).toBe(
      false,
    );
  });

  it('matches exactly ONE label under a wildcard-subdomain pattern', () => {
    expect(allows('https://*.example.com', 'https://api.example.com')).toBe(
      true,
    );
    expect(allows('https://*.example.com', 'https://console.example.com')).toBe(
      true,
    );
    // Like DNS and ACM: the wildcard covers one label, not a subtree.
    expect(allows('https://*.example.com', 'https://a.b.example.com')).toBe(
      false,
    );
    // The apex is not its own subdomain.
    expect(allows('https://*.example.com', 'https://example.com')).toBe(false);
  });

  it('MUST NOT match a look-alike domain', () => {
    // The whole reason this is a parser and not `endsWith('.example.com')`
    // — an attacker registers the look-alike, not the subdomain.
    expect(allows('https://*.example.com', 'https://evil-example.com')).toBe(
      false,
    );
    expect(
      allows('https://*.example.com', 'https://api.example.com.evil.net'),
    ).toBe(false);
  });

  it('mixes exact origins and patterns in one list', () => {
    const list = 'https://*.example.com, https://desktop.khal.ai';
    expect(allows(list, 'https://api.example.com')).toBe(true);
    expect(allows(list, 'https://desktop.khal.ai')).toBe(true);
    expect(allows(list, 'https://desktop.evil.ai')).toBe(false);
  });

  it('refuses a bare wildcard at BOOT, not at request time', () => {
    expect(() => parseAllowedOrigins('*')).toThrow(/must not contain "\*"/);
    expect(() => parseAllowedOrigins('https://a.example.com,*')).toThrow();
  });

  it('refuses http and malformed entries at boot', () => {
    expect(() => parseAllowedOrigins('http://*.example.com')).toThrow(
      /not https/,
    );
    expect(() => parseAllowedOrigins('https://app.example.com/')).toThrow(
      /no path/,
    );
    expect(() => parseAllowedOrigins('https://*.*.example.com')).toThrow();
    expect(() => parseAllowedOrigins('https://ap*.example.com')).toThrow(
      /leftmost label/,
    );
  });

  it('treats an unset list as same-origin only', () => {
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(allows('', 'https://anything.example.com')).toBe(false);
  });
});
