import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';
import { initializeClientClock } from '@observability/core/common/helpers/clock/client-clock.js';
import {
  mongoEnvSchemaShape,
  toMongoDbEnvironment,
} from '@observability/core/common/config/parse-mongo-env.js';
import {
  LoggingEnvironmentVariables,
  bootstrapLoggerOptions,
  logEnvSchemaShape,
  toLoggingEnvironment,
} from '@observability/core/common/config/parse-log-env.js';
import { createLogger } from '@observability/core/common/logging/structured-logger.js';
import { MongoDbEnvironmentVariables } from '@observability/core/infrastructure/configuration/interfaces/mongodb-environment-variables.js';
import { TraceIngestionWorkerEnvironmentVariables } from '../interfaces/index.js';

const environmentEnum = {
  PRODUCTION: 'production',
  TEST: 'test',
  DEVELOPMENT: 'development',
} as const;

type Environment = (typeof environmentEnum)[keyof typeof environmentEnum];

/**
 * The connector is a WORKER, not a server: no SERVER_PORT, no auth vars —
 * the old single-package schema forced the ingestion worker to declare a
 * port it never listened on (compose had to fake one).
 */
export interface EnvironmentVariables
  extends
    MongoDbEnvironmentVariables,
    TraceIngestionWorkerEnvironmentVariables,
    LoggingEnvironmentVariables {
  Environment: Environment;
  /** Deployment display name (single-tenant instance) — optional, logs only. */
  clientName?: string;
  /** REQUIRED (decision 130): the client's business timezone, IANA name. */
  clientTimezone: string;
}

/**
 * Optional POSITIVE integer env string with an explicit ceiling (audit
 * F-4). The bare digit regex accepted 0 — and TRACE_INGESTION_BATCH_SIZE=0
 * booted cleanly, drove the source query with LIMIT 0 and logged a healthy
 * "0 fetched" forever while the source's ~49-day retention ate the backlog:
 * invariant 6 failing in the silent shape. INTERVAL=0 busy-looped. The
 * resolved knobs are echoed at worker startup so a misconfiguration is in
 * the first lines of the log.
 */
