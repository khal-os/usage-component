import { NextFunction, Request, Response } from 'express';
import { TokenAuthenticator } from '../../../application/interfaces/token-authenticator.js';
import { UnauthorizedError } from '../../../presentation/errors/index.js';

/** Where the gate leaves the caller for the routes' capability guard (decision 184). */
export const SESSION_CALLER = 'sessionCaller';

/**
 * Env-gated bearer auth. Built WITHOUT an authenticator (KHAL_AUTH_URL
 * unset) it is a passthrough — the API stays open, PoC behavior. Built WITH
 * one, every request must carry `Authorization: Bearer <token>` that the
 * authenticator accepts; the caller it answers is kept on `res.locals`.
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
      .authenticate(token)
      .then((caller) => {
        if (caller) {
          // decision 184: the capability guard of each route reads who called
          res.locals[SESSION_CALLER] = caller;
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
