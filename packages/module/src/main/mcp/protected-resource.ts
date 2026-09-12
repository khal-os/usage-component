import { Application, Request, Response } from 'express';
import { OAuthProtectedResourceMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';

export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

/**
 * RFC 9728 §3.1 path-inserted well-known URI: for a resource served at
 * `/mcp`, the metadata lives at `/.well-known/oauth-protected-resource/mcp`.
 * Clients differ on which one they try (older ones ask for the bare path),
 * so both are served with the same document.
 */
export const resourceMetadataUrlOf = (canonicalUrl: string): string => {
  const url = new URL(canonicalUrl);
  const suffix = url.pathname.replace(/\/+$/, '');

  return `${url.origin}${PROTECTED_RESOURCE_PATH}${suffix}`;
};

export interface ProtectedResourceOptions {
  /** MCP_CANONICAL_URL — the RFC 8707 resource identifier of this endpoint. */
  readonly canonicalUrl: string;
  /** KHAL_AUTH_URL — the authorization server that mints tokens for it. */
  readonly authorizationServer: string;
  readonly resourceName: string;
}

/**
 * The document that tells an MCP client where to log in. No
 * `scopes_supported`: this platform retired scopes (ADR-95), identity is
 * the whole authorization story plus the role gate.
 */
export const protectedResourceDocument = (
  options: ProtectedResourceOptions,
): Record<string, unknown> =>
  OAuthProtectedResourceMetadataSchema.parse({
    resource: options.canonicalUrl,
    authorization_servers: [options.authorizationServer],
    bearer_methods_supported: ['header'],
    resource_name: options.resourceName,
  }) as Record<string, unknown>;

/**
 * Registered OUTSIDE the session gate on purpose: a client that has no
 * token yet is exactly who reads this. Cached briefly — it changes only
 * when the deployment does.
 */
export const registerProtectedResourceRoutes = (
  app: Application,
  options: ProtectedResourceOptions,
): void => {
  const document = protectedResourceDocument(options);
  const paths = [
    ...new Set([
      PROTECTED_RESOURCE_PATH,
      new URL(resourceMetadataUrlOf(options.canonicalUrl)).pathname,
    ]),
  ];

  for (const path of paths) {
    app.get(path, (_req: Request, res: Response) => {
      res.set('cache-control', 'public, max-age=300');
      res.status(200).json(document);
    });
  }
};
