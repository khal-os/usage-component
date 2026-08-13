/**
 * Port for the khal-auth session gate. The application layer sees only
 * authenticated-or-not — identity-only, no scopes (ADR-95). How a token is
 * judged (today: local JWT verification against khal-auth's JWKS) is the
 * adapter's business.
 */
export interface TokenAuthenticator {
  isAuthenticated(token: string): Promise<boolean>;
}
