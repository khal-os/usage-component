import {
  PROTECTED_RESOURCE_PATH,
  protectedResourceDocument,
  resourceMetadataUrlOf,
} from './protected-resource.js';

const CANONICAL = 'https://api-dev.example.com/mcp';
const AUTH = 'https://auth-dev.example.com';

describe('RFC 9728 protected-resource metadata', () => {
  it('MUST insert the resource path into the well-known url (§3.1)', () => {
    expect(resourceMetadataUrlOf(CANONICAL)).toBe(
      `https://api-dev.example.com${PROTECTED_RESOURCE_PATH}/mcp`,
    );
  });

  it('MUST tolerate a trailing slash on the canonical url', () => {
    expect(resourceMetadataUrlOf(`${CANONICAL}/`)).toBe(
      `https://api-dev.example.com${PROTECTED_RESOURCE_PATH}/mcp`,
    );
  });

  it('MUST publish the resource, its authorization server and the header method', () => {
    const document = protectedResourceDocument({
      canonicalUrl: CANONICAL,
      authorizationServer: AUTH,
      resourceName: 'acme usage archive',
    });

    expect(document).toEqual({
      resource: CANONICAL,
      authorization_servers: [AUTH],
      bearer_methods_supported: ['header'],
      resource_name: 'acme usage archive',
    });
  });

  it('MUST NOT advertise scopes — this platform retired them (ADR-95)', () => {
    const document = protectedResourceDocument({
      canonicalUrl: CANONICAL,
      authorizationServer: AUTH,
      resourceName: 'acme usage archive',
    });

    expect(Object.keys(document)).not.toContain('scopes_supported');
  });
});
