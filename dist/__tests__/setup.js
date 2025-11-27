/**
 * Jest test setup
 * Sets up environment variables for all tests
 */
// Set required environment variables before any tests run
process.env.ALTEGIO_API_TOKEN = 'test-partner-token';
process.env.ALTEGIO_API_BASE = 'https://api.alteg.io/api/v1';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // Reduce log noise during tests
export {};
//# sourceMappingURL=setup.js.map