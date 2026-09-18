import { Controller, HttpRequest, HttpResponse } from '../interfaces/index.js';
import { ConfirmationCodec } from './confirmation.js';
import { ToolCaller } from './tool-definition.js';

/**
 * Test support for the MCP tool suites (mirrors core's billing-test-fakes:
 * excluded from the build and from coverage). A tool is a controller call
 * plus a mapping, so a recording controller is all a unit test needs — and
 * "the preview wrote nothing" becomes an assertion about calls, not a hope.
 */
export class RecordingController implements Controller {
  readonly requests: HttpRequest[] = [];
  private readonly responses: HttpResponse[];

  constructor(...responses: HttpResponse[]) {
    this.responses = responses;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    this.requests.push(httpRequest);
    const response =
      this.responses.length > 1 ? this.responses.shift() : this.responses[0];

    return (
      response ?? {
        statusCode: 500,
        body: { name: 'ServerError', msg: 'no fake' },
      }
    );
  }
}

export const okResponse = (body: unknown): HttpResponse => ({
  statusCode: 200,
  body,
});

export const errorResponse = (
  statusCode: number,
  name: string,
  msg: string,
): HttpResponse => ({ statusCode, body: { name, msg } });

export const TEST_CALLER: ToolCaller = {
  subject: 'user_01',
  tenant: 'namastex',
};

/**
 * A codec with the same SHAPE as the node one and no crypto: the token
 * logic is what these suites test, not HMAC-SHA256 (that is
 * node-confirmation-codec.spec.ts's job).
 */
export const fakeCodec = (secret = 'k'): ConfirmationCodec => ({
  // base64url like the real codec, NOT a readable wrapper: a token is split
  // on '.', and a payload that can contain dots (an ISO timestamp does)
  // would otherwise make every real token look malformed — which is exactly
  // how this fake first lied about the code under test.
  hmac: (data) =>
    Buffer.from(`${secret}:${data}`, 'utf8').toString('base64url'),
  sha256: (data) => Buffer.from(`sha:${data}`, 'utf8').toString('base64url'),
  equals: (a, b) => a === b,
  encode: (text) => Buffer.from(text, 'utf8').toString('base64url'),
  decode: (encoded) => {
    const text = Buffer.from(encoded, 'base64url').toString('utf8');

    return Buffer.from(text, 'utf8').toString('base64url') === encoded
      ? text
      : undefined;
  },
});

export const fixedClock = (iso: string) => ({ now: () => new Date(iso) });

/** A /bills row with every field the strict view schema declares. */
export const billRow = (
  overrides: Partial<{
    year: number;
    month: number;
    period_status: string;
    snapshot_version: number | null;
    pending_trace_count: number;
    stamped_trace_count: number;
  }> = {},
): Record<string, unknown> => {
  const year = overrides.year ?? 2026;
  const month = overrides.month ?? 6;

  return {
    year,
    month,
    month_label: `${String(year)}-${String(month).padStart(2, '0')}`,
    period_status: overrides.period_status ?? 'open',
    partial: false,
    final: overrides.period_status === 'closed',
    status_label: overrides.period_status ?? 'open',
    closed_at_display: null,
    snapshot_version: overrides.snapshot_version ?? null,
    quarantined_trace_count: 0,
    total_cost_brl: '10.00',
    total_cost_brl_display: 'R$ 10,00',
    stamped_trace_count: overrides.stamped_trace_count ?? 5,
    pending_trace_count: overrides.pending_trace_count ?? 0,
    tokens: 1000,
    tokens_display: '1.000',
    stamped_tokens: 1000,
    stamped_tokens_display: '1.000',
  };
};

/** A price-table row as GET /prices projects it. */
export const priceRow = (
  overrides: Partial<{
    model: string;
    token_type: string;
    effective_from: string;
  }> = {},
): Record<string, unknown> => ({
  model: overrides.model ?? 'openai/gpt-5-mini',
  token_type: overrides.token_type ?? 'input',
  pricing_type: 'fixed_brl',
  price_brl_per_million: '1.00',
  price_display: 'R$ 1,00/M tokens',
  effective_from: overrides.effective_from ?? '2026-05-01T00:00:00.000Z',
  effective_from_display: '01/05/2026',
});
