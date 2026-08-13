import { NextFunction, Request, Response } from 'express';
import { TokenAuthenticator } from '../../../application/interfaces/token-authenticator.js';
import { UnauthorizedError } from '../../../presentation/errors/index.js';

/**
 * Env-gated bearer auth. Built WITHOUT an authenticator (KHAL_AUTH_URL
 * unset) it is a passthrough — the API stays open, PoC behavior. Built WITH
 * one, every request must carry `Authorization: Bearer <token>` that the
 * authenticator accepts (authenticated-or-not only).
 *
 * Failures answer 401 directly — never next(err): the error boundary
 * flattens middleware 4xx into 400 InvalidParamError('body').
 */
export const buildAuthMiddleware = (authenticator?: TokenAuthenticator) => {
  if (!authenticator) {
    return (_req: Request, _res: Response, next: NextFunction) => {
      next();
    };
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    // CORS preflights carry no Authorization header by design.
    if (req.method === 'OPTIONS') {
      next();
      return;
    }

    // RFC 7235: the auth-scheme is case-insensitive — `bearer x` is as
    // valid as `Bearer x` (C-4.3).
    const header = req.headers.authorization;
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!token) {
      res.status(401).json(new UnauthorizedError());
      return;
    }

    authenticator
      .isAuthenticated(token)
      .then((authenticated) => {
        if (authenticated) {
          next();
          return;
        }
        res.status(401).json(new UnauthorizedError());
      })
      .catch(() => {
        // The adapter already fails closed; this guards a misbehaving port.
        res.status(401).json(new UnauthorizedError());
      });
  };
};
