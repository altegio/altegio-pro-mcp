export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ES2022',
          target: 'ES2023',
          // Transpile each file on its own. A type-checking transform builds a
          // whole TypeScript program in every worker (about 0.5 GB each);
          // `npm run typecheck` checks the sources and the tests once instead.
          isolatedModules: true,
        },
        diagnostics: {
          // 151002: ts-jest's own ESM interop notice.
          ignoreCodes: [151002],
        },
      },
    ],
  },
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  // Every test file gets a fresh module graph (the server, the tool registry,
  // the catalog: 40-60 MB). V8 frees the old ones only when the heap nears its
  // limit, so a long-lived worker grows towards that limit (gigabytes) unless
  // it is replaced. Two workers, each recycled once its heap passes 384 MB,
  // keep a full run near 1.5 GB on any machine.
  maxWorkers: 2,
  workerIdleMemoryLimit: '384MB',
};
