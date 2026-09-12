/**
 * The identity behind an MCP call. The API's session gate only ever needs
 * "authenticated or not" (ADR-95, no scopes); the MCP door needs two more
 * facts: WHO is calling — the subject is written into the audit trail of a
 * month it closes — and their role, because v1 admits masters only.
 */
export interface SessionClaims {
  /** `sub` of the session token: the actor recorded on audited writes. */
  readonly subject: string;
  /** `roles` claim (a single slug in this platform, e.g. `master`). */
  readonly role: string;
  /** `tenant` claim — already matched against KHAL_TENANT by the verifier. */
  readonly tenant: string;
}

/**
 * Verifies a session token and returns its claims, or undefined for
 * ANYTHING that does not hold (signature, issuer, audience, tenant,
 * expiry, or a key source that cannot be reached) — fail closed, the
 * caller cannot tell the reasons apart and must not be able to.
 */
export interface SessionClaimsVerifier {
  verify(token: string): Promise<SessionClaims | undefined>;
}
