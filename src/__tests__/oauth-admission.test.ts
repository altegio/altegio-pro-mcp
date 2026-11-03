import { describe, expect, it } from '@jest/globals';
import { OauthGrantsCache, resolveOauthGrants } from '../auth/oauth-access.js';

describe('OAuth lookup admission', () => {
  const input = { apiBase: 'https://synthetic.test/api/v1', partnerToken: 'p' };
  it('shares one resource/profile pair across a burst for one token', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (url) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return new Response(
        JSON.stringify({
          data: String(url).includes('/user/data') ? { id: 1 } : [],
        })
      );
    };
    const cache = new OauthGrantsCache();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        resolveOauthGrants({ ...input, token: 'ag_at_same', fetchImpl }, cache)
      )
    );
    expect(calls).toBe(2);
  });

  it('bounds distinct tokens, expires stuck lookups, and admits a later retry', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true }
          );
        });
      } finally {
        active--;
      }
    };
    const cache = new OauthGrantsCache({ maxConcurrent: 2, timeoutMs: 60 });
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        resolveOauthGrants({ ...input, token: `ag_at_${i}`, fetchImpl }, cache)
      )
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(peak).toBe(2);
    expect(active).toBe(0);
    let retryCalls = 0;
    await resolveOauthGrants(
      {
        ...input,
        token: 'ag_at_0',
        fetchImpl: async (url) => {
          retryCalls++;
          return new Response(
            JSON.stringify({
              data: String(url).includes('/user/data') ? { id: 1 } : [],
            })
          );
        },
      },
      cache
    );
    expect(retryCalls).toBe(2);
  });
});
