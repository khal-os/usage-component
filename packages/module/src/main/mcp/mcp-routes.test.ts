/**
 * The MCP endpoint against the REAL store (T12). The app is assembled the
 * way app.ts assembles it — docs, /health, MCP, then the /api/v1 routes and
 * the error boundary — with only the session VERIFIER stubbed: minting real
 * khal-auth tokens is the contract suite's job, and what this suite has to
 * prove is the behaviour behind the door.
 *
 * The headline assertion is PARITY: a tool answers byte-for-byte what its
 * HTTP route answers. Everything else follows from it (one validation, one
 * view, one money rule), which is why decision 175 chose to reuse the
 * controllers instead of writing a second read path.
 */
import express, { Application } from 'express';
import request from 'supertest';
import { nullLogger } from '@observability/core/common/logging/null-logger.js';
import {
  SessionClaims,
  SessionClaimsVerifier,
} from '../../application/interfaces/session-claims-verifier.js';
import {
  setupDocs,
  setupErrorHandling,
  setupV1Routes,
} from '../server/helpers/index.js';
import { routeDbHarness } from '../server/routes/v1/helpers/route-db-harness.js';
import { makeMcpRuntimeFrom } from '../factories/mcp-factory.js';
import { registerMcpRoutes } from './mcp-routes.js';

const MASTER: SessionClaims = {
  subject: 'user_01',
  role: 'master',
  tenant: 'acme',
};
const MEMBER: SessionClaims = {
  subject: 'user_02',
  role: 'member',
  tenant: 'acme',
};

const TOKENS: Record<string, SessionClaims> = {
  'master-token': MASTER,
  'member-token': MEMBER,
};

const verifier: SessionClaimsVerifier = {
  verify: async (token) => TOKENS[token],
};

const CANONICAL_URL = 'https://api-test.example.com/mcp';

const makeApp = (): Application => {
  const app = express();

  app.use(express.json());
  setupDocs(app);
  registerMcpRoutes(
    app,
    makeMcpRuntimeFrom(
      {
        canonicalUrl: CANONICAL_URL,
        authUrl: 'https://auth-test.example.com',
        tenant: 'acme',
        audience: 'usage-mcp',
        // qcia:allow-secret — test stub
        confirmationKey: 'integration-suite-key-longer-than-32-chars',
        clientTimezone: 'America/Sao_Paulo',
        clientName: 'acme',
        allowedOrigins: 'https://console.example.com',
      },
      { verifier },
    ),
  );
  const routes = setupV1Routes(app);
  setupErrorHandling(app, routes, nullLogger);

  return app;
};

const app = makeApp();

interface JsonRpcResult {
  result?: {
    content?: {
      type: string;
      text?: string;
      resource?: Record<string, unknown>;
    }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    tools?: { name: string }[];
    prompts?: { name: string }[];
    resources?: { uri: string }[];
    contents?: { text?: string }[];
    protocolVersions?: string[];
  };
  error?: { code: number; message: string };
}

