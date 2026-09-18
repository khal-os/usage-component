import { jwtVerify } from 'jose';
import {
  SessionClaims,
  SessionClaimsVerifier,
} from '../../application/interfaces/session-claims-verifier.js';
import { JwksKeySource, KeySet, isUnknownKidError } from './jwks-key-source.js';

export interface KhalAuthClaimsVerifierOptions {
  /** khal-auth base URL — also the expected `iss`, verbatim. */
  authUrl: string;
  /**
   * The ONE audience this door accepts (MCP_AUDIENCE). Deliberately strict,
   * unlike the audience-tolerant /api/v1 gate: an MCP server must only
   * accept tokens that were issued FOR it (RFC 8707/9728), so a token
   * minted for one of the reading apps cannot drive the operator tools.
   */
  audience: string;
  /** Expected `tenant` claim (KHAL_TENANT) — physical isolation doublecheck. */
  tenant: string;
  timeoutMs?: number;
  /** Injected in tests; production builds its own from `authUrl`. */
  keySource?: JwksKeySource;
}

const claimsOf = (
  payload: Record<string, unknown>,
  tenant: string,
): SessionClaims | undefined => {
  const subject = payload['sub'];
  const role = payload['roles'];

  // A token with no subject cannot be attributed to a person, and every
  // audited write records WHO did it — refuse instead of writing "unknown".
  if (typeof subject !== 'string' || subject.length === 0) return undefined;
  if (payload['tenant'] !== tenant) return undefined;

  return {
    subject,
    role: typeof role === 'string' ? role : '',
    tenant,
  };
};

/**
 * khal-auth session verifier for the MCP door: local RS256 verification
 * against the published JWKS, strict on `aud`, and returning the claims the
 * door needs (subject + role) instead of a boolean.
 */
export class KhalAuthClaimsVerifier implements SessionClaimsVerifier {
  private readonly authUrl: string;
  private readonly audience: string;
  private readonly tenant: string;
  private readonly keySource: JwksKeySource;

  constructor(options: KhalAuthClaimsVerifierOptions) {
    this.authUrl = options.authUrl;
    this.audience = options.audience;
    this.tenant = options.tenant;
    this.keySource =
      options.keySource ??
      new JwksKeySource({
        authUrl: options.authUrl,
        ...(options.timeoutMs !== undefined && {
          timeoutMs: options.timeoutMs,
        }),
      });
  }

  async verify(token: string): Promise<SessionClaims | undefined> {
    const keySet = await this.keySource.current();
    if (!keySet) return undefined;

    const verdict = await this.claims(token, keySet);
    if (verdict !== 'unknown-kid') return verdict;

    const fresh = await this.keySource.refresh();
    if (!fresh) return undefined;

    const retried = await this.claims(token, fresh);

    return retried === 'unknown-kid' ? undefined : retried;
  }

  private async claims(
    token: string,
    keySet: KeySet,
  ): Promise<SessionClaims | undefined | 'unknown-kid'> {
    try {
      const { payload } = await jwtVerify(token, keySet, {
        algorithms: ['RS256'],
        issuer: this.authUrl,
        audience: this.audience,
      });

      return claimsOf(payload as Record<string, unknown>, this.tenant);
    } catch (error) {
      return isUnknownKidError(error) ? 'unknown-kid' : undefined;
    }
  }
}
