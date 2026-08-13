import { NextFunction, Request, Response } from 'express';
import { config } from '../../infrastructure/index.js';
import { SessionTokenAuthenticator } from '../../infrastructure/auth/session-token-authenticator.js';
import { buildAuthMiddleware } from '../server/middlewares/index.js';
import { makeLogger } from './logger-factory.js';

/**
 * Session auth on /api/v1 (replaces the interim Basic gate, decision 141 —
 * the BASIC_AUTH_* knobs are GONE, not aliased). ON when KHAL_AUTH_URL is
 * set: every request must carry a khal-auth session JWT, verified locally
 * against {KHAL_AUTH_URL}/.well-known/jwks.json (RS256; iss/aud/tenant/exp
 * — see SessionTokenAuthenticator). Identity-only, no scopes (ADR-95).
 * UNSET → API OPEN, PoC posture (decision 133 style) — warned loudly at
 * boot so an open archive is never a silent accident.
 */
export const makeAuthMiddleware = (): ((
  req: Request,
  res: Response,
  next: NextFunction,
) => void) => {
  const authLogger = makeLogger({ component: 'auth' });

  const authUrl = config.khalAuthUrl;
  if (!authUrl) {
    authLogger.warn(
      'KHAL_AUTH_URL is unset — /api/v1 is OPEN (PoC posture). Never expose ' +
        'an open API beyond loopback; set KHAL_AUTH_URL to turn session ' +
        'auth on',
    );
    return buildAuthMiddleware(undefined);
  }

  const tenant = config.khalTenant;
  if (!tenant) {
    // Unreachable by env-schema construction (the refine requires the
    // pair); guarded anyway — auth was INTENDED, so fail closed (every
    // /api/v1 request answers 401), never silently open.
    authLogger.error(
      'KHAL_AUTH_URL is set but KHAL_TENANT is not — the tenant claim ' +
        'cannot be checked, so every /api/v1 request will answer 401 ' +
        '(fail closed)',
    );
    return buildAuthMiddleware({ isAuthenticated: async () => false });
  }

  return buildAuthMiddleware(
    new SessionTokenAuthenticator({
      authUrl,
      audience: config.khalTokenAudience,
      tenant,
    }),
  );
};
