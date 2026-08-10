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
import {
  BillingSchedulerEnvironmentVariables,
  MongoDbEnvironmentVariables,
  ServerEnvironmentVariables,
} from '../interfaces/index.js';

const environmentEnum = {
  PRODUCTION: 'production',
  TEST: 'test',
  DEVELOPMENT: 'development',
} as const;

type Environment = (typeof environmentEnum)[keyof typeof environmentEnum];

export interface EnvironmentVariables
  extends
    ServerEnvironmentVariables,
    MongoDbEnvironmentVariables,
    BillingSchedulerEnvironmentVariables,
    LoggingEnvironmentVariables {
  Environment: Environment;
}

/**
 * Optional env string where EMPTY means unset. Compose forwards these vars
 * with `${VAR:-}` defaults, so an env file that omits them delivers '' to
 * the container — which must behave exactly like the var not existing
 * (e.g. an empty KHAL_DISCOVERY_URL must not half-enable auth).
 */
const optionalNonEmptyString = z
  .string()
  .optional()
  .transform((value) => value || undefined);

/**
 * Bounded numeric knob (the connector's audit F-4 guard, same rationale):
 * a knob typo'd to 0 or garbage must fail the boot loudly, not configure a
 * busy-loop or a midnight-sharp close nobody chose. The resolved values
 * are echoed at scheduler startup so a misconfiguration is in the first
 * lines of the log.
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
          message: `${name} must be between 1 and ${max} (audit F-4)`,
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
    SERVER_PORT: z
      .string()
      .regex(/^\d+$/, 'SERVER_PORT must be a valid integer string'),
    CLIENT_NAME: z.string().optional(),
    // Decision 130: REQUIRED — the client's business timezone (IANA name).
    // Declared, never inferred (a fallback zone is a wrong bill); validity
    // is asserted by initializeClientClock below.
    CLIENT_TIMEZONE: z
      .string()
      .min(1, 'CLIENT_TIMEZONE is required (decision 130)'),
    // Canonical khal consumer surface (ADR-97; the ONLY spelling — the
    // pre-discovery AUTH_SYSTEM_* names were removed pre-prod, decision
    // 133): discovery + tenant resolve the Auth System URL at runtime; the
    // credential authenticates /introspect.
    KHAL_DISCOVERY_URL: optionalNonEmptyString,
    KHAL_TENANT: optionalNonEmptyString,
    KHAL_CLIENT_ID: optionalNonEmptyString,
    KHAL_CLIENT_SECRET: optionalNonEmptyString,
    // Decision 141: INTERIM edge gate until the KHAL quartet has real
    // infra. Constraints enforced in the superRefine below the object:
    // both-or-neither, and never alongside the quartet.
    BASIC_AUTH_USER: optionalNonEmptyString,
    BASIC_AUTH_PASSWORD: optionalNonEmptyString,
    // audit D-1: cross-origin is an explicit operator act — exact origins,
    // comma-separated; unset/empty = same-origin only (no CORS headers).
    CORS_ALLOWED_ORIGINS: optionalNonEmptyString,
    // Decision 131: knobs of the opt-in billing-close scheduler. Bounds:
    // delay up to 7 days, interval up to 24h — beyond either the operator
    // wants a different mechanism, not a bigger number.
    BILLING_AUTO_CLOSE_DELAY_MINUTES: optionalBoundedIntString(
      'BILLING_AUTO_CLOSE_DELAY_MINUTES',
      10_080,
    ),
    BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS: optionalBoundedIntString(
      'BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS',
      86_400,
    ),
    // audit C-6: the Mongo env is core's — one reader for both images.
    ...mongoEnvSchemaShape,
    // Same rule for the logging knobs: one reader, both images.
    ...logEnvSchemaShape,
  })
  .superRefine((env, ctx) => {
    // Decision 141, fail-fast (decision 139's convention): half a
    // credential pair must never half-enable auth, and running BOTH gates
    // hides "which one 401'd me" — switching to platform auth means
    // DELETING the BASIC_AUTH_* knobs, said out loud at boot.
    const basicCount = [env.BASIC_AUTH_USER, env.BASIC_AUTH_PASSWORD].filter(
      Boolean,
    ).length;

    if (basicCount === 1) {
      ctx.addIssue({
        code: 'custom',
        message:
          'BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must be set TOGETHER ' +
          '(decision 141) — half a pair would half-enable auth',
      });
    }

    if (basicCount > 0 && env.KHAL_DISCOVERY_URL) {
      ctx.addIssue({
        code: 'custom',
        message:
          'BASIC_AUTH_* and KHAL_DISCOVERY_URL are mutually exclusive ' +
          '(decision 141) — the quartet replaces the interim gate: delete ' +
          'the BASIC_AUTH_* knobs when switching',
      });
    }
  })
  .transform((env) => ({
    ...env,
    SERVER_PORT: parseInt(env.SERVER_PORT, 10),
    BILLING_AUTO_CLOSE_DELAY_MINUTES: env.BILLING_AUTO_CLOSE_DELAY_MINUTES
      ? parseInt(env.BILLING_AUTO_CLOSE_DELAY_MINUTES, 10)
      : undefined,
    BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS:
      env.BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS
        ? parseInt(env.BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS, 10)
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
  // The strict parse failed, so the root logger cannot exist yet — the
  // tolerant bootstrap reader gives this one fatal line the same shape as
  // every other log line (a shipper must not need a special case for the
  // most important message the process ever writes).
  const bootstrapLogging = bootstrapLoggerOptions(
    unsafeEnv,
    environmentContext,
  );

  createLogger({
    level: bootstrapLogging.logLevel,
    format: bootstrapLogging.logFormat,
    bindings: { service: 'module' },
  }).fatal('Invalid environment variables — refusing to boot', {
    issues: parsedEnv.error.issues,
  });
  process.exit(1);
}

const safeEnvironment = parsedEnv.data;

// Decision 130: one clock for billing boundary AND display, initialized
// at boot — every entry point imports this module before any date math.
initializeClientClock(safeEnvironment.CLIENT_TIMEZONE);

export const environment: EnvironmentVariables = {
  Environment: safeEnvironment.ENVIRONMENT,
  serverPort: safeEnvironment.SERVER_PORT,
  clientName: safeEnvironment.CLIENT_NAME || undefined,
  clientTimezone: safeEnvironment.CLIENT_TIMEZONE,
  // '' → undefined already guaranteed by optionalNonEmptyString above.
  khalDiscoveryUrl: safeEnvironment.KHAL_DISCOVERY_URL,
  khalTenant: safeEnvironment.KHAL_TENANT,
  corsAllowedOrigins: safeEnvironment.CORS_ALLOWED_ORIGINS,
  khalClientId: safeEnvironment.KHAL_CLIENT_ID,
  khalClientSecret: safeEnvironment.KHAL_CLIENT_SECRET,
  basicAuthUser: safeEnvironment.BASIC_AUTH_USER,
  basicAuthPassword: safeEnvironment.BASIC_AUTH_PASSWORD,
  billingAutoCloseDelayMinutes:
    safeEnvironment.BILLING_AUTO_CLOSE_DELAY_MINUTES,
  billingAutoCloseCheckIntervalSeconds:
    safeEnvironment.BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS,
  ...toMongoDbEnvironment(safeEnvironment),
  ...toLoggingEnvironment(safeEnvironment, environmentContext),
};
