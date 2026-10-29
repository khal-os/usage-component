/**
 * Who called the API, as its session token says (decision 184): the app the
 * token was minted for — one of KHAL_TOKEN_AUDIENCE, which decides the data
 * it opens — and the person's role. Identity, not scopes (ADR-95).
 */
export interface SessionCaller {
  /** The `aud` of the token that matched KHAL_TOKEN_AUDIENCE (e.g. `billing`). */
  readonly audience: string;
  /** `roles` claim (a single slug, e.g. `master`); empty when the token has none. */
  readonly role: string;
}

/**
 * Port for the khal-auth session gate. How a token is judged (today: local
 * JWT verification against khal-auth's JWKS) is the adapter's business; the
 * answer is the caller, or undefined for anything that does not hold.
 */
export interface TokenAuthenticator {
  authenticate(token: string): Promise<SessionCaller | undefined>;
}