const rpc = async (
  method: string,
  params: Record<string, unknown> = {},
  token = 'master-token',
): Promise<JsonRpcResult> => {
  const response = await request(app)
    .post('/mcp')
    .set('authorization', `Bearer ${token}`)
    .set('accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method, params });

  expect(response.status).toBe(200);

  return response.body as JsonRpcResult;
};

const call = async (
  name: string,
  args: Record<string, unknown> = {},
  token = 'master-token',
): Promise<JsonRpcResult['result']> =>
  (await rpc('tools/call', { name, arguments: args }, token)).result;

const errorOf = (result: JsonRpcResult['result']): Record<string, unknown> =>
  JSON.parse(result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;

describe('POST /mcp', () => {
  beforeAll(async () => {
    await routeDbHarness.connect();
    await routeDbHarness.ingestJuneFixtures();
  });

  afterAll(async () => {
    await routeDbHarness.disconnect();
  });

  describe('the door', () => {
    it('MUST answer 401 with a challenge and no token', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        .expect(401);

      expect(response.headers['www-authenticate']).toContain(
        'resource_metadata="https://api-test.example.com/.well-known/oauth-protected-resource/mcp"',
      );
    });

    it('MUST answer 403 for a non-master session', async () => {
      await request(app)
        .post('/mcp')
        .set('authorization', 'Bearer member-token')
        .set('accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        .expect(403);
    });

    it('MUST refuse a browser origin that is not allowlisted', async () => {
      await request(app)
        .post('/mcp')
        .set('origin', 'https://evil.example.com')
        .set('authorization', 'Bearer master-token')
        .set('accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        .expect(403);
    });

    it('MUST admit an allowlisted browser origin', async () => {
      await request(app)
        .post('/mcp')
        .set('origin', 'https://console.example.com')
        .set('authorization', 'Bearer master-token')
        .set('accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        .expect(200);
    });

    it.each(['get', 'delete'] as const)(
      'MUST answer 405 with Allow: POST to %s (a stateless server has no stream and no session)',
      async (method) => {
        const response = await request(app)[method]('/mcp').expect(405);

        expect(response.headers['allow']).toBe('POST');
        expect(response.body.error.message).toContain('POST');
      },
    );

    it('MUST publish RFC 9728 metadata on both well-known paths, without a token', async () => {
      for (const path of [
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/mcp',
      ]) {
        const response = await request(app).get(path).expect(200);

        expect(response.body).toEqual({
          resource: CANONICAL_URL,
          authorization_servers: ['https://auth-test.example.com'],
          bearer_methods_supported: ['header'],
          resource_name: 'acme usage archive',
        });
      }
    });
  });

  describe('the surface', () => {
    it('MUST list the tools, prompts and resources of T12', async () => {
      const tools = (await rpc('tools/list')).result?.tools ?? [];
      const prompts = (await rpc('prompts/list')).result?.prompts ?? [];
      const resources = (await rpc('resources/list')).result?.resources ?? [];

      expect(tools).toHaveLength(19);
      expect(tools.map((tool) => tool.name)).toContain('get_overview');
      expect(prompts).toHaveLength(4);
      expect(resources.map((resource) => resource.uri)).toEqual(
        expect.arrayContaining(['usage://openapi.json', 'usage://bills']),
      );
    });

    it('MUST answer the custom server/discover method with the SDK protocol list', async () => {
      const result = (await rpc('server/discover')).result;

      expect(result?.protocolVersions?.length).toBeGreaterThan(0);
    });

    it('MUST read a resource as text', async () => {
      const result = (await rpc('resources/read', { uri: 'usage://prices' }))
        .result;

      expect(JSON.parse(result?.contents?.[0]?.text ?? '{}')).toHaveProperty(
        'items',
      );
    });
  });

  describe('parity with the HTTP routes (decision 175)', () => {
    it.each([
      [
        'list_traces',
        { page: 1, page_size: 5 },
        '/api/v1/traces?page=1&page_size=5',
      ],
      [
        'get_billing_summary',
        { year: 2026, month: 6 },
        '/api/v1/billing/summary?year=2026&month=6',
      ],
      ['list_bills', {}, '/api/v1/bills'],
      ['list_prices', {}, '/api/v1/prices'],
      [
        'list_sessions',
        { page: 1, page_size: 3 },
        '/api/v1/sessions?page=1&page_size=3',
      ],
    ])(
      '%s MUST answer byte-for-byte what its route answers',
      async (tool, args, path) => {
        const [viaTool, viaHttp] = await Promise.all([
          call(tool, args),
          request(app).get(path).expect(200),
        ]);

        expect(JSON.stringify(viaTool?.structuredContent)).toBe(viaHttp.text);
      },
    );

    it('MUST refuse an out-of-range argument at the SCHEMA border, before the tool runs', async () => {
      const result = await call('get_billing_summary', {
        year: 2026,
        month: 13,
      });

      expect(result?.isError).toBe(true);
      expect(result?.content?.[0]?.text).toContain('validation');
    });

    it('MUST map a value the CONTROLLER refuses to INVALID_INPUT naming the field', async () => {
      const result = await call('list_traces', { from: 'yesterday' });

      expect(result?.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: 'INVALID_INPUT',
        message: 'Invalid parameter: from',
      });
    });

    it('MUST map an unknown id to NOT_FOUND', async () => {
      const result = await call('get_trace', { id: 'does-not-exist' });

      expect(result?.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('MUST return the statement as an embedded document', async () => {
      const result = await call('export_statement', {
        year: 2026,
        month: 6,
        format: 'csv',
      });

      expect(result?.structuredContent).toMatchObject({
        format: 'csv',
        media_type: 'text/csv',
      });
      expect(result?.content?.[1]?.resource).toMatchObject({
        mimeType: 'text/csv',
      });
      expect(String(result?.content?.[1]?.resource?.['text'])).toContain(
        'Extrato mensal',
      );
    });
  });
  /**
   * The money path end to end, through MCP only: a month cannot close while
   * executions wait for a price, so the operator registers the missing
   * prices (preview → confirm), the re-stamp runs, and only then does the
   * month close — audited as 'mcp' with the caller as actor (decision 179).
   *
   * Declared last on purpose: these cases mutate the shared store.
   */
  describe('writes (previews, confirmations, and the audit trail)', () => {
    const PENDING_MODEL = 'meta/llama-4-scout';
    const JUNE = { year: 2026, month: 6 };

    const previewPrice = async (token_type: string) =>
      call('preview_register_price', {
        model: PENDING_MODEL,
        token_type,
        price_brl_per_million: '1.50',
        effective_from: '2026-06-01',
      });

    const registerPrice = async (
      token_type: string,
      confirmation_token: string,
    ) =>
      call('register_price', {
        model: PENDING_MODEL,
        token_type,
        price_brl_per_million: '1.50',
        effective_from: '2026-06-01',
        confirmation_token,
      });

    const bill = async () => {
      const bills = (await call('list_bills'))?.structuredContent as
        { bills: Record<string, unknown>[] } | undefined;

      return bills?.bills.find(
        (row) => row['year'] === 2026 && row['month'] === 6,
      );
    };

    beforeAll(async () => {
      await routeDbHarness.ingestJuneFixtures();
    });

    it('MUST refuse to close a month whose executions are waiting for a price', async () => {
      const result = await call('preview_close_billing_period', JUNE);

      expect(result?.structuredContent).toMatchObject({
        can_close: false,
        confirmation_token: null,
        models_without_price: [PENDING_MODEL],
      });
      expect(String(result?.structuredContent?.['blockers'])).toContain(
        'waiting for a price',
      );
    });

    it('MUST write NOTHING on a price preview', async () => {
      const before = await request(app).get('/api/v1/prices').expect(200);

      const preview = await previewPrice('input');

      const after = await request(app).get('/api/v1/prices').expect(200);

      expect(preview?.structuredContent).toMatchObject({
        canonical_model: PENDING_MODEL,
        writes_nothing: true,
      });
      expect(after.text).toBe(before.text);
    });

    it('MUST refuse a confirmation whose arguments drifted from the preview', async () => {
      const preview = await previewPrice('input');
      const confirmation_token = String(
        preview?.structuredContent?.['confirmation_token'],
      );

      const result = await call('register_price', {
        model: PENDING_MODEL,
        token_type: 'input',
        price_brl_per_million: '99.00',
        effective_from: '2026-06-01',
        confirmation_token,
      });

      expect(errorOf(result)).toMatchObject({ code: 'CONFIRMATION_MISMATCH' });
      expect((await request(app).get('/api/v1/prices')).text).not.toContain(
        PENDING_MODEL,
      );
    });

    it('MUST register the previewed prices and re-stamp what they unblock', async () => {
      for (const tokenType of ['input', 'output']) {
        const preview = await previewPrice(tokenType);
        const result = await registerPrice(
          tokenType,
          String(preview?.structuredContent?.['confirmation_token']),
        );

        expect(result?.isError).toBeUndefined();
        expect(result?.structuredContent).toMatchObject({
          model: PENDING_MODEL,
        });
      }

      expect(await bill()).toMatchObject({
        pending_trace_count: 0,
        stamped_trace_count: 9,
      });
    });

    it('MUST refuse replaying a spent confirmation (the version now exists)', async () => {
      const preview = await previewPrice('cache_read');
      const confirmation_token = String(
        preview?.structuredContent?.['confirmation_token'],
      );

      await registerPrice('cache_read', confirmation_token);
      const replay = await registerPrice('cache_read', confirmation_token);

      expect(errorOf(replay)).toMatchObject({ code: 'CONFLICT' });
    });

    it('MUST close the month and record trigger mcp with the caller as actor', async () => {
      const preview = await call('preview_close_billing_period', JUNE);
      const confirmation_token = String(
        preview?.structuredContent?.['confirmation_token'],
      );

      expect(preview?.structuredContent?.['can_close']).toBe(true);

      const closed = await call('close_billing_period', {
        ...JUNE,
        confirmation_token,
      });

      expect(closed?.structuredContent).toMatchObject({
        snapshot_version: 1,
        trigger: 'mcp',
        actor: 'user_01',
        stamped_trace_count: 9,
      });
      expect(await bill()).toMatchObject({
        period_status: 'closed',
        snapshot_version: 1,
      });

      // The same token again: the month it was minted against is gone.
      const replay = await call('close_billing_period', {
        ...JUNE,
        confirmation_token,
      });

      expect(errorOf(replay)).toMatchObject({ code: 'STALE_PERIOD' });
    });

    it('MUST serve the closed month from its snapshot on BOTH doors, identically', async () => {
      const [viaTool, viaHttp] = await Promise.all([
        call('get_billing_summary', JUNE),
        request(app)
          .get('/api/v1/billing/summary?year=2026&month=6')
          .expect(200),
      ]);

      expect(JSON.stringify(viaTool?.structuredContent)).toBe(viaHttp.text);
      expect(viaTool?.structuredContent).toMatchObject({ final: true });
    });

    it('MUST reopen with the audited reason and keep the previous snapshot', async () => {
      const reason = 'correção de atribuição do agente de cobrança';
      const preview = await call('preview_reopen_billing_period', {
        ...JUNE,
        reason,
      });

      expect(preview?.structuredContent?.['can_reopen']).toBe(true);

      const reopened = await call('reopen_billing_period', {
        ...JUNE,
        reason,
        confirmation_token: String(
          preview?.structuredContent?.['confirmation_token'],
        ),
      });

      expect(reopened?.structuredContent).toMatchObject({
        previous_snapshot_version: 1,
        next_snapshot_version: 2,
        trigger: 'mcp',
        actor: 'user_01',
      });
      expect(await bill()).toMatchObject({ period_status: 'open' });
    });
  });
});
