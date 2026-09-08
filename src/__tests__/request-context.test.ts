import { describe, it, expect } from '@jest/globals';
import {
  parseIdentityHeaders,
  parseUserToken,
  parseCompanyId,
  runWithIdentity,
  runWithContext,
  getRequestIdentity,
  getRequestUserToken,
  getRequestCompanyId,
  assertCompanyAllowed,
  identityKey,
  type RequestIdentity,
} from '../request-context.js';

describe('request-context', () => {
  describe('parseIdentityHeaders', () => {
    it('parses a user identity', () => {
      const identity = parseIdentityHeaders({
        'x-mcp-auth-kind': 'user',
        'x-mcp-auth-email': 'giorgio.a@alteg.io',
        'x-mcp-auth-sub': 'auth0|123',
        'x-mcp-auth-client-id': 'client-abc',
        'x-mcp-auth-scope': 'mcp:pro:read mcp:pro:write',
      });

      expect(identity).toEqual({
        kind: 'user',
        email: 'giorgio.a@alteg.io',
        sub: 'auth0|123',
        clientId: 'client-abc',
        scope: 'mcp:pro:read mcp:pro:write',
      });
    });

    it('parses a user identity with only email', () => {
      const identity = parseIdentityHeaders({
        'x-mcp-auth-kind': 'user',
        'x-mcp-auth-email': 'user@example.com',
      });

      expect(identity).toMatchObject({
        kind: 'user',
        email: 'user@example.com',
      });
    });

    it('parses a user identity with only sub', () => {
      const identity = parseIdentityHeaders({
        'x-mcp-auth-kind': 'user',
        'x-mcp-auth-sub': 'auth0|999',
      });

      expect(identity).toMatchObject({ kind: 'user', sub: 'auth0|999' });
    });

    it('parses a machine identity', () => {
      const identity = parseIdentityHeaders({
        'x-mcp-auth-kind': 'machine',
        'x-mcp-auth-machine-name': 'smoke-probe',
        'x-mcp-auth-scope': 'mcp:pro:read',
      });

      expect(identity).toEqual({
        kind: 'machine',
        machineName: 'smoke-probe',
        scope: 'mcp:pro:read',
      });
    });

    it('returns null when the kind header is absent', () => {
      expect(parseIdentityHeaders({})).toBeNull();
      expect(
        parseIdentityHeaders({
          authorization: 'Bearer x',
          'content-type': 'application/json',
        })
      ).toBeNull();
    });

    it('returns null for a malformed user identity (no email or sub)', () => {
      expect(
        parseIdentityHeaders({
          'x-mcp-auth-kind': 'user',
          'x-mcp-auth-scope': 'mcp:pro:read',
        })
      ).toBeNull();
    });

    it('returns null for an unknown kind', () => {
      expect(parseIdentityHeaders({ 'x-mcp-auth-kind': 'robot' })).toBeNull();
    });

    it('is case-insensitive and tolerates array header values', () => {
      const identity = parseIdentityHeaders({
        'X-MCP-Auth-Kind': 'user',
        'X-Mcp-Auth-Email': ['first@example.com', 'second@example.com'],
      });

      expect(identity).toMatchObject({
        kind: 'user',
        email: 'first@example.com',
      });
    });
  });

  describe('runWithIdentity / getRequestIdentity', () => {
    it('returns undefined outside any request context (stdio)', () => {
      expect(getRequestIdentity()).toBeUndefined();
    });

    it('exposes the bound identity inside the context', () => {
      const identity: RequestIdentity = { kind: 'user', email: 'x@y.com' };
      const seen = runWithIdentity(identity, () => getRequestIdentity());
      expect(seen).toBe(identity);
    });

    it('binds null for an anonymous HTTP context', () => {
      const seen = runWithIdentity(null, () => getRequestIdentity());
      expect(seen).toBeNull();
    });

    it('isolates identity across two concurrent async chains', async () => {
      const seen: Record<string, string | undefined> = {};

      const chain = (
        label: string,
        email: string,
        delay: number
      ): Promise<void> =>
        runWithIdentity({ kind: 'user', email }, async () => {
          // Yield so the two chains interleave; each must keep its own identity.
          await new Promise((resolve) => setTimeout(resolve, delay));
          seen[label] = getRequestIdentity()?.email;
        });

      await Promise.all([chain('a', 'a@x.com', 20), chain('b', 'b@x.com', 5)]);

      expect(seen.a).toBe('a@x.com');
      expect(seen.b).toBe('b@x.com');
    });
  });

  describe('identityKey', () => {
    it('is stable and 16 hex chars', () => {
      const key1 = identityKey({ kind: 'user', email: 'x@y.com' });
      const key2 = identityKey({ kind: 'user', email: 'x@y.com' });
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^[0-9a-f]{16}$/);
    });

    it('prefers sub over email', () => {
      const bySub = identityKey({ kind: 'user', sub: 'sub-1' });
      const bySubIgnoringEmail = identityKey({
        kind: 'user',
        sub: 'sub-1',
        email: 'x@y.com',
      });
      expect(bySub).toBe(bySubIgnoringEmail);
    });

    it('produces different keys for different identities', () => {
      const a = identityKey({ kind: 'user', email: 'a@x.com' });
      const b = identityKey({ kind: 'user', email: 'b@x.com' });
      const machine = identityKey({
        kind: 'machine',
        machineName: 'smoke-probe',
      });
      expect(new Set([a, b, machine]).size).toBe(3);
    });
  });

  describe('parseUserToken', () => {
    it('reads the X-Altegio-User-Token header', () => {
      expect(
        parseUserToken({ 'x-altegio-user-token': 'client-token-123' })
      ).toBe('client-token-123');
    });

    it('is case-insensitive and trims whitespace', () => {
      expect(parseUserToken({ 'X-Altegio-User-Token': '  tok  ' })).toBe('tok');
    });

    it('tolerates array header values', () => {
      expect(
        parseUserToken({ 'x-altegio-user-token': ['first', 'second'] })
      ).toBe('first');
    });

    it('returns undefined when absent or blank', () => {
      expect(parseUserToken({})).toBeUndefined();
      expect(parseUserToken({ 'x-altegio-user-token': '   ' })).toBeUndefined();
    });
  });

  describe('runWithContext / getRequestUserToken', () => {
    it('returns undefined outside any request context (stdio)', () => {
      expect(getRequestUserToken()).toBeUndefined();
    });

    it('exposes both the identity and the direct token', () => {
      const identity: RequestIdentity = { kind: 'user', email: 'x@y.com' };
      const seen = runWithContext({ identity, userToken: 'tok' }, () => ({
        id: getRequestIdentity(),
        token: getRequestUserToken(),
      }));
      expect(seen.id).toBe(identity);
      expect(seen.token).toBe('tok');
    });

    it('carries a direct token even with an anonymous identity', () => {
      const seen = runWithContext({ identity: null, userToken: 'tok' }, () => ({
        id: getRequestIdentity(),
        token: getRequestUserToken(),
      }));
      expect(seen.id).toBeNull();
      expect(seen.token).toBe('tok');
    });

    it('runWithIdentity binds no direct token', () => {
      const token = runWithIdentity({ kind: 'user', email: 'x@y.com' }, () =>
        getRequestUserToken()
      );
      expect(token).toBeUndefined();
    });
  });

  describe('parseCompanyId', () => {
    it('reads a positive integer X-Altegio-Company-Id header', () => {
      expect(parseCompanyId({ 'x-altegio-company-id': '4564' })).toBe(4564);
    });

    it('is case-insensitive and trims whitespace', () => {
      expect(parseCompanyId({ 'X-Altegio-Company-Id': '  720441 ' })).toBe(
        720441
      );
    });

    it('returns undefined when absent, blank, or not a positive integer', () => {
      expect(parseCompanyId({})).toBeUndefined();
      expect(parseCompanyId({ 'x-altegio-company-id': '  ' })).toBeUndefined();
      expect(parseCompanyId({ 'x-altegio-company-id': 'abc' })).toBeUndefined();
      expect(parseCompanyId({ 'x-altegio-company-id': '0' })).toBeUndefined();
      expect(parseCompanyId({ 'x-altegio-company-id': '-5' })).toBeUndefined();
      expect(parseCompanyId({ 'x-altegio-company-id': '4.5' })).toBeUndefined();
    });
  });

  describe('getRequestCompanyId', () => {
    it('returns undefined outside any request context', () => {
      expect(getRequestCompanyId()).toBeUndefined();
    });

    it('exposes the pinned company inside the context', () => {
      const seen = runWithContext({ identity: null, companyId: 4564 }, () =>
        getRequestCompanyId()
      );
      expect(seen).toBe(4564);
    });

    it('is undefined when no company was pinned', () => {
      const seen = runWithContext({ identity: null, userToken: 'tok' }, () =>
        getRequestCompanyId()
      );
      expect(seen).toBeUndefined();
    });
  });

  describe('assertCompanyAllowed', () => {
    it('is a no-op with no request context (stdio) or no pin', () => {
      expect(() => assertCompanyAllowed(999)).not.toThrow();
      expect(() =>
        runWithContext({ identity: null }, () => assertCompanyAllowed(999))
      ).not.toThrow();
    });

    it('allows the pinned company', () => {
      expect(() =>
        runWithContext({ identity: null, companyId: 4564 }, () =>
          assertCompanyAllowed(4564)
        )
      ).not.toThrow();
    });

    it('rejects any other company', () => {
      expect(() =>
        runWithContext({ identity: null, companyId: 4564 }, () =>
          assertCompanyAllowed(720441)
        )
      ).toThrow(/scoped to company 4564/);
    });
  });
});
