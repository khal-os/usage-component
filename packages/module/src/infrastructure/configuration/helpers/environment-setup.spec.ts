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
  delete process.env.MCP_CANONICAL_URL;
  delete process.env.MCP_CONFIRMATION_KEY;
  delete process.env.MCP_AUDIENCE;
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

    it("MUST treat '' (compose `${MONGO_DB_ATLAS:-}`) exactly like unset", async () => {
      // A fresh client env never writes the knob; the enum without the ''
      // preprocess rejected the forwarded empty string and crash-looped
      // the api container on a clean deploy-demo-client.sh run.
      const environment = await loadEnvironment({ MONGO_DB_ATLAS: '' });

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

describe('MCP_* (T12 — the endpoint is opt-in and all-or-nothing)', () => {
  const MCP_ON = {
    MCP_CANONICAL_URL: 'https://api-dev.example.com/mcp',
    MCP_CONFIRMATION_KEY: 'x'.repeat(32),
    MCP_AUDIENCE: 'usage-mcp',
    KHAL_AUTH_URL: 'https://auth-dev.example.com',
    KHAL_TENANT: 'acme',
  };

  /**
   * The fatal path exits the process, so a refusal is asserted by the exit
   * itself. stdout is muted: the boot's last words are a real log line, not
   * suite noise.
   */
  const expectRefusedBoot = async (
    overrides: Record<string, string>,
  ): Promise<void> => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      await expect(loadEnvironment(overrides)).rejects.toThrow('process.exit');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      write.mockRestore();
      exit.mockRestore();
    }
  };

  it('MUST leave every MCP knob undefined when the endpoint is not configured', async () => {
    const environment = await loadEnvironment();

    expect(environment.mcpCanonicalUrl).toBeUndefined();
    expect(environment.mcpConfirmationKey).toBeUndefined();
    expect(environment.mcpAudience).toBeUndefined();
  });

  it('MUST pass the whole set through when the endpoint IS configured', async () => {
    const environment = await loadEnvironment(MCP_ON);

    expect(environment.mcpCanonicalUrl).toBe('https://api-dev.example.com/mcp');
    expect(environment.mcpAudience).toBe('usage-mcp');
    expect(environment.mcpConfirmationKey).toBe('x'.repeat(32));
  });

  it("MUST treat '' (compose `${VAR:-}` defaults) exactly like unset", async () => {
    const environment = await loadEnvironment({
      MCP_CANONICAL_URL: '',
      MCP_CONFIRMATION_KEY: '',
      MCP_AUDIENCE: '',
    });

    expect(environment.mcpCanonicalUrl).toBeUndefined();
  });

  it('MUST boot happily with a provisioned key and NO endpoint (the secret exists per environment)', async () => {
    const environment = await loadEnvironment({
      MCP_CONFIRMATION_KEY: 'y'.repeat(40),
    });

    expect(environment.mcpCanonicalUrl).toBeUndefined();
    expect(environment.mcpConfirmationKey).toBe('y'.repeat(40));
  });

  it('MUST refuse the boot when the endpoint has no session issuer (MCP is never open)', async () => {
    const {
      KHAL_AUTH_URL: _url,
      KHAL_TENANT: _tenant,
      ...withoutAuth
    } = MCP_ON;

    await expectRefusedBoot(withoutAuth);
  });

  it('MUST refuse the boot when the endpoint has no tenant', async () => {
    const { KHAL_TENANT: _tenant, ...withoutTenant } = MCP_ON;

    await expectRefusedBoot(withoutTenant);
  });

  it('MUST refuse the boot with no audience — a guessed audience is a wrong door', async () => {
    const { MCP_AUDIENCE: _audience, ...withoutAudience } = MCP_ON;

    await expectRefusedBoot(withoutAudience);
  });

  it('MUST refuse the boot with no confirmation key — writes would have no lock', async () => {
    const { MCP_CONFIRMATION_KEY: _key, ...withoutKey } = MCP_ON;

    await expectRefusedBoot(withoutKey);
  });

  it('MUST refuse a confirmation key shorter than 32 characters', async () => {
    await expectRefusedBoot({ ...MCP_ON, MCP_CONFIRMATION_KEY: 'short-key' });
  });

  it.each([
    ['a path that is not /mcp', 'https://api-dev.example.com/api/v1/mcp'],
    ['no path at all', 'https://api-dev.example.com'],
    ['a non-http scheme', 'ftp://api-dev.example.com/mcp'],
    ['something that is not a url', 'api-dev.example.com/mcp'],
  ])(
    'MUST refuse a canonical url with %s (it IS the resource identifier)',
    async (_case, url) => {
      await expectRefusedBoot({ ...MCP_ON, MCP_CANONICAL_URL: url });
    },
  );

  it('MUST accept a trailing slash on the canonical url', async () => {
    const environment = await loadEnvironment({
      ...MCP_ON,
      MCP_CANONICAL_URL: 'https://api-dev.example.com/mcp/',
    });

    expect(environment.mcpCanonicalUrl).toBe(
      'https://api-dev.example.com/mcp/',
    );
  });
});
