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
  McpEnvironmentVariables,
  MongoDbEnvironmentVariables,
  ServerEnvironmentVariables,
} from '../interfaces/index.js';

// ADR-103 (khal-platform) vocabulary: development | homolog | production —
// plus `test`, allowed only inside test runners.
const environmentEnum = {
  PRODUCTION: 'production',
  HOMOLOG: 'homolog',
  TEST: 'test',
  DEVELOPMENT: 'development',
} as const;

type Environment = (typeof environmentEnum)[keyof typeof environmentEnum];

export interface EnvironmentVariables
  extends
    ServerEnvironmentVariables,
    MongoDbEnvironmentVariables,
    BillingSchedulerEnvironmentVariables,
    McpEnvironmentVariables,
    LoggingEnvironmentVariables {
  Environment: Environment;
}

/**
 * Optional env string where EMPTY means unset. Compose forwards these vars
 * with `${VAR:-}` defaults, so an env file that omits them delivers '' to
 * the container — which must behave exactly like the var not existing
 * (e.g. an empty KHAL_AUTH_URL must not half-enable auth).
 */
const optionalNonEmptyString = z
  .string()
  .optional()
  .transform((value) => value || undefined);

/**
 * Comma-separated list env — the same split/trim/drop-empties reading the
 * CORS middleware applies to CORS_ALLOWED_ORIGINS, so `a, b` and `a,b`
 * mean the same list everywhere.
 */
const splitCommaList = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

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

/** The ONE MCP route; the canonical URL must name it (RFC 8707/9728). */
export const MCP_PATH = '/mcp';

/** 32 chars of randomness is the floor for an HMAC key that guards writes. */
const MCP_CONFIRMATION_KEY_MIN_LENGTH = 32;

/** The pathname of a canonical URL, or undefined when it is not a URL at all. */
const mcpPathOf = (value: string): string | undefined => {
  try {
    const url = new URL(value);

    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.pathname.replace(/\/+$/, '')
      : undefined;
  } catch {
    return undefined;
  }
};

