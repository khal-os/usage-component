import { createLocalJWKSet, jwtVerify } from 'jose';
import type { JSONWebKeySet } from 'jose';
import { TokenAuthenticator } from '../../application/interfaces/token-authenticator.js';

export interface SessionTokenAuthenticatorOptions {
  /**
   * The khal-auth base URL (KHAL_AUTH_URL). Doubles as the expected `iss`
   * claim VERBATIM, and hosts the key set at {url}/.well-known/jwks.json.
   */
  authUrl: string;
  /** Expected `aud` claim (KHAL_TOKEN_AUDIENCE, default `tracing`). */
  audience: string;
  /** Expected `tenant` claim (KHAL_TENANT) — physical isolation doublecheck. */
  tenant: string;
  /** JWKS fetch timeout (default 3000ms — same bound the introspector used). */
  timeoutMs?: number;
}

/**
 * khal-auth SESSION validator — local RS256 verification against the JWKS
 * published at {KHAL_AUTH_URL}/.well-known/jwks.json. No introspection round
 * trip per request: the key set is fetched once and cached in memory; a
 * token naming an unknown `kid` triggers ONE re-fetch (key rotation) before
 * refusing. Identity-only — no scopes (ADR-95): a token is accepted iff
 *   - the RS256 signature verifies against a published key,
 *   - `iss` equals KHAL_AUTH_URL,
 *   - `aud` equals KHAL_TOKEN_AUDIENCE,
 *   - `tenant` equals KHAL_TENANT,
 *   - `exp` has not passed (jose refuses expired tokens by default).
 * Anything else — malformed token, JWKS unreachable/malformed, wrong any of
 * the above — answers NOT authenticated: fail closed.
 */
export class SessionTokenAuthenticator implements TokenAuthenticator {
  private readonly authUrl: string;
  private readonly audience: string;
  private readonly tenant: string;
  private readonly timeoutMs: number;
  private keySet?: ReturnType<typeof createLocalJWKSet>;
  private refreshing?: Promise<
    ReturnType<typeof createLocalJWKSet> | undefined
  >;

  constructor(options: SessionTokenAuthenticatorOptions) {
    this.authUrl = options.authUrl;
    this.audience = options.audience;
    this.tenant = options.tenant;
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  async isAuthenticated(token: string): Promise<boolean> {
    const keySet = this.keySet ?? (await this.refreshKeySet());
    // JWKS unreachable/malformed: uncached error — fail closed NOW, the
    // very next request re-fetches (an auth blip must not linger).
    if (!keySet) return false;

    const verdict = await this.verify(token, keySet);
    if (verdict !== 'unknown-kid') return verdict;

    // The token names a kid the cached set lacks — keys may have rotated
    // since the fetch. Re-fetch ONCE and retry; still unknown → refuse.
    const fresh = await this.refreshKeySet();
    if (!fresh) return false;
    return (await this.verify(token, fresh)) === true;
  }

  private async verify(
    token: string,
    keySet: ReturnType<typeof createLocalJWKSet>,
  ): Promise<boolean | 'unknown-kid'> {
    try {
      const { payload } = await jwtVerify(token, keySet, {
        algorithms: ['RS256'],
        issuer: this.authUrl,
        audience: this.audience,
      });
      return payload.tenant === this.tenant;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return code === 'ERR_JWKS_NO_MATCHING_KEY' ? 'unknown-kid' : false;
    }
  }

  /** Concurrent misses share one in-flight JWKS fetch (cold start, rotation). */
  private refreshKeySet(): Promise<
    ReturnType<typeof createLocalJWKSet> | undefined
  > {
    this.refreshing ??= this.fetchKeySet().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async fetchKeySet(): Promise<
    ReturnType<typeof createLocalJWKSet> | undefined
  > {
    try {
      const response = await fetch(
        `${this.authUrl.replace(/\/+$/, '')}/.well-known/jwks.json`,
        { signal: AbortSignal.timeout(this.timeoutMs) },
      );
      if (!response.ok) return undefined;
      const jwks = (await response.json()) as JSONWebKeySet;
      const keySet = createLocalJWKSet(jwks);
      this.keySet = keySet;
      return keySet;
    } catch {
      return undefined;
    }
  }
}
