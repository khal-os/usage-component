import {
  MONGO_CLIENT_OPTIONS,
  buildMongoDbUri,
  setupMongoDbClient,
} from './mongodb-connection-setup.js';

// The driver's MongoOptions type omits the BSON `ignoreUndefined` key even
// though the parsed options carry it at runtime — narrow view for asserting.
const bsonOptions = (client: {
  options: unknown;
}): { ignoreUndefined?: boolean } =>
  client.options as { ignoreUndefined?: boolean };

describe('setupMongoDbClient()', () => {
  it('MUST pin durability and serialization explicitly at client construction (audit C-7.5)', () => {
    const { client } = setupMongoDbClient({
      mongoDbHost: 'mongo',
      mongoDbPort: 27017,
      mongoDbName: 'cleandb',
    });

    // Never driver defaults: majority-acknowledged retryable writes for
    // the permanent archive, and undefined→null serialization for the
    // "optional fields are stored as null" convention.
    expect(client.options.writeConcern?.w).toBe('majority');
    expect(client.options.retryWrites).toBe(true);
    expect(bsonOptions(client).ignoreUndefined).toBe(false);
  });

  it('MUST apply the same explicit options over the Atlas URI (params stay consistent)', () => {
    const { client } = setupMongoDbClient({
      mongoDbAtlas: true,
      mongoDbHost: 'cluster0.example.mongodb.net',
      mongoDbName: 'cleandb',
      mongoDbUser: 'platform',
      mongoDbPassword: 's3cret',
    });

    expect(client.options.writeConcern?.w).toBe('majority');
    expect(client.options.retryWrites).toBe(true);
    expect(bsonOptions(client).ignoreUndefined).toBe(false);
  });

  it('exports the exact option set entry points reuse (connectWithUri path)', () => {
    expect(MONGO_CLIENT_OPTIONS).toEqual({
      w: 'majority',
      retryWrites: true,
      ignoreUndefined: false,
    });
  });
});

describe('buildMongoDbUri()', () => {
  it('MUST build a plain local URI when no credentials are provided', () => {
    const { uri, message } = buildMongoDbUri({
      mongoDbHost: 'mongo',
      mongoDbPort: 27017,
      mongoDbName: 'cleandb',
    });

    expect(uri).toBe('mongodb://mongo:27017/cleandb');
    expect(message).toContain('"cleandb"');
  });

  it('MUST embed credentials with authSource=admin when user and password are provided', () => {
    const { uri } = buildMongoDbUri({
      mongoDbHost: 'mongo',
      mongoDbPort: 27017,
      mongoDbName: 'cleandb',
      mongoDbUser: 'platform',
      mongoDbPassword: 's3cret',
    });

    expect(uri).toBe(
      'mongodb://platform:s3cret@mongo:27017/cleandb?authSource=admin',
    );
  });

  it('MUST URL-encode reserved characters in credentials', () => {
    const { uri } = buildMongoDbUri({
      mongoDbHost: 'mongo',
      mongoDbPort: 27017,
      mongoDbName: 'cleandb',
      mongoDbUser: 'user@corp',
      mongoDbPassword: 'p@ss:word/1',
    });

    expect(uri).toBe(
      'mongodb://user%40corp:p%40ss%3Aword%2F1@mongo:27017/cleandb?authSource=admin',
    );
  });

  it('MUST ignore a user without a password (and vice versa) in local mode', () => {
    expect(
      buildMongoDbUri({
        mongoDbHost: 'mongo',
        mongoDbPort: 27017,
        mongoDbName: 'cleandb',
        mongoDbUser: 'platform',
      }).uri,
    ).toBe('mongodb://mongo:27017/cleandb');

    expect(
      buildMongoDbUri({
        mongoDbHost: 'mongo',
        mongoDbPort: 27017,
        mongoDbName: 'cleandb',
        mongoDbPassword: 's3cret',
      }).uri,
    ).toBe('mongodb://mongo:27017/cleandb');
  });

  it('MUST keep the Atlas URI shape when mongoDbAtlas is set', () => {
    const { uri, message } = buildMongoDbUri({
      mongoDbAtlas: true,
      mongoDbHost: 'cluster0.example.mongodb.net',
      mongoDbName: 'cleandb',
      mongoDbUser: 'platform',
      mongoDbPassword: 's3cret',
    });

    expect(uri).toBe(
      'mongodb+srv://platform:s3cret@cluster0.example.mongodb.net/cleandb?retryWrites=true&w=majority',
    );
    expect(message).toContain('Atlas');
  });

  it('MUST URL-encode reserved characters in Atlas credentials too', () => {
    const { uri } = buildMongoDbUri({
      mongoDbAtlas: true,
      mongoDbHost: 'cluster0.example.mongodb.net',
      mongoDbName: 'cleandb',
      mongoDbUser: 'user@corp',
      mongoDbPassword: 'p@ss:word/1',
    });

    expect(uri).toBe(
      'mongodb+srv://user%40corp:p%40ss%3Aword%2F1@cluster0.example.mongodb.net/cleandb?retryWrites=true&w=majority',
    );
  });

  describe('required-env guards (audit F-5)', () => {
    it('MUST refuse Atlas with empty credentials — never compose mongodb+srv://:@host', () => {
      expect(() =>
        buildMongoDbUri({
          mongoDbAtlas: true,
          mongoDbHost: 'cluster0.example.mongodb.net',
          mongoDbName: 'cleandb',
        }),
      ).toThrow(/MONGO_DB_ATLAS requires/);
    });

    it('MUST refuse a local URI missing host or database — never mongodb://undefined/undefined', () => {
      expect(() => buildMongoDbUri({ mongoDbName: 'cleandb' })).toThrow(
        /MONGO_DB_HOST and MONGO_USAGE_DB_NAME/,
      );
      expect(() => buildMongoDbUri({ mongoDbHost: 'mongo' })).toThrow(
        /MONGO_DB_HOST and MONGO_USAGE_DB_NAME/,
      );
    });
  });
});
