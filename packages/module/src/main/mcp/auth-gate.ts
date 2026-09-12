import { Request, Response } from 'express';
import { Logger } from '@observability/core/common/logging/logger.js';
import { SessionClaimsVerifier } from '../../application/interfaces/session-claims-verifier.js';
import { ToolCaller } from '../../presentation/mcp/tool-definition.js';
import {
  ForbiddenError,
  UnauthorizedError,
} from '../../presentation/errors/index.js';

/** v1 admits masters only (decision 176) — the same bar the platform's console writes have. */
export const REQUIRED_ROLE = 'master';

export interface McpAuthOptions {
  readonly verifier: SessionClaimsVerifier;
  /** RFC 9728 metadata url advertised in the 401 challenge. */
  readonly resourceMetadataUrl: string;
  readonly logger: Logger;
}

/** RFC 6750 §2.1: the scheme is case-insensitive, the token is not. */
export const bearerTokenOf = (header: string | undefined): string | undefined =>
  header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || undefined;

/**
 * RFC 9728 §5.1: the challenge points the client at the metadata naming its
 * authorization server — that is how a desktop client knows WHERE to log
 * in. RFC 6750 §3.1: a request that carried a token that was refused also
 * says `error="invalid_token"`, which is how the client tells "go log in"
 * from "your token is not good here" instead of looping.
 */
const challenge = (resourceMetadataUrl: string, hadToken: boolean): string =>
  hadToken
    ? `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`
    : `Bearer resource_metadata="${resourceMetadataUrl}"`;

export type AuthOutcome =
  { readonly ok: true; readonly caller: ToolCaller } | { readonly ok: false };

/**
 * The door of the MCP endpoint. Answers directly (never `next(err)`): the
 * error boundary flattens middleware 4xx into 400, and a client that gets
 * 400 instead of 401 never learns it has to log in.
 */
export const authenticateMcp = async (
  req: Request,
  res: Response,
  options: McpAuthOptions,
): Promise<AuthOutcome> => {
  const token = bearerTokenOf(req.headers.authorization);

  if (!token) {
    res
      .status(401)
      .set('www-authenticate', challenge(options.resourceMetadataUrl, false))
      .json(new UnauthorizedError());

    return { ok: false };
  }

  const claims = await options.verifier.verify(token);

  if (!claims) {
    options.logger.warn('mcp: session token refused');
    res
      .status(401)
      .set('www-authenticate', challenge(options.resourceMetadataUrl, true))
      .json(new UnauthorizedError());

    return { ok: false };
  }

  if (claims.role !== REQUIRED_ROLE) {
    options.logger.warn('mcp: role not allowed', { role: claims.role });
    res
      .status(403)
      .json(
        new ForbiddenError(
          `The MCP endpoint requires the ${REQUIRED_ROLE} role (decision 176).`,
        ),
      );

    return { ok: false };
  }

  return {
    ok: true,
    caller: { subject: claims.subject, tenant: claims.tenant },
  };
};
