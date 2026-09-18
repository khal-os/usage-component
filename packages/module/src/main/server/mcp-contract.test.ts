/**
 * The MCP contract, exercised with the OFFICIAL MCP TypeScript client
 * against a real listener (T12). Nothing here is stubbed except the key
 * SOURCE: tokens are signed with a real RSA key and the JWKS fetch is served
 * in-process, so the actual verifier — issuer, audience, tenant, expiry,
 * role — decides who gets in.
 *
 * This is the suite that answers "would Claude Code talk to this?": the
 * handshake, the three listings, a tool call, a prompt, a resource, the
 * custom discover method, and the two refusals a client must be able to
 * tell apart (log in vs not your door).
 */
import express, { Application } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { JWK, KeyLike } from 'jose';
import { z } from 'zod';
import { nullLogger } from '@observability/core/common/logging/null-logger.js';
import { makeMcpRuntimeFrom } from '../factories/mcp-factory.js';
import { registerMcpRoutes } from '../mcp/mcp-routes.js';
import { setupErrorHandling, setupV1Routes } from './helpers/index.js';
import { routeDbHarness } from './routes/v1/helpers/route-db-harness.js';

const AUTH_URL = 'https://auth-contract.example.com';
const JWKS_URL = `${AUTH_URL}/.well-known/jwks.json`;
const AUDIENCE = 'usage-mcp';
const TENANT = 'acme';

let keys: { privateKey: KeyLike; publicJwk: JWK };
let httpServer: Server;
let baseUrl: string;

const originalFetch = global.fetch;

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

const mintToken = (
  overrides: { audience?: string; roles?: string; subject?: string } = {},
): Promise<string> =>
  new SignJWT({ tenant: TENANT, roles: overrides.roles ?? 'master' })
    .setProtectedHeader({ alg: 'RS256', kid: 'contract-key' })
    .setIssuer(AUTH_URL)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject(overrides.subject ?? 'user_contract')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);

const makeApp = (canonicalUrl: string): Application => {
  const app = express();

  app.use(express.json());
  registerMcpRoutes(
    app,
    makeMcpRuntimeFrom({
      canonicalUrl,
      authUrl: AUTH_URL,
      tenant: TENANT,
      audience: AUDIENCE,
      // qcia:allow-secret — test stub
      confirmationKey: 'contract-suite-key-longer-than-32-characters',
      clientTimezone: 'America/Sao_Paulo',
      clientName: 'acme',
      allowedOrigins: '',
    }),
  );
  const routes = setupV1Routes(app);
  setupErrorHandling(app, routes, nullLogger);

  return app;
};

const connect = async (token: string): Promise<Client> => {
  const client = new Client({ name: 'contract-test', version: '1.0.0' });

  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );

  return client;
};

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  keys = {
    privateKey: pair.privateKey,
    publicJwk: {
      ...(await exportJWK(pair.publicKey)),
      kid: 'contract-key',
      alg: 'RS256',
    },
  };

  // Only the key set is served in-process; everything else reaches the real
  // network stack (which is how the client talks to the listener below).
  global.fetch = (async (input, init) =>
    urlOf(input) === JWKS_URL
      ? new Response(JSON.stringify({ keys: [keys.publicJwk] }), {
          headers: { 'content-type': 'application/json' },
        })
      : originalFetch(input, init)) as typeof fetch;

  // The canonical URL carries the ephemeral port, which only exists after
  // listen() — so the listener delegates to an app built once it is known.
  const delegate: { app?: Application } = {};
  httpServer = createServer((req, res) => {
    delegate.app?.(req, res);
  });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, '127.0.0.1', resolve),
  );
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(port)}`;
  delegate.app = makeApp(`${baseUrl}/mcp`);

  await routeDbHarness.connect();
  await routeDbHarness.ingestJuneFixtures();
});

afterAll(async () => {
  global.fetch = originalFetch;
  await routeDbHarness.disconnect();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('the official MCP client against POST /mcp', () => {
  it('MUST complete the handshake and list the whole surface', async () => {
    const client = await connect(await mintToken());

    const tools = await client.listTools();
    const prompts = await client.listPrompts();
    const resources = await client.listResources();

    expect(tools.tools.map((tool) => tool.name)).toContain('get_overview');
    expect(tools.tools).toHaveLength(19);
    expect(prompts.prompts.map((prompt) => prompt.name)).toContain(
      'explain-bill',
    );
    expect(resources.resources.map((resource) => resource.uri)).toContain(
      'usage://openapi.json',
    );

    await client.close();
  });

  it('MUST publish the annotations a client uses to decide what needs approval', async () => {
    const client = await connect(await mintToken());

    const { tools } = await client.listTools();
    const read = tools.find((tool) => tool.name === 'list_bills');
    const write = tools.find((tool) => tool.name === 'register_price');
    const destructive = tools.find(
      (tool) => tool.name === 'reopen_billing_period',
    );

    expect(read?.annotations).toMatchObject({ readOnlyHint: true });
    expect(write?.annotations).toMatchObject({ readOnlyHint: false });
    expect(destructive?.annotations).toMatchObject({ destructiveHint: true });

    await client.close();
  });

  it('MUST answer a tool call with structured content the client can parse', async () => {
    const client = await connect(await mintToken());

    const result = await client.callTool({
      name: 'get_overview',
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      client: { name: 'acme', tenant: TENANT, timezone: 'America/Sao_Paulo' },
    });

    await client.close();
  });

  it('MUST hand a failure back as a tool RESULT, not as a protocol error', async () => {
    const client = await connect(await mintToken());

    const result = await client.callTool({
      name: 'get_trace',
      arguments: { id: 'nope' },
    });

    expect(result.isError).toBe(true);

    await client.close();
  });

  it('MUST serve a prompt as a ready-to-send message', async () => {
    const client = await connect(await mintToken());

    const prompt = await client.getPrompt({
      name: 'close-month',
      arguments: { year: '2026', month: '6' },
    });

    const content = prompt.messages[0]?.content;

    expect(content).toMatchObject({ type: 'text' });
    expect(content && 'text' in content ? String(content.text) : '').toContain(
      'preview',
    );

    await client.close();
  });

  it('MUST serve a resource by uri', async () => {
    const client = await connect(await mintToken());

    const resource = await client.readResource({ uri: 'usage://bills' });

    const first = resource.contents[0];

    expect(
      JSON.parse(first && 'text' in first ? String(first.text) : '{}'),
    ).toHaveProperty('bills');

    await client.close();
  });

  it('MUST answer the custom server/discover method the next spec revision requires', async () => {
    const client = await connect(await mintToken());

    const discovered = await client.request(
      { method: 'server/discover', params: {} },
      z.object({
        protocolVersions: z.array(z.string()),
        serverInfo: z.object({ name: z.string(), version: z.string() }),
        capabilities: z.record(z.string(), z.unknown()),
      }),
    );

    expect(discovered.serverInfo.name).toBe('khal-usage-mcp');
    expect(discovered.protocolVersions.length).toBeGreaterThan(0);

    await client.close();
  });

  it('MUST refuse a token minted for another audience (a resource server accepts only its own)', async () => {
    // The client surfaces the refusal body, which is how the two answers stay
    // distinguishable: "log in" (Unauthorized) vs "not your door" (Forbidden).
    await expect(
      connect(await mintToken({ audience: 'tracing' })),
    ).rejects.toThrow(/UnauthorizedError/);
  });

  it('MUST refuse a valid session without the master role', async () => {
    await expect(connect(await mintToken({ roles: 'member' }))).rejects.toThrow(
      /ForbiddenError/,
    );
  });
});