const envSchema = z
  .object({
    ENVIRONMENT: z.enum([
      environmentEnum.PRODUCTION,
      environmentEnum.HOMOLOG,
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
    // Session auth (ADR-103 naming): the khal-auth base URL. SET → every
    // /api/v1 request must carry a Bearer session JWT verified against
    // ${KHAL_AUTH_URL}/.well-known/jwks.json (RS256, iss == KHAL_AUTH_URL,
    // aud == KHAL_TOKEN_AUDIENCE, tenant claim == KHAL_TENANT). UNSET →
    // API open, PoC posture (decision 133 style) — said loudly at boot.
    KHAL_AUTH_URL: optionalNonEmptyString,
    KHAL_TENANT: optionalNonEmptyString,
    // Accepted `aud` values of the session JWT, comma-separated — a token
    // matching ANY entry passes (the Tracing AND Billing apps read this
    // module's data). Defaults to `tracing,billing` in the transform below.
    KHAL_TOKEN_AUDIENCE: optionalNonEmptyString,
    // audit D-1: cross-origin is an explicit operator act — exact origins,
    // comma-separated; unset/empty = same-origin only (no CORS headers).
    CORS_ALLOWED_ORIGINS: optionalNonEmptyString,
    // T12 (decision 175): the MCP endpoint. SET → POST /mcp is mounted and
    // the refine below demands the rest of the contract; unset → no MCP
    // route exists at all (every current deployment keeps its behavior).
    MCP_CANONICAL_URL: optionalNonEmptyString,
    // Decision 177: signs the confirmation tokens previews hand out.
    MCP_CONFIRMATION_KEY: optionalNonEmptyString,
    // Decision 176: the one `aud` the endpoint accepts.
    MCP_AUDIENCE: optionalNonEmptyString,
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
    // Fail-fast (decision 139's convention, mirroring the old both-or-
    // neither Basic refine): auth was INTENDED — a missing tenant must
    // never half-enable it (the validator could not check the `tenant`
    // claim and would either fail everything or, worse, check nothing).
    if (env.KHAL_AUTH_URL && !env.KHAL_TENANT) {
      ctx.addIssue({
        code: 'custom',
        message:
          'KHAL_TENANT is required when KHAL_AUTH_URL is set — session ' +
          'validation checks the `tenant` claim against it',
      });
    }

    // A SET audience that parses to zero entries (only commas/blanks) is a
    // typo, not a choice — refuse the boot instead of silently falling back
    // to the default list (same fail-loud posture as the numeric knobs).
    if (
      env.KHAL_TOKEN_AUDIENCE &&
      splitCommaList(env.KHAL_TOKEN_AUDIENCE).length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'KHAL_TOKEN_AUDIENCE must name at least one audience ' +
          '(comma-separated list, e.g. "tracing,billing")',
      });
    }

    // T12: the MCP endpoint is all-or-nothing. The knob that turns it on
    // drags its whole contract with it, and every missing piece is a BOOT
    // failure — an MCP door that answers without checking who is calling,
    // or one that mints confirmation tokens under a guessable key, must not
    // be reachable at all. MCP_CONFIRMATION_KEY without the URL is NOT an
    // error: the key is provisioned per environment (secret store) while
    // the endpoint stays off until the URL is declared.
    if (!env.MCP_CANONICAL_URL) return;

    if (!env.KHAL_AUTH_URL || !env.KHAL_TENANT) {
      ctx.addIssue({
        code: 'custom',
        message:
          'MCP_CANONICAL_URL requires KHAL_AUTH_URL and KHAL_TENANT — the ' +
          'MCP endpoint is never open (decision 175)',
      });
    }

    if (!env.MCP_AUDIENCE) {
      ctx.addIssue({
        code: 'custom',
        message:
          'MCP_AUDIENCE is required when MCP_CANONICAL_URL is set — the ' +
          'audience tokens must carry is declared, never inferred ' +
          '(decision 176)',
      });
    }

    if (!env.MCP_CONFIRMATION_KEY) {
      ctx.addIssue({
        code: 'custom',
        message:
          'MCP_CONFIRMATION_KEY is required when MCP_CANONICAL_URL is set — ' +
          'it signs the confirmation tokens of every write (decision 177)',
      });
    } else if (
      env.MCP_CONFIRMATION_KEY.length < MCP_CONFIRMATION_KEY_MIN_LENGTH
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'MCP_CONFIRMATION_KEY must be at least ' +
          `${MCP_CONFIRMATION_KEY_MIN_LENGTH} characters ` +
          '(e.g. `openssl rand -hex 32`)',
      });
    }

    const canonicalPath = mcpPathOf(env.MCP_CANONICAL_URL);

    if (canonicalPath !== MCP_PATH) {
      ctx.addIssue({
        code: 'custom',
        message:
          `MCP_CANONICAL_URL must be an absolute http(s) URL whose path is exactly ${MCP_PATH} ` +
          '(it IS the resource identifier clients post to — RFC 8707/9728)',
      });
    }
  })
  .transform((env) => ({
    ...env,
    KHAL_TOKEN_AUDIENCE: env.KHAL_TOKEN_AUDIENCE
      ? splitCommaList(env.KHAL_TOKEN_AUDIENCE)
      : ['tracing', 'billing'],
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
  khalAuthUrl: safeEnvironment.KHAL_AUTH_URL,
  khalTenant: safeEnvironment.KHAL_TENANT,
  khalTokenAudiences: safeEnvironment.KHAL_TOKEN_AUDIENCE,
  corsAllowedOrigins: safeEnvironment.CORS_ALLOWED_ORIGINS,
  mcpCanonicalUrl: safeEnvironment.MCP_CANONICAL_URL,
  mcpConfirmationKey: safeEnvironment.MCP_CONFIRMATION_KEY,
  mcpAudience: safeEnvironment.MCP_AUDIENCE,
  billingAutoCloseDelayMinutes:
    safeEnvironment.BILLING_AUTO_CLOSE_DELAY_MINUTES,
  billingAutoCloseCheckIntervalSeconds:
    safeEnvironment.BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS,
  ...toMongoDbEnvironment(safeEnvironment),
  ...toLoggingEnvironment(safeEnvironment, environmentContext),
};
