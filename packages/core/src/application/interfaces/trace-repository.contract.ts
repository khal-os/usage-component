import { InsertIfAbsentResult, TraceRepository } from './trace-repository.js';
import {
  StampedTokenCost,
  TraceModel,
} from '../../domain/models/trace-model.js';

/**
 * The skipped branch is one outcome in two spellings (audit B-4 residual):
 * bare 'skipped', or the object form carrying the stored token total for
 * divergence visibility. The contract accepts both.
 */
const outcomeOf = (result: InsertIfAbsentResult): 'inserted' | 'skipped' =>
  typeof result === 'string' ? result : result.outcome;

/**
 * ADAPTER-AGNOSTIC contract suite for TraceRepository — the executable
 * specification of the invariants every storage backend must uphold:
 * idempotent ingestion (invariant: re-sync never double-counts), stamp
 * immutability (invariants 1/7), pending-never-R$0 (invariant 2) and the
 * merged-document unclassified recompute. The Mongo adapter runs it today;
 * any future adapter (Postgres, ...) runs the SAME suite with its own
 * harness — the invariant proofs are written once, against the port.
 *
 * Harness notes:
 * - readTrace returns the adapter's stored record using MODEL field names;
 *   how absence is stored (null vs missing) is the adapter's business —
 *   assertions here normalize with `?? null`.
 * - applyRawCorrection simulates the open-period runbook correction done
 *   directly in the store (sets agent {id}, removes the unclassified flag)
 *   so the "never re-flag a stored correction" rule is provable.
 */
export interface TraceRepositoryHarness {
  repository: TraceRepository;
  readTrace(traceId: string): Promise<Record<string, unknown> | null>;
  applyRawCorrection(traceId: string, agentId: string): Promise<void>;
  reset(): Promise<void>;
}

const JUNE_1 = new Date('2026-06-01T00:00:00.000Z');

export const makeContractStampedCosts = (): StampedTokenCost[] => [
  {
    tokenType: 'input',
    tokens: 1200,
    appliedPriceMicrocentsPerMillion: 275_000_000,
    appliedPriceEffectiveFrom: JUNE_1,
    costMicrocents: 330_000,
  },
];

export const makeContractTrace = (
  overrides: Partial<TraceModel> = {},
): TraceModel => {
  const traceId = overrides.traceId ?? 'trace-001';

  return {
    traceId,
    sessionId: 'sess-001',
    agent: {
      id: 'agent-atendimento',
      version: '1.4.2',
      instance: 'agent-atendimento-7d9f4b-k2xp8',
    },
    model: { id: 'gpt-5-mini', provider: 'openai' },
    type: 'chat',
    channel: {
      type: 'whatsapp',
      version: '3.2.0',
      instance: 'omni-wa-6b4c9f-r3zs5',
    },
    domain: 'varejo',
    startedAt: new Date('2026-06-05T14:00:00.000Z'),
    finishedAt: new Date('2026-06-05T14:00:04.000Z'),
    durationMs: 4000,
    status: 'ok',
    tokens: { input: 1200 },
    tokensTotal: 1200,
    pricingStatus: 'stamped',
    stampedCosts: makeContractStampedCosts(),
    totalCostMicrocents: 330_000,
    stampedAt: new Date('2026-07-01T00:00:00.000Z'),
    ingestedAt: new Date('2026-07-01T00:00:00.000Z'),
    input: 'entrada',
    output: 'saída',
    spans: [
      {
        spanId: `span-${traceId}`,
        type: 'llm',
        name: 'openai/gpt-5-mini',
        startedAt: new Date('2026-06-05T14:00:00.100Z'),
        finishedAt: new Date('2026-06-05T14:00:03.900Z'),
        durationMs: 3800,
        offsetMs: 100,
        status: 'ok',
        tokens: { input: 1200 },
      },
    ],
    ...overrides,
  };
};

const makePending = (overrides: Partial<TraceModel> = {}): TraceModel =>
  makeContractTrace({
    pricingStatus: 'pending_price',
    stampedCosts: undefined,
    totalCostMicrocents: undefined,
    stampedAt: undefined,
    ...overrides,
  });

