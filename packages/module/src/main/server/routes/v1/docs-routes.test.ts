/**
 * API docs contract tests: the OpenAPI document is generated from the SAME
 * strict zod schemas used here to parse REAL responses — if the docs and
 * the API ever diverge (or any internal field leaks), this suite fails.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { server } from '../../app.js';
import { routeDbHarness } from './helpers/route-db-harness.js';
import {
  traceDetailResponseSchema,
  traceFilterOptionsResponseSchema,
  traceListResponseSchema,
} from '../../../../presentation/controllers/traces/trace-view-schemas.js';
import {
  sessionDetailResponseSchema,
  sessionFilterOptionsResponseSchema,
  sessionListResponseSchema,
} from '../../../../presentation/controllers/sessions/session-view-schemas.js';
import {
  billListResponseSchema,
  billingProjectionResponseSchema,
  billingSeriesResponseSchema,
  billingSummaryResponseSchema,
} from '../../../../presentation/controllers/billing/billing-view-schemas.js';
import { apiErrorSchema } from '../../../../presentation/helpers/docs-schemas.js';

const app = server.app;

const FORBIDDEN_INTERNAL_KEYS =
  /marketPriceUsd|ptaxReference|markupPercent|Microcents|microcents/;

describe('API Docs (OpenAPI)', () => {
  beforeAll(async () => {
    await routeDbHarness.connect();
    await routeDbHarness.ingestJuneFixtures();
  });

  afterAll(async () => {
    await routeDbHarness.disconnect();
  });

  describe('GET /api/v1/docs/openapi.json', () => {
    it('MUST publish an OpenAPI 3.1 document covering every endpoint', async () => {
      const response = await request(app)
        .get('/api/v1/docs/openapi.json')
        .expect(200);

      expect(response.body.openapi).toBe('3.1.0');
      // No CLIENT_NAME in the test environment -> the generic module title.
      expect(response.body.info.title).toBe('Módulo de Observabilidade — API');
      expect(Object.keys(response.body.paths).sort()).toEqual([
        '/api/v1/billing/projection',
        '/api/v1/billing/series',
        '/api/v1/billing/statement',
        '/api/v1/billing/summary',
        '/api/v1/bills',
        '/api/v1/prices',
        '/api/v1/sessions',
        '/api/v1/sessions/filters',
        '/api/v1/sessions/{id}',
        '/api/v1/traces',
        '/api/v1/traces/filters',
        '/api/v1/traces/{id}',
        '/health',
      ]);
    });

    it('MUST NOT document any internal field (invariant 4 holds in the spec too)', async () => {
      const response = await request(app)
        .get('/api/v1/docs/openapi.json')
        .expect(200);

      expect(JSON.stringify(response.body)).not.toMatch(
        FORBIDDEN_INTERNAL_KEYS,
      );
    });

    it('MUST mirror the package version — one number, not two (C-4.1)', async () => {
      const packageVersion = (
        JSON.parse(
          readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
        ) as { version: string }
      ).version;

      const response = await request(app)
        .get('/api/v1/docs/openapi.json')
        .expect(200);

      expect(response.body.info.version).toBe(packageVersion);
      expect(response.body.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('MUST document the env-gated bearer auth: scheme, top-level security and a 401 on every gated path (C-4.1)', async () => {
      const response = await request(app)
        .get('/api/v1/docs/openapi.json')
        .expect(200);

      expect(response.body.components.securitySchemes.bearerAuth).toEqual(
        expect.objectContaining({ type: 'http', scheme: 'bearer' }),
      );
      expect(
        response.body.components.securitySchemes.bearerAuth.description,
      ).toContain('KHAL_AUTH_URL');
      expect(response.body.security).toEqual([{ bearerAuth: [] }]);

      const paths = response.body.paths as Record<
        string,
        Record<
          string,
          { responses: Record<string, unknown>; security?: unknown[] }
        >
      >;

      for (const [pathName, operations] of Object.entries(paths)) {
        for (const [method, operation] of Object.entries(operations)) {
          // `security: []` marks an operation OPEN (overrides the global
          // bearerAuth) — /health, decision 172. An open route never
          // answers 401, so documenting one there would be the lie this
          // test exists to catch — the invariant is two-sided.
          const isOpen =
            Array.isArray(operation.security) &&
            operation.security.length === 0;
          expect({
            path: pathName,
            method,
            has401: '401' in operation.responses,
          }).toEqual({ path: pathName, method, has401: !isOpen });
        }
      }
    });
  });

  describe('GET /api/v1/docs', () => {
    it('MUST serve the Swagger UI', async () => {
      const response = await request(app).get('/api/v1/docs/').expect(200);

      expect(response.headers['content-type']).toContain('text/html');
      expect(response.text.toLowerCase()).toContain('swagger');
    });

    it('MUST 301 the slashless spelling to the canonical /api/v1/docs/ (C-5.3)', async () => {
      const response = await request(app).get('/api/v1/docs').expect(301);

      expect(response.headers.location).toBe('/api/v1/docs/');
    });

    it('MUST answer a garbage sub-path as JSON 404, not the docs page (C-5.3)', async () => {
      const response = await request(app)
        .get('/api/v1/docs/nao-existe')
        .expect(404)
        .expect('Content-Type', /json/);

      expect(response.body).toEqual({
        name: 'NotFoundError',
        msg: 'Not found: GET /api/v1/docs/nao-existe',
      });
    });
  });

  describe('Contract: real responses parse against the documented schemas', () => {
    it('GET /traces MUST match the published list schema (strict)', async () => {
      const response = await request(app).get('/api/v1/traces').expect(200);

      expect(() => traceListResponseSchema.parse(response.body)).not.toThrow();
    });

    it('GET /traces/filters MUST match the published options schema (strict)', async () => {
      const response = await request(app)
        .get('/api/v1/traces/filters')
        .expect(200);

      expect(() =>
        traceFilterOptionsResponseSchema.parse(response.body),
      ).not.toThrow();
    });

    it('GET /traces/:id MUST match the published detail schema — stamped and pending', async () => {
      const stamped = await request(app)
        .get('/api/v1/traces/trace-w1-005')
        .expect(200);
      const pending = await request(app)
        .get('/api/v1/traces/trace-w1-006')
        .expect(200);

      expect(() => traceDetailResponseSchema.parse(stamped.body)).not.toThrow();
      expect(() => traceDetailResponseSchema.parse(pending.body)).not.toThrow();
    });

    it('GET /sessions and /sessions/:id MUST match the published schemas', async () => {
      const list = await request(app).get('/api/v1/sessions').expect(200);
      const detail = await request(app)
        .get('/api/v1/sessions/sess-checkout-001')
        .expect(200);

      expect(() => sessionListResponseSchema.parse(list.body)).not.toThrow();
      expect(() =>
        sessionDetailResponseSchema.parse(detail.body),
      ).not.toThrow();
    });

    it('GET /sessions/filters MUST match the published options schema (strict)', async () => {
      const response = await request(app)
        .get('/api/v1/sessions/filters')
        .expect(200);

      expect(() =>
        sessionFilterOptionsResponseSchema.parse(response.body),
      ).not.toThrow();
    });

    it('GET /billing/summary MUST match the published schema', async () => {
      const response = await request(app)
        .get('/api/v1/billing/summary?year=2026&month=6')
        .expect(200);

      expect(() =>
        billingSummaryResponseSchema.parse(response.body),
      ).not.toThrow();
    });

    it('GET /bills MUST match the published schema', async () => {
      const response = await request(app).get('/api/v1/bills').expect(200);

      expect(() => billListResponseSchema.parse(response.body)).not.toThrow();
    });

    it('GET /billing/series MUST match the published schema — both granularities', async () => {
      const monthly = await request(app)
        .get('/api/v1/billing/series')
        .expect(200);
      const daily = await request(app)
        .get('/api/v1/billing/series?granularity=day')
        .expect(200);

      expect(() =>
        billingSeriesResponseSchema.parse(monthly.body),
      ).not.toThrow();
      expect(() => billingSeriesResponseSchema.parse(daily.body)).not.toThrow();
    });

    it('GET /billing/projection MUST match the published schema', async () => {
      const response = await request(app)
        .get('/api/v1/billing/projection')
        .expect(200);

      expect(() =>
        billingProjectionResponseSchema.parse(response.body),
      ).not.toThrow();
    });

    it('GET /billing/statement MUST answer the documented representations (decision 98)', async () => {
      // The statement is not JSON — its documented contract is the two
      // representations: text/csv as an attachment (default) and a
      // standalone printable text/html page.
      const csv = await request(app)
        .get('/api/v1/billing/statement?year=2026&month=6')
        .expect(200);

      expect(csv.headers['content-type']).toContain('text/csv');
      // June 2026 is a past open month — never PARCIAL, so the documented
      // plain filename applies (clock-safe for all future run dates).
      expect(csv.headers['content-disposition']).toBe(
        'attachment; filename="extrato-2026-06.csv"',
      );
      // UTF-8 BOM: the file opens straight in Excel (US17).
      expect(csv.text.startsWith('\ufeff')).toBe(true);

      const html = await request(app)
        .get('/api/v1/billing/statement?year=2026&month=6&format=html')
        .expect(200);

      expect(html.headers['content-type']).toContain('text/html');
      expect(html.text).toContain('<!DOCTYPE html>');

      expect(FORBIDDEN_INTERNAL_KEYS.test(csv.text)).toBe(false);
      expect(FORBIDDEN_INTERNAL_KEYS.test(html.text)).toBe(false);
    });

    it('Error payloads MUST match the published error schema', async () => {
      const badRequest = await request(app)
        .get('/api/v1/traces?from=banana')
        .expect(400);
      const notFound = await request(app)
        .get('/api/v1/traces/nao-existe')
        .expect(404);

      expect(() => apiErrorSchema.parse(badRequest.body)).not.toThrow();
      expect(() => apiErrorSchema.parse(notFound.body)).not.toThrow();
    });
  });
});
