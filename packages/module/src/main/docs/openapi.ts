import { readFileSync } from 'node:fs';
import { TOKEN_TYPES } from '@observability/core/domain/models/price-version-model.js';
import path from 'node:path';
import { z } from 'zod';
import {
  apiErrorSchema,
  healthResponseSchema,
} from '../../presentation/helpers/docs-schemas.js';
import {
  traceDetailResponseSchema,
  traceFilterOptionsResponseSchema,
  traceListResponseSchema,
} from '../../presentation/controllers/traces/trace-view-schemas.js';
import {
  sessionDetailResponseSchema,
  sessionFilterOptionsResponseSchema,
  sessionListResponseSchema,
} from '../../presentation/controllers/sessions/session-view-schemas.js';
import {
  billListResponseSchema,
  billingProjectionResponseSchema,
  billingSeriesResponseSchema,
  billingSummaryResponseSchema,
} from '../../presentation/controllers/billing/billing-view-schemas.js';
import {
  listPriceVersionsResponseSchema,
  registerPriceVersionRequestSchema,
  registerPriceVersionResponseSchema,
} from '../../presentation/controllers/prices/price-view-schemas.js';

/**
 * The OpenAPI document is GENERATED from the presentation-layer response
 * schemas (zod → JSON Schema 2020-12, native to OpenAPI 3.1) — the same
 * strict schemas the contract tests parse real responses with. Docs,
 * validation and code share one source of truth; drift fails the suite.
 */
const toSchema = (schema: z.ZodType) => z.toJSONSchema(schema);

/** Request bodies document the INPUT side (transforms parse at the edge). */
const toRequestSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: 'input' });

/**
 * info.version mirrors the package version — one number, not two (C-4.1).
 * Read from disk relative to the process cwd: every entry point (npm
 * scripts, jest, the container CMD) runs from packages/module — the same
 * contract environment-setup.ts already relies on for .env files.
 */
const packageVersion = (): string =>
  (
    JSON.parse(
      readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string }
  ).version;

/**
 * ONE spelling of the calendar-month address (audit D-5): the statement
 * documented bare integers while /billing/summary documented the bounds —
 * the same params, two stories, in the same file. Mirrors
 * yearMonthQueryShape (1970-9999 / 1-12), which is what the controllers
 * actually enforce.
 */
const yearParam = (required = true) => ({
  name: 'year',
  in: 'query',
  required,
  schema: { type: 'integer', minimum: 1970, maximum: 9999 },
  description: 'Calendar year (UTC).',
});

const monthParam = (required = true) => ({
  name: 'month',
  in: 'query',
  required,
  schema: { type: 'integer', minimum: 1, maximum: 12 },
  description: 'Calendar month (1-12).',
});

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: toSchema(apiErrorSchema) } },
});

/**
 * Shared 401 (C-4.1): auth is env-gated — active only when the deployment
 * points at khal-auth (KHAL_AUTH_URL); without it the API answers open (PoC
 * behavior) and this response never occurs.
 */
const unauthorizedResponse = () =>
  errorResponse(
    'Bearer session token missing or rejected. Only occurs when ' +
      'KHAL_AUTH_URL is configured in the deployment — without it the API ' +
      'answers open (PoC behavior).',
  );

const okResponse = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema: toSchema(schema) } },
});

const queryParam = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  required = false,
) => ({ name, in: 'query', description, required, schema });

/** Multi-value filter: repeat the param for OR (?agent=a&agent=b). */
const listQueryParam = (name: string, description: string) => ({
  name,
  in: 'query',
  description,
  required: false,
  schema: { type: 'array', items: { type: 'string' } },
  style: 'form',
  explode: true,
});

const pathParam = (name: string, description: string) => ({
  name,
  in: 'path',
  description,
  required: true,
  schema: { type: 'string' },
});

const paginationParams = [
  queryParam('page', 'Página (1-based).', { type: 'integer', minimum: 1, default: 1 }),
  queryParam('page_size', 'Itens por página (máx. 100).', {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
  }),
];

const periodParams = [
  queryParam('from', 'Início do período (inclusivo, ISO 8601, UTC).', {
    type: 'string',
    format: 'date-time',
  }),
  queryParam('to', 'Fim do período (exclusivo, ISO 8601, UTC).', {
    type: 'string',
    format: 'date-time',
  }),
];