type AgentRecord =
  | { id?: string; version?: string | null; instance?: string | null }
  | null
  | undefined;

export const runTraceRepositoryContract = (
  makeHarness: () => TraceRepositoryHarness,
): void => {
  describe('TraceRepository contract', () => {
    let harness: TraceRepositoryHarness;

    beforeEach(async () => {
      harness = makeHarness();
      await harness.reset();
    });

    describe('insertIfAbsent()', () => {
      it('MUST persist the SELF-CONTAINED trace on first ingestion', async () => {
        const result =
          await harness.repository.insertIfAbsent(makeContractTrace());

        expect(result).toBe('inserted');

        const stored = await harness.readTrace('trace-001');

        expect(stored?.['input']).toBe('entrada');
        expect(stored?.['spans']).toHaveLength(1);
        expect((stored?.['spans'] as { spanId: string }[])[0]?.spanId).toBe(
          'span-trace-001',
        );
      });

      it('MUST skip an already-ingested trace and change NOTHING (idempotency)', async () => {
        await harness.repository.insertIfAbsent(makeContractTrace());

        const tampered = makeContractTrace({ totalCostMicrocents: 999_999 });
        const result = await harness.repository.insertIfAbsent(tampered);

        expect(outcomeOf(result)).toBe('skipped');

        // Object-form skips MUST report the STORED total (audit B-4
        // residual: divergence visibility) — never the incoming payload's.
        if (typeof result === 'object') {
          expect(result.storedTokensTotal).toBe(1200);
        }

        const stored = await harness.readTrace('trace-001');

        expect(stored?.['totalCostMicrocents']).toBe(330_000);
        expect(stored?.['spans']).toHaveLength(1); // spans untouched too
      });

      it('MUST store pending_price traces with the cost OPEN — never R$ 0 (invariant 2)', async () => {
        await harness.repository.insertIfAbsent(
          makePending({
            traceId: 'trace-pending',
            model: { id: 'llama-4-scout', provider: 'meta' },
          }),
        );

        const stored = await harness.readTrace('trace-pending');

        expect(stored?.['pricingStatus']).toBe('pending_price');
        expect(stored?.['totalCostMicrocents'] ?? null).toBeNull();
        expect(stored?.['stampedCosts'] ?? null).toBeNull();
        expect(stored?.['tokens']).toEqual({ input: 1200 });
      });
    });

    describe('updateAttribution()', () => {
      it('MUST update attribution fields and NEVER touch the stamp (invariant 7)', async () => {
        await harness.repository.insertIfAbsent(makeContractTrace());

        await harness.repository.updateAttribution('trace-001', {
          agent: { id: 'agent-corrigido', version: '9.9.9' },
          domain: 'varejo-corrigido',
        });

        const stored = await harness.readTrace('trace-001');
        const agent = stored?.['agent'] as AgentRecord;

        // The agent is replaced as a WHOLE canonical block: the previously
        // stored instance must NOT survive the correction.
        expect(agent?.id).toBe('agent-corrigido');
        expect(agent?.version ?? null).toBe('9.9.9');
        expect(agent?.instance ?? null).toBeNull();
        expect(stored?.['domain']).toBe('varejo-corrigido');
        expect(stored?.['totalCostMicrocents']).toBe(330_000);
        expect(stored?.['stampedCosts']).toHaveLength(1);
      });

      it("MUST refuse the MODEL half of a refresh on a STAMPED trace — the stored model is part of the stamp's meaning (audit A-5)", async () => {
        // The default contract trace is stamped at gpt-5-mini's prices.
        // Re-sync is the steady state, and a later cycle reporting a
        // corrected model must NOT re-attribute the frozen money: billing
        // groups by model, and the stamp does not record which model key
        // its prices were resolved for — the drift would be undetectable.
        await harness.repository.insertIfAbsent(makeContractTrace());

        const update = await harness.repository.updateAttribution('trace-001', {
          agent: { id: 'agent-corrigido' },
          model: { id: 'claude-sonnet-5', provider: 'anthropic' },
        });

        expect(update.modelPinnedByStamp).toBe(true);

        const stored = await harness.readTrace('trace-001');

        // The model the prices were resolved for survives; the mutable
        // half of the refresh (invariant 7) still lands.
        expect(stored?.['model']).toEqual({
          id: 'gpt-5-mini',
          provider: 'openai',
        });
        expect((stored?.['agent'] as AgentRecord)?.id).toBe('agent-corrigido');
        expect(stored?.['totalCostMicrocents']).toBe(330_000);
      });

      it('MUST still accept a model refresh while the trace is PENDING — that is how it becomes stampable', async () => {
        await harness.repository.insertIfAbsent(
          makePending({ traceId: 'trace-pending-model', model: undefined }),
        );

        const update = await harness.repository.updateAttribution(
          'trace-pending-model',
          { model: { id: 'gpt-5-mini', provider: 'openai' } },
        );

        expect(update.modelPinnedByStamp).toBe(false);

        const stored = await harness.readTrace('trace-pending-model');

        expect(stored?.['model']).toEqual({
          id: 'gpt-5-mini',
          provider: 'openai',
        });
      });

      it('MUST clear the unclassified flag once attribution is complete', async () => {
        await harness.repository.insertIfAbsent(
          makeContractTrace({
            agent: undefined,
            unclassified: { reasons: ['missing agentId'] },
          }),
        );

        await harness.repository.updateAttribution('trace-001', {
          agent: { id: 'agent-atendimento' },
        });

        const stored = await harness.readTrace('trace-001');
        const agent = stored?.['agent'] as AgentRecord;

        expect(agent?.id).toBe('agent-atendimento');
        expect(agent?.version ?? null).toBeNull();
        expect(agent?.instance ?? null).toBeNull();
        expect(stored?.['unclassified'] ?? null).toBeNull();
      });

      it('MUST NOT clear a missing-model flag while the stored model is still absent', async () => {
        await harness.repository.insertIfAbsent(
          makePending({
            model: undefined,
            unclassified: { reasons: ['missing model'] },
          }),
        );

        // Fresh payload fixes the agent but STILL lacks the model.
        await harness.repository.updateAttribution('trace-001', {
          agent: { id: 'agent-novo' },
        });

        const stored = await harness.readTrace('trace-001');
        const agent = stored?.['agent'] as AgentRecord;

        expect(agent?.id).toBe('agent-novo');
        expect(agent?.version ?? null).toBeNull();
        expect(agent?.instance ?? null).toBeNull();
        expect(stored?.['unclassified']).toEqual({
          reasons: ['missing model'],
        });
      });

      it('MUST NOT revert a runbook correction when the re-synced payload still CARRIES the stale value (decision 79)', async () => {
        await harness.repository.insertIfAbsent(
          makeContractTrace({
            agent: { id: 'agent-errado' },
          }),
        );

        // Open-period correction applied directly to the store (invariant
        // 7) — stamps attributionCorrectedAt per the runbook convention.
        await harness.applyRawCorrection('trace-001', 'agent-corrigido');

        // Any window re-sync (or the batch loop's crash-replay) delivers
        // the source payload again — which still holds the WRONG agent.
        await harness.repository.updateAttribution('trace-001', {
          agent: { id: 'agent-errado' },
          domain: 'dominio-do-source',
        });

        const stored = await harness.readTrace('trace-001');

        expect((stored?.['agent'] as AgentRecord)?.id).toBe('agent-corrigido');
        // The whole refresh is skipped — a corrected trace belongs to the
        // operator, not the source.
        expect(stored?.['domain']).not.toBe('dominio-do-source');
      });

      it('MUST NOT re-flag attribution corrected in the store when the payload lacks it', async () => {
        await harness.repository.insertIfAbsent(
          makeContractTrace({
            agent: undefined,
            unclassified: { reasons: ['missing agentId'] },
          }),
        );

        // Open-period correction applied directly to the store (invariant 7)
        await harness.applyRawCorrection('trace-001', 'agent-corrigido');

        // Re-sync arrives with a payload that STILL lacks agentId
        await harness.repository.updateAttribution('trace-001', {});

        const stored = await harness.readTrace('trace-001');

        expect((stored?.['agent'] as AgentRecord)?.id).toBe('agent-corrigido');
        expect(stored?.['unclassified'] ?? null).toBeNull();
      });

      it('MUST persist a late-arriving model so reprocessing can stamp the trace', async () => {
        await harness.repository.insertIfAbsent(
          makePending({
            model: undefined,
            unclassified: { reasons: ['missing model'] },
          }),
        );

        await harness.repository.updateAttribution('trace-001', {
          model: { id: 'gpt-5-mini', provider: 'openai' },
        });

        const stored = await harness.readTrace('trace-001');

        expect(stored?.['model']).toEqual({
          id: 'gpt-5-mini',
          provider: 'openai',
        });
        expect(stored?.['unclassified'] ?? null).toBeNull();
        expect(stored?.['pricingStatus']).toBe('pending_price');
      });
    });

    describe('stampPendingTrace()', () => {
      const GPT = { id: 'gpt-5-mini', provider: 'openai' };

      it('MUST stamp a pending trace exactly once — a stamped trace is immutable (invariant 1)', async () => {
        await harness.repository.insertIfAbsent(
          makePending({
            traceId: 'trace-pending',
            pendingPrice: { missingTokenTypes: ['input'] },
          }),
        );

        const first = await harness.repository.stampPendingTrace(
          'trace-pending',
          {
            stampedCosts: makeContractStampedCosts(),
            totalCostMicrocents: 330_000,
            stampedAt: new Date('2026-07-02T00:00:00.000Z'),
          },
          GPT,
        );

        expect(first).toBe('stamped');

        const second = await harness.repository.stampPendingTrace(
          'trace-pending',
          {
            stampedCosts: makeContractStampedCosts(),
            totalCostMicrocents: 999_999,
            stampedAt: new Date('2026-07-03T00:00:00.000Z'),
          },
          GPT,
        );

        expect(second).toBe('skipped');

        const stored = await harness.readTrace('trace-pending');

        expect(stored?.['totalCostMicrocents']).toBe(330_000);
        expect(stored?.['pendingPrice'] ?? null).toBeNull();
      });

      it('audit B-5: a CONCURRENT model correction makes the pinned CAS miss — the next sweep stamps with the fresh model', async () => {
        await harness.repository.insertIfAbsent(
          makePending({ traceId: 'trace-pinned' }),
        );

        // The sweep read the trace with model GPT and resolved GPT prices;
        // BETWEEN that read and its write, an attribution correction lands
        // (legal: trace pending, month open — invariant 7).
        await harness.repository.updateAttribution('trace-pinned', {
          model: { id: 'claude-haiku-4-5', provider: 'anthropic' },
        });

        const stale = await harness.repository.stampPendingTrace(
          'trace-pinned',
          {
            stampedCosts: makeContractStampedCosts(),
            totalCostMicrocents: 330_000,
            stampedAt: new Date('2026-07-02T00:00:00.000Z'),
          },
          GPT, // the model the (now stale) prices were resolved for
        );

        // Without the pin this would stamp GPT prices — immutably — onto a
        // claude trace whose per-line math would "check out" forever.
        expect(stale).toBe('skipped');

        const stored = await harness.readTrace('trace-pinned');
        expect(stored?.['pricingStatus']).toBe('pending_price');
        expect(stored?.['totalCostMicrocents'] ?? null).toBeNull();

        // The NEXT sweep re-reads fresh and stamps against the corrected
        // model.
        const fresh = await harness.repository.stampPendingTrace(
          'trace-pinned',
          {
            stampedCosts: makeContractStampedCosts(),
            totalCostMicrocents: 440_000,
            stampedAt: new Date('2026-07-02T01:00:00.000Z'),
          },
          { id: 'claude-haiku-4-5', provider: 'anthropic' },
        );

        expect(fresh).toBe('stamped');
        expect(
          (await harness.readTrace('trace-pinned'))?.['totalCostMicrocents'],
        ).toBe(440_000);
      });

      it('audit B-5: a model-less pending trace pins the stored null model', async () => {
        await harness.repository.insertIfAbsent(
          makePending({ traceId: 'trace-no-model', model: undefined }),
        );

        // Pinning a MODEL against a model-less trace must miss...
        expect(
          await harness.repository.stampPendingTrace(
            'trace-no-model',
            {
              stampedCosts: makeContractStampedCosts(),
              totalCostMicrocents: 330_000,
              stampedAt: new Date('2026-07-02T00:00:00.000Z'),
            },
            GPT,
          ),
        ).toBe('skipped');

        // ...while the null pin matches the stored absence exactly.
        expect(
          await harness.repository.stampPendingTrace(
            'trace-no-model',
            {
              stampedCosts: makeContractStampedCosts(),
              totalCostMicrocents: 330_000,
              stampedAt: new Date('2026-07-02T00:00:00.000Z'),
            },
            null,
          ),
        ).toBe('stamped');
      });
    });

    describe('findPendingPrice()', () => {
      it('MUST return only pending traces, oldest first', async () => {
        await harness.repository.insertIfAbsent(makeContractTrace());
        await harness.repository.insertIfAbsent(
          makePending({
            traceId: 'trace-pending-2',
            startedAt: new Date('2026-06-10T00:00:00.000Z'),
          }),
        );
        await harness.repository.insertIfAbsent(
          makePending({
            traceId: 'trace-pending-1',
            startedAt: new Date('2026-06-08T00:00:00.000Z'),
          }),
        );

        const pending = await harness.repository.findPendingPrice(100);

        expect(pending.map((trace) => trace.traceId)).toEqual([
          'trace-pending-1',
          'trace-pending-2',
        ]);
      });

      it('MUST page strictly after the (startedAt, traceId) cursor, ties broken by traceId', async () => {
        const tie = new Date('2026-06-08T00:00:00.000Z');
        for (const traceId of ['trace-b', 'trace-a', 'trace-c']) {
          await harness.repository.insertIfAbsent(
            makePending({ traceId, startedAt: tie }),
          );
        }
        await harness.repository.insertIfAbsent(
          makePending({
            traceId: 'trace-later',
            startedAt: new Date('2026-06-09T00:00:00.000Z'),
          }),
        );

        const page = await harness.repository.findPendingPrice(2, {
          startedAt: tie,
          traceId: 'trace-a',
        });

        expect(page.map((trace) => trace.traceId)).toEqual([
          'trace-b',
          'trace-c',
        ]);
      });

      it('decision 183: MUST narrow to one model when filter.model is given', async () => {
        await harness.repository.insertIfAbsent(
          makePending({ traceId: 'trace-gpt' }),
        );
        await harness.repository.insertIfAbsent(
          makePending({
            traceId: 'trace-sonnet',
            model: { id: 'claude-sonnet-4-6', provider: 'anthropic' },
          }),
        );

        const page = await harness.repository.findPendingPrice(10, undefined, {
          model: { id: 'claude-sonnet-4-6', provider: 'anthropic' },
        });

        expect(page.map((trace) => trace.traceId)).toEqual(['trace-sonnet']);
      });

      it('decision 183: MUST drop traces with no model when filter.withModelOnly is set', async () => {
        await harness.repository.insertIfAbsent(
          makePending({ traceId: 'trace-no-model', model: undefined }),
        );
        await harness.repository.insertIfAbsent(
          makePending({ traceId: 'trace-with-model' }),
        );

        const page = await harness.repository.findPendingPrice(10, undefined, {
          withModelOnly: true,
        });

        expect(page.map((trace) => trace.traceId)).toEqual([
          'trace-with-model',
        ]);
      });
    });
  });
};
