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
   * The silo's discovery base URL (ADR-97 — the khal-wide canonical surface,
   * the ONLY auth config since decision 133): with khalTenant, the Auth
   * System URL is RESOLVED at runtime from
   * GET {url}/.well-known/registers?tenant={tenant}. Setting it turns auth
   * ON for /api/v1 — every request must carry a Bearer token the Auth
   * System accepts (introspection — authenticated-or-not only; the module
   * never inspects claims, scopes or tenant). Unset → API open (PoC
   * behavior).
   */
  khalDiscoveryUrl?: string;
  /** The tenant this deployment belongs to (discovery doublecheck). */
  khalTenant?: string;
  /** audit D-1: exact origins allowed cross-origin (comma-separated); unset = same-origin only. */
  corsAllowedOrigins?: string;
  /**
   * This module's own M2M credential — the Auth System's /introspect is a
   * protected endpoint (RFC 7662): the module must authenticate itself
   * (Basic) to ask "is this token active". Without it every introspection
   * fails closed (all requests 401).
   */
  khalClientId?: string;
  khalClientSecret?: string;
  /**
   * Decision 141: INTERIM HTTP Basic gate for /api/v1 until the KHAL
   * quartet points at real infra — then these are DELETED (the env schema
   * refuses both at once). Set together or not at all.
   */
  basicAuthUser?: string;
  basicAuthPassword?: string;
}