/** Shared by GET /traces and GET /traces/filters (decision 76). */
const traceFilterParams = [
  ...periodParams,
  listQueryParam('agent', 'Ids de agente (repita o parâmetro para OR).'),
  queryParam('status', 'Status de execução.', {
    type: 'string',
    enum: ['ok', 'error'],
  }),
  listQueryParam('type', 'Tipos de trace (repita o parâmetro para OR).'),
  listQueryParam(
    'channel',
    'Tipos de canal (whatsapp/web/...; repita o parâmetro para OR).',
  ),
  listQueryParam(
    'domain',
    'Domínios (match exato; repita o parâmetro para OR).',
  ),
  listQueryParam(
    'subdomain',
    'Subdomínios (match exato; repita o parâmetro para OR).',
  ),
  queryParam('search', 'Busca exata por id de trace OU de sessão.', {
    type: 'string',
  }),
  queryParam(
    'quarantined',
    'Quarentena NÃO resolvida (decisão 100 — audit D-9): true = só os ' +
      'stragglers que o quarantined_trace_count da fatura aponta; false = ' +
      'todo o resto.',
    { type: 'string', enum: ['true', 'false'] },
  ),
];

/** Shared by GET /sessions and GET /sessions/filters. */
const sessionFilterParams = [
  ...periodParams,
  queryParam('agent', 'Filtra pelo id do agente da sessão.', {
    type: 'string',
  }),
  queryParam('status', 'error se QUALQUER trace da sessão falhou.', {
    type: 'string',
    enum: ['ok', 'error'],
  }),
];

