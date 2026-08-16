import { NextFunction, Request, Response } from 'express';
import { config } from '../../../infrastructure/index.js';

/**
 * Same-origin by design (audit D-1): the shipped UI is served by nginx,
 * which proxies /api on the SAME origin — its own config says "no CORS,
 * no discovery" — and the platform integrates M2M server-side. The old
 * middleware sent `Access-Control-Allow-Origin: *` unconditionally, which
 * turned every browser into an exfiltration proxy for the unmasked
 * archive: with auth off (the PoC default) and the dashboard reachable on
 * a LAN, any web page the operator visited could fetch /api/v1/traces and
 * POST the transcripts offsite — the browser was the reachability.
 *
 * Cross-origin access is an EXPLICIT operator act: CORS_ALLOWED_ORIGINS
 * (comma-separated) echoes a matching Origin back — never a wildcard —
 * with Vary: Origin for caches. Unset, no CORS header exists and browsers
 * enforce same-origin.
 *
 * Each entry is either an exact origin (`https://app.example.com`) or a
 * wildcard-subdomain PATTERN (`https://*.example.com`), mixed freely — a
 * tenant may have a second custom domain. The pattern exists because
 * everything of a client lives under that client's own domain (decision
 * 149), so a hand-kept per-origin list would be pure maintenance; the AWS
 * task-def renderer defaults the value to `https://*.<BASE_DOMAIN>` when
 * the tenant file leaves it empty.
 *
 * The wildcard matches EXACTLY ONE label, like DNS and ACM: `https://*.
 * example.com` covers `https://api.example.com` but not
 * `https://a.b.example.com`, and — the reason this is a parser and not a
 * `String.endsWith` — not the look-alike `https://evil-example.com`.
 *
 * Auth is `Authorization: Bearer` (no cookies, no Allow-Credentials): the
 * JWT is the security boundary. CORS only ever mattered for the OPEN-API
 * posture, which stays locked.
 */

type OriginRule =
  { kind: 'exact'; origin: string } | { kind: 'suffix'; domain: string };

/**
 * Parsed at module load, so a bad list is a BOOT failure and not a
 * surprise on the first cross-origin request (decision 139).
 */
export const parseAllowedOrigins = (raw: string): OriginRule[] =>
  raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      // A bare `*` is the exfiltration vector this middleware was written
      // to remove; refusing it here keeps it from coming back as config.
      if (entry === '*') {
        throw new Error(
          'CORS_ALLOWED_ORIGINS must not contain "*" — a wildcard origin turns every browser into a proxy for the unmasked archive (audit D-1)',
        );
      }
      if (!entry.startsWith('https://')) {
        throw new Error(
          `CORS_ALLOWED_ORIGINS entry "${entry}" is not https — an http origin cannot be trusted with the archive`,
        );
      }

      const host = entry.slice('https://'.length);
      if (host.length === 0 || host.includes('/')) {
        throw new Error(
          `CORS_ALLOWED_ORIGINS entry "${entry}" must be an origin: scheme and host only, no path and no trailing slash`,
        );
      }

      if (host.startsWith('*.')) {
        const domain = host.slice(2);
        if (domain.length === 0 || domain.includes('*')) {
          throw new Error(
            `CORS_ALLOWED_ORIGINS entry "${entry}" is not a valid wildcard-subdomain pattern (https://*.<domain>)`,
          );
        }
        return { kind: 'suffix', domain };
      }

      if (host.includes('*')) {
        throw new Error(
          `CORS_ALLOWED_ORIGINS entry "${entry}" may only use "*" as the leftmost label (https://*.<domain>)`,
        );
      }

      return { kind: 'exact', origin: entry };
    });

export const originAllowedBy =
  (rules: OriginRule[]) =>
  (origin: string): boolean =>
    rules.some((rule) => {
      if (rule.kind === 'exact') return rule.origin === origin;
      if (!origin.startsWith('https://')) return false;
      const host = origin.slice('https://'.length);
      // Exactly one label, and a real dot separator — so
      // `evil-example.com` does not match `*.example.com`.
      const separator = host.length - rule.domain.length - 1;
      return (
        separator > 0 &&
        host[separator] === '.' &&
        host.slice(separator + 1) === rule.domain &&
        !host.slice(0, separator).includes('.')
      );
    });

const rules = parseAllowedOrigins(config.corsAllowedOrigins ?? '');
const isAllowed = originAllowedBy(rules);

export const corsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const origin = req.headers.origin;

  if (origin && isAllowed(origin)) {
    // The EXACT request origin is echoed, never the pattern — a pattern in
    // Allow-Origin is not a valid header value and browsers reject it.
    res.set('access-control-allow-origin', origin);
    res.set('access-control-allow-methods', 'GET,POST');
    res.set('access-control-allow-headers', 'Content-Type, Authorization');
  }

  // Caches must never serve one origin's answer to another.
  if (rules.length > 0) {
    res.set('vary', 'Origin');
  }

  next();
};
