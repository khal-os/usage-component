import { callController, jsonFromController } from './controller-tool.js';
import {
  RecordingController,
  errorResponse,
  okResponse,
} from './mcp-test-fakes.js';

describe('controller → tool adapter (parity by construction)', () => {
  it('MUST pass the request through and return the controller body verbatim', async () => {
    const controller = new RecordingController(okResponse({ items: [1, 2] }));

    const outcome = await jsonFromController(controller, {
      query: { page: '2' },
      params: { id: 'x' },
    });

    expect(controller.requests).toEqual([
      { query: { page: '2' }, params: { id: 'x' } },
    ]);
    expect(outcome).toEqual({
      ok: true,
      value: { structured: { items: [1, 2] } },
    });
  });

  it('MUST turn a non-2xx answer into a tool error instead of a result', async () => {
    const controller = new RecordingController(
      errorResponse(404, 'NotFoundError', 'Not found: trace x'),
    );

    const outcome = await jsonFromController(controller, { query: {} });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? undefined : outcome.error.code).toBe('NOT_FOUND');
  });

  it('MUST hand a raw (non-JSON) response back to the caller to shape', async () => {
    const controller = new RecordingController({
      statusCode: 200,
      body: 'a;b;c',
      raw: true,
      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
    });

    const call = await callController(controller, { query: {} });

    expect(call.ok && call.response.body).toBe('a;b;c');
  });
});
