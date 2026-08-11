/**
 * For a detailed explanation regarding each configuration property, visit:
 * https://jestjs.io/docs/configuration
 */

const config = {
  // All imported modules in your tests should be mocked automatically
  // automock: false,

  // Stop running tests after `n` failures
  // bail: 0,

  // The directory where Jest should store its cached dependency information
  // cacheDirectory: "/tmp/jest_rs",

  // Automatically clear mock calls, instances, contexts and results before every test
  clearMocks: true,

  // Indicates whether the coverage information should be collected while executing the test
  collectCoverage: true,

  // An array of glob patterns indicating a set of files for which coverage information should be collected
  collectCoverageFrom: [
    '<rootDir>/src/**/*.ts',
    // Test-support code is not production source: contract suites belong to
    // the ports' test surface, the shared billing fakes to the billing suites.
    '!<rootDir>/src/**/*.contract.ts',
    '!<rootDir>/src/**/billing-test-fakes.ts',
  ],

  // The directory where Jest should output its coverage files
  coverageDirectory: 'coverage',

  // An array of regexp pattern strings used to skip coverage collection
  // coveragePathIgnorePatterns: [
  //   "/node_modules/"
  // ],

  // Indicates which provider should be used to instrument code for coverage
  coverageProvider: 'v8',

  // A list of reporter names that Jest uses when writing coverage reports
  // (jest defaults + json-summary — scripts/coverage-summary.mjs turns the
  // totals into the CI run-summary table).
  coverageReporters: ['clover', 'json', 'lcov', 'text', 'json-summary'],

  // Ratchet, not aspiration (audit E-5): set just under the measured value
  // so a real coverage DROP fails test:ci while today's tree passes.
  // Raise it as coverage grows — never lower it to make a red run green.
  coverageThreshold: {
    global: {
      lines: 71,
      statements: 71,
      branches: 88,
    },
  },

  // A path to a custom dependency extractor
  // dependencyExtractor: undefined,

  // Make calling deprecated APIs throw helpful error messages
  // errorOnDeprecated: false,

  // The default configuration for fake timers
  // fakeTimers: {
  //   "enableGlobally": false
  // },

  // Force coverage collection from ignored files using an array of glob patterns
  // forceCoverageMatch: [],

  // A path to a module which exports an async function that is triggered once before all test suites
  // globalSetup: undefined,

  // A path to a module which exports an async function that is triggered once after all test suites
  // globalTeardown: undefined,

  // A set of global variables that need to be available in all test environments
  // globals: {},

  // The maximum amount of workers used to run your tests. Can be specified as % or a number. E.g. maxWorkers: 10% will use 10% of your CPU amount + 1 as the maximum worker number. maxWorkers: 2 will use a maximum of 2 workers.
  // maxWorkers: "50%",

  // An array of directory names to be searched recursively up from the requiring module's location
  // moduleDirectories: [
  //   "node_modules"
  // ],

  // An array of file extensions your modules use
  // moduleFileExtensions: [
  //   "js",
  //   "mjs",
  //   "cjs",
  //   "jsx",
  //   "ts",
  //   "mts",
  //   "cts",
  //   "tsx",
  //   "json",
  //   "node"
  // ],

  // A map from regular expressions to module names or to arrays of module names that allow to stub out resources with a single module
  moduleNameMapper: {
    '^(\\.\\.?\\/.+)\\.js$': '$1',
    // Workspace packages resolve via exports maps (node16) at build/runtime;
    // jest runs CommonJS with node10 resolution, so map them to source.
    '^@observability/core/(.*)\\.js$': '<rootDir>/../core/src/$1.ts',
  },

  // An array of regexp pattern strings, matched against all module paths before considered 'visible' to the module loader
  // modulePathIgnorePatterns: [],

  // Activates notifications for test results
  // notify: false,

  // An enum that specifies notification mode. Requires { notify: true }
  // notifyMode: "failure-change",

  // A preset that is used as a base for Jest's configuration
  preset: '@shelf/jest-mongodb',

  // Run tests from one or more projects
  // projects: undefined,

  // Use this configuration option to add custom reporters to Jest
  // On GitHub Actions, jest's built-in reporter turns each failure into an
  // inline PR annotation (silent: false keeps console output attached);
  // 'summary' keeps the end-of-run tally. Local runs keep the default.
  reporters: process.env.GITHUB_ACTIONS
    ? [['github-actions', { silent: false }], 'summary']
    : undefined,

  // Automatically reset mock state before every test
  // resetMocks: false,

  // Reset the module registry before running each individual test
  // resetModules: false,

  // A path to a custom resolver
  // resolver: undefined,

  // Automatically restore mock state and implementation before every test
  // restoreMocks: false,

  // The root directory that Jest should scan for tests and modules within
  // rootDir: undefined,

  // A list of paths to directories that Jest should use to search for files in
  roots: ['<rootDir>/src'],

  // Allows you to use a custom runner instead of Jest's default test runner
  // runner: "jest-runner",

  // The paths to modules that run some code to configure or set up the testing environment before each test
  // setupFiles: [],

  // A list of paths to modules that run some code to configure or set up the testing framework before each test
  // Decision 130: initialize the ambient client clock for every suite.
  setupFilesAfterEnv: ['<rootDir>/jest.client-clock-setup.ts'],

  // The number of seconds after which a test is considered as slow and reported as such in the results.
  // slowTestThreshold: 5,

  // A list of paths to snapshot serializer modules Jest should use for snapshot testing
  // snapshotSerializers: [],

  // The test environment that will be used for testing.
  // Deliberately overrides the @shelf/jest-mongodb preset's MongoEnvironment:
  // that environment re-reads <rootDir>/globalConfig.json before EVERY suite,
  // so any overlapping or aborted second jest run (its globalTeardown deletes
  // the file) makes every remaining suite "fail to run" — the observed
  // 46-of-50-suites collapse. Our suites never use its __MONGO_URI__ global;
  // they read process.env.MONGO_URL, which the preset's globalSetup sets in
  // the jest process itself (inherited by workers), so the plain node
  // environment loses nothing and makes concurrent runs safe.
  testEnvironment: 'jest-environment-node',

  // Options that will be passed to the testEnvironment
  // testEnvironmentOptions: {},

  // Adds a location field to test results
  // testLocationInResults: false,

  // The glob patterns Jest uses to detect test files
  // testMatch: [
  //   "**/__tests__/**/*.?([mc])[jt]s?(x)",
  //   "**/?(*.)+(spec|test).?([mc])[jt]s?(x)"
  // ],

  // An array of regexp pattern strings that are matched against all test paths, matched tests are skipped
  // testPathIgnorePatterns: [
  //   "/node_modules/"
  // ],

  // The regexp pattern or array of patterns that Jest uses to detect test files
  // testRegex: [],

  // This option allows the use of a custom results processor
  // testResultsProcessor: undefined,

  // This option allows use of a custom test runner
  // testRunner: "jest-circus/runner",

  // A map from regular expressions to paths to transformers
  // Jest runs in CommonJS mode, so ts-jest must emit CJS here even though
  // the package itself is ESM (tsconfig module=node16 for build/runtime).
  transform: {
    '.+\\.ts$': [
      'ts-jest',
      { tsconfig: { module: 'commonjs', moduleResolution: 'node' } },
    ],
  },

  // An array of regexp pattern strings that are matched against all source file paths, matched files will skip transformation
  // transformIgnorePatterns: [
  //   "/node_modules/",
  //   "\\.pnp\\.[^\\/]+$"
  // ],

  // An array of regexp pattern strings that are matched against all modules before the module loader will automatically return a mock for them
  // unmockedModulePathPatterns: undefined,

  // Indicates whether each individual test should be reported during the run
  // verbose: undefined,

  // An array of regexp patterns that are matched against all source file paths before re-running tests in watch mode
  // watchPathIgnorePatterns: [],

  // Whether to use watchman for file crawling
  // watchman: true,
};

export default config;
