import { describe, it, expect } from '@jest/globals';
import { main } from '../index.js';

describe('Main Entry', () => {
  it('should export main function', () => {
    expect(typeof main).toBe('function');
  });
});
