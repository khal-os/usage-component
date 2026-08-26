import { z } from 'zod';

/**
 * THE shared MongoDB env parser (audit C-6): core owns the
 * MongoDbEnvironmentVariables TYPE, so it must own the READER too — the
 * split COPIED this fragment verbatim into both the module and the
 * connector, so adding a field (MONGO_DB_AUTH_SOURCE, MONGO_DB_TLS) to the
 * core interface would compile clean while only ONE image actually read
 * it: the API connects with the new setting, the worker silently does not.
 * Both packages now spread these into their own schema.
 */
export const mongoEnvSchemaShape = {
  // '' means UNSET (compose forwards `${MONGO_DB_PORT:-…}`), same rule as
  // every optional knob — see parse-log-env. Without the preprocess the
  // validated optionals rejected the compose-forwarded empty string and
  // crash-looped a fresh client deploy that never set the knob.
  MONGO_DB_PORT: z.preprocess(
    (value) => value || undefined,
    z
      .string()
      .regex(/^\d+$/, 'MONGO_DB_PORT must be a valid integer string')
      .optional(),
  ),
  // env vars are always strings — a boolean here would reject every set
  // value and crash the boot; the transform below maps to boolean.
  MONGO_DB_ATLAS: z.preprocess(
    (value) => value || undefined,
    z.enum(['true', 'false']).optional(),
  ),
  MONGO_DB_HOST: z.string().optional(),
  // Decision 139: REQUIRED, declared never inferred — the old MONGO_DB_NAME
  // silently defaulted to CLIENT_NAME in compose; in a cluster-per-client
  // world an inferred database name misroutes the archive. min(1) also
  // rejects the compose-forwarded '' (empty means unset, and unset is an
  // error here). The internal field stays `mongoDbName` — this parser is
  // the single env→field mapping point.
  MONGO_USAGE_DB_NAME: z
    .string()
    .min(1, 'MONGO_USAGE_DB_NAME is required (decision 139)'),
  MONGO_DB_PASSWORD: z.string().optional(),
  MONGO_DB_USER: z.string().optional(),
} as const;

/** Transforms the raw string env into the typed MongoDbEnvironmentVariables shape. */
export const toMongoDbEnvironment = (env: {
  MONGO_DB_PORT?: string;
  MONGO_DB_ATLAS?: 'true' | 'false';
  MONGO_DB_HOST?: string;
  MONGO_USAGE_DB_NAME: string;
  MONGO_DB_PASSWORD?: string;
  MONGO_DB_USER?: string;
}) => ({
  mongoDbPort: env.MONGO_DB_PORT ? parseInt(env.MONGO_DB_PORT, 10) : undefined,
  mongoDbAtlas: env.MONGO_DB_ATLAS ? env.MONGO_DB_ATLAS === 'true' : undefined,
  mongoDbHost: env.MONGO_DB_HOST,
  mongoDbName: env.MONGO_USAGE_DB_NAME,
  mongoDbPassword: env.MONGO_DB_PASSWORD,
  mongoDbUser: env.MONGO_DB_USER,
});
