/**
 * environment-setup parses process.env AT IMPORT TIME, so each case builds
 * its env, resets the module registry and re-imports. Pure unit suite — no
 * store, no server.
 *
 * What is pinned here:
 * - MONGO_DB_ATLAS arrives as a STRING ('true'/'false') and must map to a
 *   real boolean — z.boolean() would reject every set value and crash the
 *   boot (the Atlas branch was dead code).
 * - Compose forwards the KHAL_* vars with `${VAR:-}` defaults, so an env
 *   file that omits them delivers EMPTY STRINGS to the container — which must
 *   behave exactly like unset (an empty URL must never half-enable auth).
 */
const ORIGINAL_ENV = process.env;

const loadEnvironment = async (
  overrides: Record<string, string> = {},
): Promise<typeof import('./environment-setup.js').environment> => {
  process.env = {
    ...ORIGINAL_ENV,
    ENVIRONMENT: 'test',
    SERVER_PORT: '3000',
  };
  delete process.env.MONGO_DB_ATLAS;
  delete process.env.KHAL_AUTH_URL;
  delete process.env.KHAL_TENANT;
  delete process.env.KHAL_TOKEN_AUDIENCE;
  Object.assign(process.env, overrides);

  jest.resetModules();
  const { environment } = await import('./environment-setup.js');
  return environment;
};

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('environment-setup', () => {
  describe('MONGO_DB_ATLAS (string env → boolean)', () => {
    it("MUST parse MONGO_DB_ATLAS='true' to boolean true", async () => {
      const environment = await loadEnvironment({ MONGO_DB_ATLAS: 'true' });

      expect(environment.mongoDbAtlas).toBe(true);
    });

    it("MUST parse MONGO_DB_ATLAS='false' to boolean false", async () => {
      const environment = await loadEnvironment({ MONGO_DB_ATLAS: 'false' });

      expect(environment.mongoDbAtlas).toBe(false);
    });

    it('MUST leave mongoDbAtlas undefined when the var is unset', async () => {
      const environment = await loadEnvironment();

      expect(environment.mongoDbAtlas).toBeUndefined();
    });
  });

  describe('KHAL_* (session auth surface, ADR-103 naming)', () => {
    it('MUST pass KHAL_AUTH_URL + KHAL_TENANT through unchanged', async () => {
      const environment = await loadEnvironment({
        KHAL_AUTH_URL: 'https://auth.khal-usage.com',
        KHAL_TENANT: 'acme',
      });

      expect(environment.khalAuthUrl).toBe('https://auth.khal-usage.com');
      expect(environment.khalTenant).toBe('acme');
    });

    it("MUST default KHAL_TOKEN_AUDIENCE to ['tracing', 'billing'] (unset AND '')", async () => {
      const unset = await loadEnvironment();
      expect(unset.khalTokenAudiences).toEqual(['tracing', 'billing']);

      const empty = await loadEnvironment({ KHAL_TOKEN_AUDIENCE: '' });
      expect(empty.khalTokenAudiences).toEqual(['tracing', 'billing']);
    });

    it('MUST parse a single explicit KHAL_TOKEN_AUDIENCE as a one-entry list (backward compat)', async () => {
      const environment = await loadEnvironment({
        KHAL_TOKEN_AUDIENCE: 'billing',
      });

      expect(environment.khalTokenAudiences).toEqual(['billing']);
    });

    it('MUST split KHAL_TOKEN_AUDIENCE on commas, trimming spaces and dropping empties', async () => {
      const environment = await loadEnvironment({
        KHAL_TOKEN_AUDIENCE: ' tracing , billing ,',
      });

      expect(environment.khalTokenAudiences).toEqual(['tracing', 'billing']);
    });

    it("MUST treat '' (compose `${VAR:-}` defaults) as unset", async () => {
      const environment = await loadEnvironment({
        KHAL_AUTH_URL: '',
        KHAL_TENANT: '',
      });

      expect(environment.khalAuthUrl).toBeUndefined();
      expect(environment.khalTenant).toBeUndefined();
    });
  });
});
