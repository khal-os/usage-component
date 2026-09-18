import { jwtVerify } from 'jose';
import { TokenAuthenticator } from '../../application/interfaces/token-authenticator.js';
import { JwksKeySource, KeySet, isUnknownKidError } from './jwks-key-source.js';

export interface SessionTokenAuthenticatorOptions {
  /**
   * The khal-auth base URL (KHAL_AUTH_URL). Doubles as the expected `iss`
   * claim VERBATIM, and hosts the key set at {url}/.well-known/jwks.json.
   */
  authUrl: string;
  /**
   * Accepted `aud` claims (KHAL_TOKEN_AUDIENCE parsed as a comma-separated
   * list, default `tracing,billing`) — a token matching ANY entry passes.
   */
  audiences: string[];
  /** Expected `tenant` claim (KHAL_TENANT) — physical isolation doublecheck. */
  tenant: string;
  /** JWKS fetch timeout (default 3000ms — same bound the introspector used). */
  timeoutMs?: number;
  /** Injected in tests; production builds its own from `authUrl`. */
  keySource?: JwksKeySource;
}

/**
 * khal-auth SESSION validator — local RS256 verification against the JWKS
 * published at {KHAL_AUTH_URL}/.well-known/jwks.json. No introspection round
 * trip per request: the key set is fetched once and cached in memory; a
 * token naming an unknown `kid` triggers ONE re-fetch (key rotation) before
 * refusing. Identity-only — no scopes (ADR-95): a token is accepted iff
 *   - the RS256 signature verifies against a published key,
 *   - `iss` equals KHAL_AUTH_URL,
 *   - `aud` matches ANY entry of KHAL_TOKEN_AUDIENCE (multi-audience: the
 *     Tracing AND Billing apps read this same module's data),
 *   - `tenant` equals KHAL_TENANT,
 *   - `exp` has not passed (jose refuses expired tokens by default).
 * Anything else — malformed token, JWKS unreachable/malformed, wrong any of
 * the above — answers NOT authenticated: fail closed.
 */
export class SessionTokenAuthenticator implements TokenAuthenticator {
  private readonly authUrl: string;
  private readonly audiences: string[];
  private readonly tenant: string;
  // The key set lives in JwksKeySource; the composition root hands BOTH doors
  // (this gate and the MCP endpoint) the same instance, so there is one cache,
  // one refresh policy and one spelling of "the JWKS moved" — the same reason
  // the log and mongo env readers live in core. A caller that constructs this
  // without one gets its own, which is what the unit suite does.
  private readonly keySource: JwksKeySource;

  constructor(options: SessionTokenAuthenticatorOptions) {
    this.authUrl = options.authUrl;
    this.audiences = options.audiences;
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

  async isAuthenticated(token: string): Promise<boolean> {
    const keySet = await this.keySource.current();
    // JWKS unreachable/malformed: uncached error — fail closed NOW, the
    // very next request re-fetches (an auth blip must not linger).
    if (!keySet) return false;

    const verdict = await this.verify(token, keySet);
    if (verdict !== 'unknown-kid') return verdict;

    // The token names a kid the cached set lacks — keys may have rotated
    // since the fetch. Re-fetch ONCE and retry; still unknown → refuse.
    const fresh = await this.keySource.refresh();
    if (!fresh) return false;
    return (await this.verify(token, fresh)) === true;
  }

  private async verify(
    token: string,
    keySet: KeySet,
  ): Promise<boolean | 'unknown-kid'> {
    try {
      const { payload } = await jwtVerify(token, keySet, {
        algorithms: ['RS256'],
        issuer: this.authUrl,
        // jose accepts an array natively: the token's `aud` must match ANY.
        audience: this.audiences,
      });
      return payload.tenant === this.tenant;
    } catch (error) {
      return isUnknownKidError(error) ? 'unknown-kid' : false;
    }
  }
}
