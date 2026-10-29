type ServerPort = number;

export interface ServerEnvironmentVariables {
  serverPort: ServerPort;
  /**
   * Deployment display name (the client this single-tenant instance serves),
   * injected by the stack's env — the code stays client-agnostic. Optional:
   * absent in tests/bare dev runs.
   */
  clientName?: string;
  /** REQUIRED (decision 130): the client's business timezone, IANA name. */
  clientTimezone: string;
  /**
   * The khal-auth base URL (ADR-103 spelling). Setting it turns session
   * auth ON for /api/v1 — every request must carry a Bearer session JWT
   * verified locally: RS256 against {url}/.well-known/jwks.json, iss ==
   * this URL, aud ∈ khalTokenAudiences, `tenant` claim == khalTenant, exp
   * in the future. Identity-only — no scopes. Unset → API open (PoC
   * posture, loud warn at boot).
   */
  khalAuthUrl?: string;
  /** The tenant this deployment serves — matched against the JWT's `tenant` claim. */
  khalTenant?: string;
  /**
   * Accepted `aud` values of the session JWT — a token matching ANY entry
   * passes. Parsed from comma-separated KHAL_TOKEN_AUDIENCE (default
   * `tracing,billing`: both apps read this module's data).
   */
  khalTokenAudiences: string[];
  /**
   * Decision 184: what each app's token opens — its capabilities, or `all`
   * for an app named without one (the older form of KHAL_TOKEN_AUDIENCE).
   */
  khalAudienceCapabilities: Readonly<Record<string, readonly string[] | 'all'>>;
  /** audit D-1: exact origins allowed cross-origin (comma-separated); unset = same-origin only. */
  corsAllowedOrigins?: string;
}
