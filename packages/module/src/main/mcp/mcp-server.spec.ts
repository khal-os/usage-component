import { RecordingLogger } from '@observability/core/common/logging/logging-test-fakes.js';
import { guarded } from './mcp-server.js';
import { ToolOutcome } from '../../presentation/mcp/tool-definition.js';

/**
 * The error boundary of the MCP door — the twin of `adaptRoute`'s on the HTTP
 * door. Without it the SDK turns an unexpected throw into a tool error carrying
 * `error.message` verbatim, so a connection string or an internal class name
 * would travel to a language model and NOTHING would be logged.
 */
const CALLER = { subject: 'user_01', tenant: 'acme' };

const context = () => {
  const logger = new RecordingLogger();

  return { logger, args: { tool: 'get_trace', caller: CALLER, logger } };
};

describe('the MCP tool error boundary', () => {
  it('MUST pass a normal outcome through untouched', async () => {
    const { args } = context();
    const outcome: ToolOutcome = { ok: true, value: { structured: { a: 1 } } };

    await expect(guarded(async () => outcome, args)).resolves.toBe(outcome);
  });

  it('MUST pass a tool ERROR outcome through (a mapped failure is not an exception)', async () => {
    const { args, logger } = context();
    const outcome: ToolOutcome = {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found: trace x', hint: 'h' },
    };

    await expect(guarded(async () => outcome, args)).resolves.toBe(outcome);
    expect(logger.lines).toEqual([]);
  });

  it('MUST turn an unexpected throw into an OPAQUE internal error', async () => {
    const { args } = context();
    const leak =
      'MongoServerSelectionError: connect ECONNREFUSED 10.70.0.4:27017';

    const outcome = await guarded(async () => {
      throw new Error(leak);
    }, args);

    expect(outcome.ok).toBe(false);
    const error = outcome.ok ? undefined : outcome.error;
    expect(error?.code).toBe('INTERNAL');
    expect(JSON.stringify(error)).not.toContain('10.70.0.4');
    expect(JSON.stringify(error)).not.toContain('MongoServerSelectionError');
    expect(error?.hint.length).toBeGreaterThan(0);
  });

  it('MUST log the real failure with the tool and the caller (the operator needs it)', async () => {
    const { args, logger } = context();

    await guarded(async () => {
      throw new Error('boom');
    }, args);

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]?.level).toBe('error');
    expect(logger.lines[0]?.fields).toMatchObject({
      tool: 'get_trace',
      subject: 'user_01',
    });
  });

  it('MUST survive a thrown non-Error (a rejected promise with a string)', async () => {
    const { args, logger } = context();

    const outcome = await guarded(async () => {
      throw 'plain string failure';
    }, args);

    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain('plain string failure');
    expect(logger.lines).toHaveLength(1);
  });
});
