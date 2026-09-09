import { describe, it, expect } from '@jest/globals';
import {
  parseIdentityHeaders,
  parseUserToken,
  parsePartnerToken,
  parseCompanyIds,
  runWithIdentity,
  runWithContext,
  getRequestIdentity,
  getRequestUserToken,
  getRequestPartnerToken,
  getRequestCompanyIds,
  isCompanyAllowed,
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

  describe('parsePartnerToken (UC2 fork selector)', () => {
    it('reads the X-Altegio-Partner-Token header', () => {
      expect(
        parsePartnerToken({ 'x-altegio-partner-token': 'partner-abc' })
      ).toBe('partner-abc');
    });

    it('is case-insensitive and trims whitespace', () => {
      expect(parsePartnerToken({ 'X-Altegio-Partner-Token': '  ptk  ' })).toBe(
        'ptk'
      );
    });

    it('returns undefined when absent or blank (stays on the UC1 path)', () => {
      expect(parsePartnerToken({})).toBeUndefined();
      expect(
        parsePartnerToken({ 'x-altegio-partner-token': '   ' })
      ).toBeUndefined();
    });
  });

  describe('parseCompanyIds (declared scope)', () => {
    it('reads a single positive integer', () => {
      expect([
        ...(parseCompanyIds({ 'x-altegio-company-id': '4564' }) ?? []),
      ]).toEqual([4564]);
    });

    it('reads a comma-separated set', () => {
      const set = parseCompanyIds({
        'x-altegio-company-id': '4564, 720441 ,5',
      });
      expect(set && [...set].sort((a, b) => a - b)).toEqual([5, 4564, 720441]);
    });

    it('reads a repeated header presented as an array', () => {
      const set = parseCompanyIds({
        'x-altegio-company-id': ['4564', '720441'],
      });
      expect(set && [...set].sort((a, b) => a - b)).toEqual([4564, 720441]);
    });

    it('combines repeated headers and comma-separated values, de-duplicating', () => {
      const set = parseCompanyIds({
        'x-altegio-company-id': ['4564,720441', '720441, 5'],
      });
      expect(set && [...set].sort((a, b) => a - b)).toEqual([5, 4564, 720441]);
    });

    it('is case-insensitive', () => {
      expect([
        ...(parseCompanyIds({ 'X-Altegio-Company-Id': '4564' }) ?? []),
      ]).toEqual([4564]);
    });

    it('ignores non-integer fragments but keeps valid ones', () => {
      const set = parseCompanyIds({
        'x-altegio-company-id': '4564, abc, 0, -5, 4.5, 720441',
      });
      expect(set && [...set].sort((a, b) => a - b)).toEqual([4564, 720441]);
    });

    it('returns undefined when absent, blank, or wholly invalid', () => {
      expect(parseCompanyIds({})).toBeUndefined();
      expect(parseCompanyIds({ 'x-altegio-company-id': '  ' })).toBeUndefined();
      expect(
        parseCompanyIds({ 'x-altegio-company-id': 'abc, 0, -1' })
      ).toBeUndefined();
    });
  });

  describe('getRequestPartnerToken', () => {
    it('returns undefined outside any request context (stdio)', () => {
      expect(getRequestPartnerToken()).toBeUndefined();
    });

    it('exposes the per-request partner token inside the context', () => {
      const seen = runWithContext(
        { identity: null, partnerToken: 'ptk', userToken: 'utk' },
        () => getRequestPartnerToken()
      );
      expect(seen).toBe('ptk');
    });

    it('is undefined on a UC1 request (no partner header)', () => {
      const seen = runWithContext({ identity: null, userToken: 'utk' }, () =>
        getRequestPartnerToken()
      );
      expect(seen).toBeUndefined();
    });
  });

  describe('getRequestCompanyIds', () => {
    it('returns undefined outside any request context', () => {
      expect(getRequestCompanyIds()).toBeUndefined();
    });

    it('exposes the declared scope inside the context', () => {
      const seen = runWithContext(
        { identity: null, companyIds: new Set([4564, 720441]) },
        () => getRequestCompanyIds()
      );
      expect(seen && [...seen].sort((a, b) => a - b)).toEqual([4564, 720441]);
    });

    it('is undefined when no scope was declared', () => {
      const seen = runWithContext({ identity: null, userToken: 'tok' }, () =>
        getRequestCompanyIds()
      );
      expect(seen).toBeUndefined();
    });
  });

  describe('isCompanyAllowed', () => {
    it('allows any company when no scope is declared', () => {
      expect(isCompanyAllowed(999)).toBe(true);
      expect(
        runWithContext({ identity: null }, () => isCompanyAllowed(999))
      ).toBe(true);
    });

    it('allows only companies in the declared set', () => {
      runWithContext(
        { identity: null, companyIds: new Set([4564, 720441]) },
        () => {
          expect(isCompanyAllowed(4564)).toBe(true);
          expect(isCompanyAllowed(720441)).toBe(true);
          expect(isCompanyAllowed(5)).toBe(false);
        }
      );
    });
  });

  describe('assertCompanyAllowed', () => {
    it('is a no-op with no request context (stdio) or no declared scope', () => {
      expect(() => assertCompanyAllowed(999)).not.toThrow();
      expect(() =>
        runWithContext({ identity: null }, () => assertCompanyAllowed(999))
      ).not.toThrow();
    });

    it('allows every company in a single-element scope', () => {
      expect(() =>
        runWithContext({ identity: null, companyIds: new Set([4564]) }, () =>
          assertCompanyAllowed(4564)
        )
      ).not.toThrow();
    });

    it('allows every company in a multi-element scope', () => {
      runWithContext(
        { identity: null, companyIds: new Set([4564, 720441, 5]) },
        () => {
          expect(() => assertCompanyAllowed(4564)).not.toThrow();
          expect(() => assertCompanyAllowed(720441)).not.toThrow();
          expect(() => assertCompanyAllowed(5)).not.toThrow();
        }
      );
    });

    it('rejects only the companies outside the scope (403)', () => {
      runWithContext(
        { identity: null, companyIds: new Set([4564, 720441]) },
        () => {
          expect(() => assertCompanyAllowed(999)).toThrow(/not in scope/);
          // The message lists the declared set so the caller can see the scope.
          expect(() => assertCompanyAllowed(999)).toThrow(/4564, 720441/);
        }
      );
    });
  });
});