const optionalBoundedIntString = (name: string, max: number) =>
  z
    .string()
    .regex(/^\d+$/, `${name} must be a decimal integer string`)
    .optional()
    .superRefine((value, ctx) => {
      if (value === undefined) return;

      const parsed = Number(value);

      if (parsed < 1 || parsed > max) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} must be between 1 and ${max} — 0 would silently ingest nothing (audit F-4)`,
        });
      }
    });

const envSchema = z
  .object({
    ENVIRONMENT: z.enum([
      environmentEnum.PRODUCTION,
      environmentEnum.TEST,
      environmentEnum.DEVELOPMENT,
    ] as const),
    CLIENT_NAME: z.string().optional(),
    // Decision 130: REQUIRED — the worker cuts quarantine/reprocess month
    // keys at the same client midnight the bill uses.
    CLIENT_TIMEZONE: z
      .string()
      .min(1, 'CLIENT_TIMEZONE is required (decision 130)'),
    // audit C-6: the Mongo env is core's — one reader for both images.
    ...mongoEnvSchemaShape,
    // Same rule for the logging knobs: one reader, both images.
    ...logEnvSchemaShape,
    // Decision 127: ClickHouse is the ONLY real source — the HTTP client
    // (LANGWATCH_ENDPOINT/LANGWATCH_API_KEY) no longer exists here. The
    // API key still lives in the CLIENT env file as the agents'/vault
    // hand-off, but no container of this component reads it.
    // Compose forwards '' when the env file omits the var — same
    // ''-means-unset rule as the module's optionalNonEmptyString.
    TRACE_SOURCE: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(['fixtures']).optional(),
    ),
    LANGWATCH_CLICKHOUSE_URL: z.string().optional(),
    LANGWATCH_CLICKHOUSE_USER: z.string().optional(),
    LANGWATCH_CLICKHOUSE_PASSWORD: z.string().optional(),
    LANGWATCH_CLICKHOUSE_DATABASE: z.string().optional(),
    // Whitespace-only means UNSET (decision 142 wiring): ECS injects this
    // from an SSM parameter whose pre-onboarding placeholder is " " — SSM
    // forbids empty strings. A blank project id must gate the source OFF
    // (crash path), never filter by ' ' (silent zero-ingest) and never
    // drop the filter (cross-project ingest) — audit G-1.
    LANGWATCH_PROJECT_ID: z
      .string()
      .optional()
      .transform((value) => value?.trim() || undefined),
    TRACE_INGESTION_INTERVAL_SECONDS: optionalBoundedIntString(
      'TRACE_INGESTION_INTERVAL_SECONDS',
      86_400,
    ),
    TRACE_INGESTION_BATCH_SIZE: optionalBoundedIntString(
      'TRACE_INGESTION_BATCH_SIZE',
      10_000,
    ),
    TRACE_INGESTION_QUIET_PERIOD_SECONDS: optionalBoundedIntString(
      'TRACE_INGESTION_QUIET_PERIOD_SECONDS',
      86_400,
    ),
    REPROCESS_INTERVAL_SECONDS: optionalBoundedIntString(
      'REPROCESS_INTERVAL_SECONDS',
      604_800,
    ),
  })
  .transform((env) => ({
    ...env,
    TRACE_INGESTION_INTERVAL_SECONDS: env.TRACE_INGESTION_INTERVAL_SECONDS
      ? parseInt(env.TRACE_INGESTION_INTERVAL_SECONDS, 10)
      : undefined,
    TRACE_INGESTION_BATCH_SIZE: env.TRACE_INGESTION_BATCH_SIZE
      ? parseInt(env.TRACE_INGESTION_BATCH_SIZE, 10)
      : undefined,
    TRACE_INGESTION_QUIET_PERIOD_SECONDS:
      env.TRACE_INGESTION_QUIET_PERIOD_SECONDS
        ? parseInt(env.TRACE_INGESTION_QUIET_PERIOD_SECONDS, 10)
        : undefined,
    REPROCESS_INTERVAL_SECONDS: env.REPROCESS_INTERVAL_SECONDS
      ? parseInt(env.REPROCESS_INTERVAL_SECONDS, 10)
      : undefined,
  }));

const narrowedEnv = Object.values(environmentEnum).includes(
  process.env.ENVIRONMENT as Environment,
)
  ? (process.env.ENVIRONMENT as Environment)
  : environmentEnum.DEVELOPMENT;

dotenv.config({
  path: path.resolve(process.cwd(), `.env.${narrowedEnv}`),
});

const unsafeEnv = process.env as Record<string, string>;

const environmentContext = {
  isDevelopment: narrowedEnv === environmentEnum.DEVELOPMENT,
  isTest: narrowedEnv === environmentEnum.TEST,
};

const parsedEnv = envSchema.safeParse(unsafeEnv);

if (!parsedEnv.success) {
  // Strict parse failed → no root logger yet; the tolerant bootstrap reader
  // gives this fatal line the same shape as every other log line.
  const bootstrapLogging = bootstrapLoggerOptions(
    unsafeEnv,
    environmentContext,
  );

  createLogger({
    level: bootstrapLogging.logLevel,
    format: bootstrapLogging.logFormat,
    bindings: { service: 'connector' },
  }).fatal('Invalid environment variables — refusing to boot', {
    issues: parsedEnv.error.issues,
  });
  process.exit(1);
}

const safeEnvironment = parsedEnv.data;

// Decision 130 — see the module's twin comment.
initializeClientClock(safeEnvironment.CLIENT_TIMEZONE);

export const environment: EnvironmentVariables = {
  Environment: safeEnvironment.ENVIRONMENT,
  clientName: safeEnvironment.CLIENT_NAME || undefined,
  clientTimezone: safeEnvironment.CLIENT_TIMEZONE,
  ...toMongoDbEnvironment(safeEnvironment),
  traceSource: safeEnvironment.TRACE_SOURCE,
  langwatchClickhouseUrl: safeEnvironment.LANGWATCH_CLICKHOUSE_URL,
  langwatchClickhouseUser: safeEnvironment.LANGWATCH_CLICKHOUSE_USER,
  langwatchClickhousePassword: safeEnvironment.LANGWATCH_CLICKHOUSE_PASSWORD,
  langwatchClickhouseDatabase: safeEnvironment.LANGWATCH_CLICKHOUSE_DATABASE,
  langwatchProjectId: safeEnvironment.LANGWATCH_PROJECT_ID,
  traceIngestionIntervalSeconds:
    safeEnvironment.TRACE_INGESTION_INTERVAL_SECONDS,
  traceIngestionBatchSize: safeEnvironment.TRACE_INGESTION_BATCH_SIZE,
  traceIngestionQuietPeriodSeconds:
    safeEnvironment.TRACE_INGESTION_QUIET_PERIOD_SECONDS,
  reprocessIntervalSeconds: safeEnvironment.REPROCESS_INTERVAL_SECONDS,
  ...toLoggingEnvironment(safeEnvironment, environmentContext),
};