export const buildOpenApiDocument = (clientName?: string) => ({
  openapi: '3.1.0',
  info: {
    // The deployment's client name (env-injected) brands the docs of this
    // single-tenant instance; without it, the generic module title.
    title: clientName
      ? `Módulo de Observabilidade — ${clientName.toUpperCase()}`
      : 'Módulo de Observabilidade — API',
    version: packageVersion(),
    description:
      'Uma API, três faces: Billing (quanto custou), Traces (as execuções ' +
      'reais) e Sessions (as conversas). Todos os valores client-facing são ' +
      'em R$; custos vêm do carimbo de preço aplicado na ingestão (imutável). ' +
      'Traces sem preço aplicável aparecem como pending_price — nunca R$ 0,00; ' +
      'traces com modelo mas zero tokens medidos aparecem como ' +
      'no_measured_usage (decisão 128) — custo desconhecido, fora dos totais, ' +
      'sem bloquear o fechamento. ' +
      'Comportamento global: método errado em um caminho conhecido responde ' +
      '405 com o header Allow (não repetido por operação).',
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Env-gated session auth: required only when the deployment ' +
          'configures KHAL_AUTH_URL — the token is a khal-auth session JWT ' +
          'verified locally against the JWKS at ' +
          '{KHAL_AUTH_URL}/.well-known/jwks.json (RS256; iss, aud and ' +
          'tenant claims checked; identity-only, no scopes). Without the ' +
          'variable the API answers open (PoC). The docs routes ' +
          '(/api/v1/docs* and openapi.json) and GET /health stay open — ' +
          'liveness and the healthcheck need no token (decisions 103/172).',
      },
    },
  },
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Traces', description: 'Execuções reais por trás dos números.' },
    { name: 'Sessions', description: 'Conversas: traces agrupados por sessão (read-model derivado).' },
    { name: 'Billing', description: 'Agregados mensais — soma dos custos carimbados, por construção.' },
    { name: 'Prices', description: 'Tabela de preços contratados (T4) — versões imutáveis por vigência.' },
    { name: 'Health', description: 'Sonda de vida — aberta por convenção da plataforma (decisão 172).' },
  ],
  paths: {
    '/api/v1/traces': {
      get: {
        tags: ['Traces'],
        summary: 'Lista traces (recente primeiro)',
        description:
          'Totais LIMITADOS (decisão 77/79, emendadas pela 116): a contagem ' +
          'para em 10.000 em QUALQUER consulta, COM ou SEM filtros. Até o ' +
          'teto o total é exato e `total_capped` é false; a partir dele a ' +
          'resposta traz `total: 10000`, `total_capped: true` e os displays ' +
          'com sufixo "+" ("10.000+") — o número honesto do arquivo é ' +
          '`total_display`, não `total`. O horizonte é o mesmo da guarda de ' +
          'profundidade (decisão 79): a API nunca anuncia uma página que ' +
          'recusaria servir.',
        parameters: [...traceFilterParams, ...paginationParams],
        responses: {
          '200': okResponse('Página de traces.', traceListResponseSchema),
          '400': errorResponse('Parâmetro de consulta inválido.'),
          '401': unauthorizedResponse(),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/traces/filters': {
      get: {
        tags: ['Traces'],
        summary: 'Opções dos dropdowns de filtro (valores armazenados + contagens)',
        description:
          'Valores distintos por campo filtrável (incluindo statuses), com ' +
          'contagem por opção, servidos pelo cubo de contadores mantido na ' +
          'ingestão (decisão 77). Cascata com auto-exclusão: as opções do ' +
          'campo X honram todos os filtros EXCETO o do próprio X — um ' +
          'dropdown selecionado continua listando suas alternativas. Cada ' +
          'contagem é um "e se": traces que casariam com aquele valor ' +
          'combinado aos filtros dos OUTROS campos. Período (from/to) é ' +
          'arredondado PARA FORA em dias UTC inteiros neste endpoint; a ' +
          'listagem mantém timestamps exatos.',
        parameters: [...traceFilterParams],
        responses: {
          '200': okResponse(
            'Opções por campo.',
            traceFilterOptionsResponseSchema,
          ),
          '400': errorResponse('Parâmetro de consulta inválido.'),
          '401': unauthorizedResponse(),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/traces/{id}': {
      get: {
        tags: ['Traces'],
        summary: 'Anatomia completa de um trace',
        description:
          'Métricas, blocos de agente/canal (build e instância que serviram a ' +
          'execução), spans ordenados, conteúdo integral e a conta do custo ' +
          '(preço aplicado × tokens, precisão cheia por linha).',
        parameters: [pathParam('id', 'Id do trace.')],
        responses: {
          '200': okResponse('Trace completo.', traceDetailResponseSchema),
          '400': errorResponse('Parâmetro de consulta desconhecido.'),
          '401': unauthorizedResponse(),
          '404': errorResponse('Trace não encontrado.'),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/sessions': {
      get: {
        tags: ['Sessions'],
        summary: 'Lista sessões (conversas)',
        description:
          'Período filtra pelo INÍCIO da sessão (QA17). Sessão com traces ' +
          'pendentes de preço expõe cost_brl null + parcial — nunca um total ' +
          'que se leia como R$ 0,00 final.',
        parameters: [...sessionFilterParams, ...paginationParams],
        responses: {
          '200': okResponse('Página de sessões.', sessionListResponseSchema),
          '400': errorResponse('Parâmetro de consulta inválido.'),
          '401': unauthorizedResponse(),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/sessions/filters': {
      get: {
        tags: ['Sessions'],
        summary: 'Opções dos dropdowns de filtro de sessões',
        description:
          'Valores distintos de agente e status com contagem de SESSÕES por ' +
          'opção, servidos pelo read-model materializado (decisão 80). ' +
          'Cascata com auto-exclusão (decisão 76): as opções do campo X ' +
          'honram todos os filtros EXCETO o do próprio X.',
        parameters: [...sessionFilterParams],
        responses: {
          '200': okResponse(
            'Opções por campo.',
            sessionFilterOptionsResponseSchema,
          ),
          '400': errorResponse('Parâmetro de consulta inválido.'),
          '401': unauthorizedResponse(),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/sessions/{id}': {
      get: {
        tags: ['Sessions'],
        summary: 'Sessão com a cadeia cronológica de traces',
        parameters: [pathParam('id', 'Id da sessão.')],
        responses: {
          '200': okResponse('Agregados + cadeia (transcrição).', sessionDetailResponseSchema),
          '400': errorResponse('Parâmetro de consulta desconhecido.'),
          '401': unauthorizedResponse(),
          '404': errorResponse('Sessão não encontrada.'),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/bills': {
      get: {
        tags: ['Billing'],
        summary: 'Lista de meses/faturas com status do período (recente primeiro)',
        description:
          'Uma fatura por mês-calendário (UTC). Status (T6/T7): closed = ' +
          'final, servida do snapshot verbatim; in_progress = mês corrente, ' +
          'parcial; open = mês passado aguardando fechamento. Total ≡ soma ' +
          'dos carimbos (aberto) ou número congelado do snapshot (fechado); ' +
          'pendentes contados à parte, fora do total; quarentena visível.',
        responses: {
          '200': okResponse('Faturas.', billListResponseSchema),
          '400': errorResponse('Parâmetro de consulta desconhecido (o endpoint não aceita parâmetros).'),
          '401': unauthorizedResponse(),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/billing/summary': {
      get: {
        tags: ['Billing'],
        summary:
          'Extrato do mês: total, % por agente, linhas qty × preço, mix, cache, comparação',
        description:
          'T7: mês FECHADO servido exclusivamente do snapshot (nunca ' +
          'recalculado); mês aberto computado ao vivo pelo MESMO motor sobre ' +
          'os mesmos carimbos. Linhas (US8) = agente × versão × modelo × ' +
          'tipo de token × preço aplicado (troca de preço no mês gera linhas ' +
          'separadas). Partes exibidas fecham com o total exibido (largest ' +
          'remainder); % por agente reconciliada a 100%. Inclui mix de ' +
          'modelos (US15), economia de cache (T9/QA7), comparação com o mês ' +
          'anterior (US10), watermark (US2/US6) e notas de reabertura (US5).',
        parameters: [yearParam(), monthParam()],
        responses: {
          '200': okResponse('Extrato do mês.', billingSummaryResponseSchema),
          '400': errorResponse('Ano/mês ausentes, malformados ou parâmetro desconhecido.'),
          '401': unauthorizedResponse(),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/billing/series': {
      get: {
        tags: ['Billing'],
        summary:
          'Série de custo — mensal (total/agente/modelo) ou diária, barras empilhadas por tipo de token',
        description:
          'Mensal (default): um total por mês, em todo lugar — fechados vêm ' +
          'do snapshot (batem com cada extrato para sempre), abertos ao ' +
          'vivo. Diária (granularity=day, decisão 97): mesmos carimbos em ' +
          'baldes de dia UTC, hoje sempre parcial, quarentenados excluídos ' +
          '(os dias de um mês fechado somam a fatura congelada). Toda barra ' +
          'vem com geometria pré-computada e segmentos empilhados por tipo ' +
          'de token (stack_percent) nas cores das linhas do extrato.',
        parameters: [
          queryParam('granularity', "'month' (default) ou 'day'.", {
            type: 'string',
            enum: ['month', 'day'],
          }),
          queryParam('months', 'Meses mais recentes (1-24, default 12; só granularity=month).', {
            type: 'integer',
            minimum: 1,
            maximum: 24,
          }),
          queryParam('days', 'Dias mais recentes até hoje (1-90, default 30; só granularity=day).', {
            type: 'integer',
            minimum: 1,
            maximum: 90,
          }),
        ],
        responses: {
          '200': okResponse('Série de custo.', billingSeriesResponseSchema),
          '400': errorResponse(
            'Parâmetro granularity/months/days malformado, desconhecido ou ' +
              'da granularidade errada (days exige granularity=day; months ' +
              'exige granularity=month).',
          ),
          '401': unauthorizedResponse(),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/billing/projection': {
      get: {
        tags: ['Billing'],
        summary: 'Projeção do mês corrente — run-rate linear (US12/T8)',
        description:
          'Estimativa DERIVADA e rotulada: acumulado ÷ dias UTC completos × ' +
          'dias do mês. Nunca persiste, nunca entra em snapshot, some no ' +
          'fechamento. < 3 dias completos → insufficient_data.',
        responses: {
          '200': okResponse('Projeção.', billingProjectionResponseSchema),
          '400': errorResponse('Parâmetro de consulta desconhecido (o endpoint não aceita parâmetros).'),
          '401': unauthorizedResponse(),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/billing/statement': {
      get: {
        tags: ['Billing'],
        summary:
          'Exportação do extrato (US17) — representação via ?format=csv|html',
        description:
          'Um recurso, duas representações (decisão 98): format=csv ' +
          '(default) = linhas da US8 + cabeçalho com mês/status/timestamps, ' +
          'UTF-8 com BOM, abre no Excel; format=html = página standalone ' +
          'imprimível (Ctrl+P → PDF). Mês fechado exporta o snapshot ' +
          'verbatim; mês corrente carrega a marca PARCIAL (QA13).',
        parameters: [
          yearParam(),
          monthParam(),
          queryParam('format', "'csv' (default) ou 'html'. AUTORITATIVO: o header Accept é ignorado (audit D-5).", {
            type: 'string',
            enum: ['csv', 'html'],
          }),
        ],
        responses: {
          '200': {
            description:
              'A representação escolhida por ?format — text/csv (attachment, ' +
              'UTF-8 com BOM) ou text/html imprimível. O header Accept é ' +
              'ignorado; format decide (audit D-5).',
            content: {
              'text/csv': { schema: { type: 'string' } },
              'text/html': { schema: { type: 'string' } },
            },
          },
          '400': errorResponse('Ano/mês/format ausentes, malformados ou parâmetro desconhecido.'),
          '401': unauthorizedResponse(),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/prices': {
      get: {
        tags: ['Prices'],
        summary: 'Tabela de preços registrada (US4 — leitura, R$ apenas)',
        description:
          'A tabela versionada que o carimbo consulta (invariante 9), ' +
          'legível para conferir a fatura contra o contrato e diagnosticar ' +
          'pending_price ("quais (model, token_type, effective_from) ' +
          'existem?" — audit D-3). Filtros exatos opcionais; ordenada por ' +
          'model, token_type, effective_from desc.',
        parameters: [
          {
            name: 'model',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Filtro exato pela chave canônica provider/id.',
          },
          {
            name: 'token_type',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: [...TOKEN_TYPES] },
          },
        ],
        responses: {
          '200': {
            description: 'Versões registradas (imutáveis).',
            content: {
              'application/json': {
                schema: toSchema(listPriceVersionsResponseSchema),
              },
            },
          },
          '400': errorResponse('Parâmetro de consulta inválido.'),
          '401': unauthorizedResponse(),
          '500': errorResponse('Erro interno.'),
        },
      },
      post: {
        tags: ['Prices'],
        summary: 'Registra uma NOVA versão de preço (nunca um update)',
        description:
          'Versões são imutáveis (invariante 9): mudança de preço é um novo ' +
          'insert com novo effective_from — duplicata de (model, token_type, ' +
          'effective_from) responde 409. O modelo é canonicalizado para a ' +
          'MESMA chave `provider/id` que o carimbo consulta (decisão 82). ' +
          'Valor em STRING decimal (dinheiro nunca é float). Efeito ' +
          'imediato (decisão 57): traces pending_price desbloqueados pelo ' +
          'novo preço são carimbados na hora — o relatório vem na resposta. ' +
          'Preços já aplicados NUNCA mudam (invariante 1): a nova versão só ' +
          'vale para carimbos futuros.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: toRequestSchema(registerPriceVersionRequestSchema),
            },
          },
        },
        responses: {
          '201': okResponse(
            'Versão registrada + relatório do reprocess imediato.',
            registerPriceVersionResponseSchema,
          ),
          '400': errorResponse('Corpo inválido (campo ausente, malformado ou desconhecido).'),
          '401': unauthorizedResponse(),
          '409': errorResponse(
            'Versão já existe para (model, token_type, effective_from) — registre um novo effective_from.',
          ),
          '415': errorResponse(
            'Content-Type não é application/json — a API só aceita JSON (audit D-2).',
          ),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness — sem autenticação (convenção da plataforma)',
        description:
          'Prova que o processo responde — NÃO toca o banco, então uma ' +
          'queda do Mongo não aparece aqui (o readiness honesto é ' +
          'follow-up registrado). Aberta por desenho (decisão 172), como ' +
          'em todos os componentes da plataforma: orquestrador e Catalog ' +
          'Console sondam sem token, e o manifesto do módulo declara este ' +
          'caminho em connection.health.',
        // `security: []` sobrepõe o bearerAuth global: rota ABERTA — e por
        // isso sem 401 documentado (o docs-routes.test exige 401 só nas
        // operações gateadas).
        security: [],
        responses: {
          '200': okResponse('Processo vivo.', healthResponseSchema),
        },
      },
    },
  },
});
