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
  /**
   * Decision 184: the `capabilities` claim — what this person reaches of the
   * module, as khal-auth computed it from the apps they received
   * (khal-platform ADR-163). Absent = the claim is not there (Permissões off
   * or shadow); a claim that is not a list of strings reads as an empty one,
   * which opens nothing (a failure closes).
   */
  readonly capabilities?: readonly string[];
  /**
   * Decision 185: the token carries the `org` claim, so Permissões is in
   * enforce and khal-auth already decided this person reaches the module
   * (khal-platform ADR-164). Absent in off and shadow.
   */
  readonly enforced?: true;
  /**
   * Decision 185: what this person may do in the module, as LOCAL ability ids
   * (`area.action`), the token's prefix removed. Absent = the claim is not
   * there, and nothing is restricted by ability; a claim that is not a list of
   * strings reads as an empty one, which opens nothing (a failure closes).
   */
  readonly abilities?: readonly string[];
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
