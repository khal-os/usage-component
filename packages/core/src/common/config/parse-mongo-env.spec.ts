import {
  mongoEnvSchemaShape,
  toMongoDbEnvironment,
} from './parse-mongo-env.js';
import { z } from 'zod';

/**
 * audit C-6: core owns the Mongo env TYPE, so it owns the READER — both
 * images now spread this one parser. This suite is that reader's one home.
 */
describe('shared Mongo env parser (audit C-6)', () => {
  const schema = z.object(mongoEnvSchemaShape);

  it('MUST accept and transform a full Atlas configuration', () => {
    const parsed = schema.parse({
      MONGO_DB_ATLAS: 'true',
      MONGO_DB_HOST: 'cluster0.example.mongodb.net',
      MONGO_USAGE_DB_NAME: 'observability',
      MONGO_DB_USER: 'platform',
      MONGO_DB_PASSWORD: 's3cret',
      MONGO_DB_PORT: '27017',
    });

    expect(toMongoDbEnvironment(parsed)).toEqual({
      mongoDbAtlas: true,
      mongoDbHost: 'cluster0.example.mongodb.net',
      mongoDbName: 'observability',
      mongoDbUser: 'platform',
      mongoDbPassword: 's3cret',
      mongoDbPort: 27017,
    });
  });

  it('MUST leave optional fields undefined and map the boolean/int strings', () => {
    const base = { MONGO_USAGE_DB_NAME: 'observability' };

    expect(toMongoDbEnvironment(schema.parse(base))).toEqual({
      mongoDbAtlas: undefined,
      mongoDbHost: undefined,
      mongoDbName: 'observability',
      mongoDbUser: undefined,
      mongoDbPassword: undefined,
      mongoDbPort: undefined,
    });
    expect(
      toMongoDbEnvironment(schema.parse({ ...base, MONGO_DB_ATLAS: 'false' }))
        .mongoDbAtlas,
    ).toBe(false);
  });

  it('MUST refuse a missing or empty MONGO_USAGE_DB_NAME (decision 139 — declared, never inferred)', () => {
    // Absent — the old contract silently defaulted to CLIENT_NAME here.
    expect(schema.safeParse({}).success).toBe(false);
    // Compose forwards '' for unset vars — empty must fail exactly like absent.
    expect(schema.safeParse({ MONGO_USAGE_DB_NAME: '' }).success).toBe(false);
  });

  it('MUST refuse a non-integer port and an invalid atlas flag', () => {
    const base = { MONGO_USAGE_DB_NAME: 'observability' };

    expect(schema.safeParse({ ...base, MONGO_DB_PORT: 'abc' }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...base, MONGO_DB_ATLAS: 'yes' }).success).toBe(
      false,
    );
  });
});
