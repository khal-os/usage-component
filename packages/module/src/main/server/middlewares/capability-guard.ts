import { NextFunction, Request, Response } from 'express';
import { SessionCaller } from '../../../application/interfaces/token-authenticator.js';
import { Capability } from '../../../presentation/capabilities.js';
import { ForbiddenError } from '../../../presentation/errors/index.js';
import { SESSION_CALLER } from './auth.js';

/**
 * What each app's token opens (decision 184), from KHAL_TOKEN_AUDIENCE:
 * `tracing:tracing.sessions` maps the Tracing app to the tracing data;
 * a bare `tracing` (the older form) opens everything, and the boot says so.
 */
export type AudienceCapabilities = Readonly<
  Record<string, readonly string[] | 'all'>
>;

export interface CapabilityRule {
  /** The data the route serves. */
  readonly capability: Capability;
  /** A write that only the Khal team makes (registering a price). */
  readonly masterOnly?: boolean;
}

const opens = (
  map: AudienceCapabilities,
  caller: SessionCaller,
  rule: CapabilityRule,
): boolean => {
  const allowed = map[caller.audience];
  if (allowed === undefined) return false;
  const data = allowed === 'all' || allowed.includes(rule.capability);
  return data && (rule.masterOnly !== true || caller.role === 'master');
};

/**
 * Decision 184: each route serves the data of one capability, and a token
 * opens only the capabilities of the app it was minted for. With the gate
 * off (no KHAL_AUTH_URL) there is no caller, and the API stays open, as
 * before. A refusal is 403 — the token is fine, the data is not its app's.
 */
export const buildCapabilityGuard =
  (map: AudienceCapabilities) =>
  (rule: CapabilityRule) =>
  (_req: Request, res: Response, next: NextFunction): void => {
    const caller = res.locals[SESSION_CALLER] as SessionCaller | undefined;
    if (caller === undefined || opens(map, caller, rule)) {
      next();
      return;
    }
    res
      .status(403)
      .json(new ForbiddenError("This token's app does not read this data."));
  };
