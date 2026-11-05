import {
  BILLING_EXPORT,
  BILLING_READ,
  MANIFEST_ABILITIES,
  TRACING_READ,
} from '../abilities.js';
import { BILLING_LEDGER, TRACING_SESSIONS } from '../capabilities.js';
import {
  PROMPT_NEEDS,
  RESOURCE_NEEDS,
  TOOL_NEEDS,
  reaches,
  surfaceFor,
} from './capabilities.js';
import { testSurface } from './mcp-test-fakes.js';
import { ToolCaller } from './tool-definition.js';

const surface = testSurface();

const caller = (
  master: boolean,
  capabilities?: readonly string[],
): ToolCaller => ({
  subject: 'user_01',
  tenant: 'acme',
  master,
  ...(capabilities !== undefined && { capabilities: new Set(capabilities) }),
});

const namesOf = (seen: { name: string }[] | readonly { name: string }[]) =>
  seen.map((item) => item.name).sort();

describe('who reaches what of the MCP surface (decision 184)', () => {
  it('MUST say whose data every tool, prompt and resource serves (and nothing more)', () => {
    expect(Object.keys(TOOL_NEEDS).sort()).toEqual(namesOf(surface.tools));
    expect(Object.keys(PROMPT_NEEDS).sort()).toEqual(namesOf(surface.prompts));
    expect(Object.keys(RESOURCE_NEEDS).sort()).toEqual(
      namesOf(surface.resources),
    );
  });

  it('MUST keep the whole surface for the master without the claim (off and shadow)', () => {
    const seen = surfaceFor(surface, caller(true));

    expect(seen.tools).toHaveLength(surface.tools.length);
    expect(seen.prompts).toHaveLength(surface.prompts.length);
    expect(seen.resources).toHaveLength(surface.resources.length);
  });

  it('MUST give a person with Tracing only the trace and session reads', () => {
    const seen = surfaceFor(surface, caller(false, [TRACING_SESSIONS]));

    expect(namesOf(seen.tools)).toEqual([
      'get_session',
      'get_session_filter_options',
      'get_trace',
      'get_trace_filter_options',
      'list_sessions',
      'list_traces',
    ]);
    expect(seen.prompts).toEqual([]);
    expect(namesOf(seen.resources)).toEqual(['openapi']);
  });

  it('MUST give a person with Billing the billing reads, and no write', () => {
    const seen = surfaceFor(surface, caller(false, [BILLING_LEDGER]));

    expect(namesOf(seen.tools)).toEqual([
      'export_statement',
      'get_billing_projection',
      'get_billing_series',
      'get_billing_summary',
      'get_overview',
      'list_bills',
      'list_prices',
    ]);
    expect(namesOf(seen.prompts)).toEqual(['explain-bill']);
    expect(namesOf(seen.resources)).toEqual(['bills', 'openapi', 'prices']);
  });

  it('MUST open find-cost-driver only to who reads both the cost and the executions', () => {
    const both = surfaceFor(
      surface,
      caller(false, [BILLING_LEDGER, TRACING_SESSIONS]),
    );

    expect(namesOf(both.prompts)).toEqual(['explain-bill', 'find-cost-driver']);
  });

  it('MUST keep the writes the master’s, even with the capability', () => {
    expect(
      reaches(caller(false, [BILLING_LEDGER]), TOOL_NEEDS['register_price']),
    ).toBe(false);
    expect(
      reaches(caller(true, [BILLING_LEDGER]), TOOL_NEEDS['register_price']),
    ).toBe(true);
  });

  it('MUST limit the master to the claim too, when khal-auth sent one', () => {
    expect(
      reaches(caller(true, [TRACING_SESSIONS]), TOOL_NEEDS['list_bills']),
    ).toBe(false);
  });

  it('MUST close on an empty claim (a malformed one reads as empty) and on an unknown name', () => {
    const seen = surfaceFor(surface, caller(false, []));

    expect(seen.tools).toEqual([]);
    expect(seen.prompts).toEqual([]);
    expect(namesOf(seen.resources)).toEqual(['openapi']);
    expect(reaches(caller(true), undefined)).toBe(false);
  });
});

