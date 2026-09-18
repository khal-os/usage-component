/**
 * The MCP endpoint knobs (T12, decision 175). OPT-IN by construction: with
 * `mcpCanonicalUrl` unset no MCP route is mounted at all, so every existing
 * deployment keeps booting exactly as before. Set, it drags the whole
 * contract with it — the env schema refuses the boot when any piece is
 * missing, because a half-configured MCP door would either answer 401 to
 * everyone or, worse, answer to the wrong audience.
 */
export interface McpEnvironmentVariables {
  /**
   * PUBLIC url of the endpoint, pathname exactly `/mcp` — it is the RFC
   * 8707 resource identifier and the RFC 9728 `resource` this server
   * publishes, so it must be the URL clients actually post to (behind the
   * ingress, not the pod address).
   */
  mcpCanonicalUrl?: string;
  /** HMAC key of the confirmation tokens (decision 177) — at least 32 chars. */
  mcpConfirmationKey?: string;
  /**
   * The ONE `aud` this endpoint accepts. Declared, never inferred: it is
   * minted by khal-auth for this resource, and a wrong guess would either
   * reject every token or accept one issued for another surface.
   */
  mcpAudience?: string;
}
