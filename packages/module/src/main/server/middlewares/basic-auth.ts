import { createHash, timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../../../presentation/errors/index.js';

export interface BasicAuthCredentials {
  user: string;
  password: string;
}

/**
 * INTERIM edge gate (decision 141): env-gated HTTP Basic auth for /api/v1
 * until the deployment points at the khal platform — then the KHAL_*
 * quartet replaces it and these knobs are DELETED (the env schema refuses
 * both configured at once, so the switchover is explicit).
 *
 * Built without credentials it is a passthrough (dev/tests). Docs stay
 * open — they are mounted before middlewares in app.ts (decision 103, the
 * healthcheck surface). Same 401 semantics as the bearer middleware; the
 * WWW-Authenticate challenge makes browsers prompt, which is exactly what
 * the interim dashboard users need.
 */
export const buildBasicAuthMiddleware = (
  credentials?: BasicAuthCredentials,
) => {
  if (!credentials) {
    return (_req: Request, _res: Response, next: NextFunction) => {
      next();
    };
  }

  // Constant-time comparison (timing-safe even on length mismatch: compare
  // fixed-size digests, never the raw strings).
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expectedUser = digest(credentials.user);
  const expectedPassword = digest(credentials.password);
  const matches = (value: string, expected: Buffer) =>
    timingSafeEqual(digest(value), expected);

  return (req: Request, res: Response, next: NextFunction): void => {
    // CORS preflights carry no Authorization header by design.
    if (req.method === 'OPTIONS') {
      next();
      return;
    }

    const refuse = () => {
      res
        .set('WWW-Authenticate', 'Basic realm="usage-component"')
        .status(401)
        .json(new UnauthorizedError());
    };

    // RFC 7235: the auth-scheme is case-insensitive.
    const header = req.headers.authorization;
    const encoded = header?.match(/^Basic\s+(.+)$/i)?.[1];

    if (!encoded) {
      refuse();
      return;
    }

    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    // Split at the FIRST colon only — RFC 7617 allows colons in passwords.
    const separator = decoded.indexOf(':');

    if (separator < 0) {
      refuse();
      return;
    }

    const user = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    // BOTH comparisons evaluate before combining (no short-circuit), so a
    // wrong user costs the same time as a wrong password.
    const userOk = matches(user, expectedUser);
    const passwordOk = matches(password, expectedPassword);

    if (userOk && passwordOk) {
      next();
      return;
    }

    refuse();
  };
};
