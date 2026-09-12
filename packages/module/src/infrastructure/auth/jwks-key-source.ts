import { createLocalJWKSet } from 'jose';
import type { JSONWebKeySet } from 'jose';

export type KeySet = ReturnType<typeof createLocalJWKSet>;

/**
 * The khal-auth key set, fetched once and cached in memory — extracted so
 * the two doors that verify a session token (the /api/v1 gate and the MCP
 * endpoint) share ONE cache and one refresh policy instead of two copies
 * that drift. Concurrent misses share a single in-flight fetch; a token
 * naming an unknown `kid` triggers exactly one re-fetch (key rotation)
 * before the caller refuses it.
 *
 * Every failure answers `undefined` and caches nothing: an auth blip must
 * not linger past the request that hit it.
 */
export class JwksKeySource {
  private readonly jwksUrl: string;
  private readonly timeoutMs: number;
  private keySet?: KeySet;
  private refreshing?: Promise<KeySet | undefined>;

  constructor(args: { authUrl: string; timeoutMs?: number }) {
    this.jwksUrl = `${args.authUrl.replace(/\/+$/, '')}/.well-known/jwks.json`;
    this.timeoutMs = args.timeoutMs ?? 3000;
  }

  /** The cached set, fetching it on the first call. */
  current(): Promise<KeySet | undefined> {
    return this.keySet ? Promise.resolve(this.keySet) : this.refresh();
  }

  /** Forces a re-fetch — the unknown-kid path, and only that path. */
  refresh(): Promise<KeySet | undefined> {
    this.refreshing ??= this.fetchKeySet().finally(() => {
      this.refreshing = undefined;
    });

    return this.refreshing;
  }

  private async fetchKeySet(): Promise<KeySet | undefined> {
    try {
      const response = await fetch(this.jwksUrl, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });

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

/** jose's signal for "this token names a key the set does not have". */
export const isUnknownKidError = (error: unknown): boolean =>
  (error as { code?: unknown }).code === 'ERR_JWKS_NO_MATCHING_KEY';
