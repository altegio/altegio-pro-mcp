/**
 * The universal executor reaches every documented read under one tool name,
 * so its scope is resolved per operation from the catalog domain the
 * operation belongs to — never from a service-wide placeholder.
 */
import { describe, expect, it } from '@jest/globals';
import { allOperations, isLiveSource } from '../catalog.js';
import { executorScopeFor } from '../scopes.js';
import { KNOWN_SCOPES } from '../../scopes.js';

describe('executorScopeFor', () => {
  it('maps a catalog domain to the read scope of that domain', () => {
    expect(executorScopeFor({ domain: 'clients' })).toBe('clients:read');
    expect(executorScopeFor({ domain: 'appointments' })).toBe(
      'appointments:read'
    );
    expect(executorScopeFor({ domain: 'analytics' })).toBe('analytics:read');
    expect(executorScopeFor({ domain: 'membership_types' })).toBe(
      'chain_loyalty:read'
    );
    expect(executorScopeFor({ domain: 'visits' })).toBe('checkout:read');
  });

  it('knows no scope for a domain outside the table', () => {
    expect(executorScopeFor({ domain: 'planets' })).toBeUndefined();
  });

  it('covers every live read operation of the catalog with a known scope', () => {
    const uncovered = allOperations()
      .filter((op) => op.method === 'GET' && isLiveSource(op.source))
      .filter((op) => {
        const scope = executorScopeFor(op);
        return scope === undefined || !KNOWN_SCOPES.includes(scope);
      })
      .map((op) => `${op.domain}: ${op.operationId}`);
    expect(uncovered).toEqual([]);
  });
});
