import { EnvironmentVariables } from '../../infrastructure/configuration/helpers/environment-setup.js';
import { RecordingLogger } from '@observability/core/common/logging/logging-test-fakes.js';

/**
 * Decision 127 pinned: the trace source is DECLARED, never inferred, and
 * "no source configured" is a crash — never a silent fall-through to the
 * fixture fake. The old chain ended in `: new FakeTraceSourceClient()`,
 * so ONE empty env var made `make sync` "ingest" the shipped demo
 * fixtures into a real client's permanent archive, stamped and billed,
 * with exit code 0 (post-split audit A-1). Every case here fails on a
 * revert to that chain.
 */

const baseConfig: EnvironmentVariables = {
  Environment: 'production',
  clientTimezone: 'America/Sao_Paulo',
  logLevel: 'info',
  logFormat: 'json',
};

// The factory's own logger, recorded: the selection lines are part of the
// contract ("the run's own output must say where the traces came from").
let logger: RecordingLogger;

const loadFactory = async (overrides: Partial<EnvironmentVariables>) => {
  jest.resetModules();
  logger = new RecordingLogger();
  jest.doMock('../../infrastructure/index.js', () => ({
    config: { ...baseConfig, ...overrides },
  }));
  jest.doMock('./logger-factory.js', () => ({
    makeLogger: () => logger,
  }));

  return import('./sync-factory.js');
};

describe('makeTraceSourceClient (decision 127 — declared, never inferred)', () => {
  afterEach(() => {
    jest.dontMock('../../infrastructure/index.js');
    jest.dontMock('./logger-factory.js');
  });

  it('MUST select ClickHouse when the direct source is configured — and say so in the log', async () => {
    const { makeTraceSourceClient } = await loadFactory({
      langwatchClickhouseUrl: 'http://clickhouse:8123',
      langwatchProjectId: 'project_test',
    });

    expect(makeTraceSourceClient().constructor.name).toBe(
      'ClickHouseLangWatchClient',
    );
    expect(logger.messages('info').join('\n')).toContain('ClickHouse');
  });

  it('MUST refuse ClickHouse with a URL but NO project id — a URL alone would drop the tenant filter and ingest EVERY project (audit G-1)', async () => {
    const { makeTraceSourceClient } = await loadFactory({
      langwatchClickhouseUrl: 'http://clickhouse:8123',
    });

    expect(() => makeTraceSourceClient()).toThrow(/No trace source configured/);
  });

  it('MUST treat a whitespace project id as unset — the ECS pre-onboarding SSM placeholder is " ", and filtering by it would be a healthy-looking zero-ingest', async () => {
    const { makeTraceSourceClient } = await loadFactory({
      langwatchClickhouseUrl: 'http://clickhouse:8123',
      langwatchProjectId: ' ',
    });

    expect(() => makeTraceSourceClient()).toThrow(/No trace source configured/);
  });

  it('MUST select the fixture fake ONLY behind the explicit TRACE_SOURCE=fixtures opt-in — loudly', async () => {
    const { makeTraceSourceClient } = await loadFactory({
      traceSource: 'fixtures',
    });

    expect(makeTraceSourceClient().constructor.name).toBe(
      'FakeTraceSourceClient',
    );
    expect(logger.messages('info').join('\n')).toContain('FIXTURE FAKE');
  });

  it('MUST honor the explicit fixtures declaration even when ClickHouse is also configured', async () => {
    const { makeTraceSourceClient } = await loadFactory({
      traceSource: 'fixtures',
      langwatchClickhouseUrl: 'http://clickhouse:8123',
    });

    expect(makeTraceSourceClient().constructor.name).toBe(
      'FakeTraceSourceClient',
    );
  });

  it('MUST throw in production with no source — a backfill must never silently sync fixtures (invariant 6)', async () => {
    const { makeTraceSourceClient } = await loadFactory({});

    expect(() => makeTraceSourceClient()).toThrow(/No trace source configured/);
  });

  it('MUST throw in development too — only jest gets an implicit fake', async () => {
    const { makeTraceSourceClient } = await loadFactory({
      Environment: 'development',
    });

    expect(() => makeTraceSourceClient()).toThrow(/No trace source configured/);
  });

  it("MUST fall back to the fake under jest's test environment (the module route harness seeds through it)", async () => {
    const { makeTraceSourceClient } = await loadFactory({
      Environment: 'test',
    });

    expect(makeTraceSourceClient().constructor.name).toBe(
      'FakeTraceSourceClient',
    );
  });

  it('MUST name both remedies in the crash — the operator fixes it from the message alone', async () => {
    const { makeTraceSourceClient } = await loadFactory({});

    expect(() => makeTraceSourceClient()).toThrow(/LANGWATCH_PROJECT_ID/);
    expect(() => makeTraceSourceClient()).toThrow(/TRACE_SOURCE=fixtures/);
  });
});
