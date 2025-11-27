import { describe, it, expect } from '@jest/globals';
import { createServer } from '../server.js';

describe('MCP Server', () => {
  it('should create server with correct metadata', () => {
    const server = createServer();
    expect(server.name).toBe('@altegio/mcp-server-pro');
    expect(server.version).toBe('1.0.0');
  });
});
