export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        module: 'ES2022',
        target: 'ES2023'
      },
      diagnostics: {
        // 151002: ts-jest's own ESM interop notice.
        // 2823: ts-jest forces module=CommonJS for the transform, so it flags
        // the `with { type: 'json' }` attribute that `module: NodeNext` (the
        // real build, checked by `npm run typecheck`) requires on JSON imports.
        ignoreCodes: [151002, 2823]
      }
    }],
  },
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
};