describe('what the company chose for a person (decision 185)', () => {
  const withAbilities = (
    master: boolean,
    abilities: readonly string[],
  ): ToolCaller => ({
    subject: 'user_01',
    tenant: 'acme',
    master,
    abilities: new Set(abilities),
  });

  it('MUST need only what the manifest declares', () => {
    const declared = MANIFEST_ABILITIES.items.map((item) => item.id as string);
    const needed = [
      ...Object.values(TOOL_NEEDS),
      ...Object.values(PROMPT_NEEDS),
      ...Object.values(RESOURCE_NEEDS),
    ].flatMap((need) => need.abilities);

    expect([...new Set(needed)].sort()).toEqual([...declared].sort());
  });

  it('MUST declare areas for every ability, as the Module Catalog demands', () => {
    const areas = MANIFEST_ABILITIES.areas.map((area) => area.id as string);

    for (const item of MANIFEST_ABILITIES.items) {
      expect(areas).toContain(item.id.split('.')[0]);
    }
  });

  it('MUST give "Ver traces e sessões" only the trace and session reads', () => {
    const seen = surfaceFor(surface, withAbilities(false, [TRACING_READ]));

    expect(namesOf(seen.tools)).toEqual([
      'get_session',
      'get_session_filter_options',
      'get_trace',
      'get_trace_filter_options',
      'list_sessions',
      'list_traces',
    ]);
    expect(seen.prompts).toEqual([]);
    expect(namesOf(seen.resources)).toEqual(['openapi']);
  });

  it('MUST keep the statement out of "Ver faturamento" alone', () => {
    const seen = surfaceFor(surface, withAbilities(false, [BILLING_READ]));

    expect(namesOf(seen.tools)).toEqual([
      'get_billing_projection',
      'get_billing_series',
      'get_billing_summary',
      'get_overview',
      'list_bills',
      'list_prices',
    ]);
    expect(namesOf(seen.prompts)).toEqual(['explain-bill']);
    expect(namesOf(seen.resources)).toEqual(['bills', 'openapi', 'prices']);
  });

  it('MUST give "Exportar extrato" the statement and nothing else of billing', () => {
    const seen = surfaceFor(surface, withAbilities(false, [BILLING_EXPORT]));

    expect(namesOf(seen.tools)).toEqual(['export_statement']);
    expect(seen.prompts).toEqual([]);
  });

  it('MUST open find-cost-driver only with the cost and the executions', () => {
    const both = surfaceFor(
      surface,
      withAbilities(false, [BILLING_READ, TRACING_READ]),
    );

    expect(namesOf(both.prompts)).toEqual(['explain-bill', 'find-cost-driver']);
  });

  it('MUST keep the writes the master’s, whatever the abilities', () => {
    const everything = [BILLING_READ, BILLING_EXPORT, TRACING_READ];

    expect(
      reaches(withAbilities(false, everything), TOOL_NEEDS['register_price']),
    ).toBe(false);
    expect(
      reaches(withAbilities(true, everything), TOOL_NEEDS['register_price']),
    ).toBe(true);
  });

  it('MUST close on an empty claim, and let it decide over old capabilities', () => {
    const seen = surfaceFor(surface, withAbilities(false, []));

    expect(seen.tools).toEqual([]);
    expect(seen.prompts).toEqual([]);
    expect(namesOf(seen.resources)).toEqual(['openapi']);
    expect(
      reaches(
        {
          ...withAbilities(false, []),
          capabilities: new Set([BILLING_LEDGER]),
        },
        TOOL_NEEDS['list_bills'],
      ),
    ).toBe(false);
  });

  it('MUST restrict nothing but the writes when the token has no abilities at all', () => {
    const seen = surfaceFor(surface, caller(false));

    expect(namesOf(seen.tools)).toContain('export_statement');
    expect(namesOf(seen.tools)).not.toContain('register_price');
  });
});
