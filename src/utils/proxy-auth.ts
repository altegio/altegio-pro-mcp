import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

// Platform v1 proxy signature: timestamp, method, exact path/query and sorted
// x-mcp-auth-* headers. Body bytes are streamed and are not signed. Rotation
// accepts every configured key. HTTP middleware enforces this for delegated
// and signed requests; direct Altegio token clients remain supported.

export const PROXY_AUTH_HEADER = 'x-mcp-proxy-auth';
export const PROXY_AUTH_SKEW_SEC = 300;
export const MIN_PROXY_KEY_LENGTH = 32;

const SIGNATURE_FORMAT = /^v1:(\d{1,12}):([0-9a-f]{64})$/;
const IDENTITY_PREFIX = 'x-mcp-auth-';
const CANONICAL_VERSION = 'mcp-proxy-auth/v1';

export type ProxyAuthReason =
  'missing' | 'malformed' | 'stale' | 'bad_signature';

export type ProxyAuthResult =
  { ok: true } | { ok: false; reason: ProxyAuthReason };

// A comma-separated list, so a rotation can carry the old and the new key at
// once. Keys shorter than the minimum are dropped, as the platform does.
export function parseProxyKeys(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length >= MIN_PROXY_KEY_LENGTH);
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}

// Sorted by header NAME, not by whole line: ':' sorts after '-', so when one
// name is a prefix of another the two orders differ and only this one matches
// the platform's signer.
function canonicalString(
  seconds: number,
  method: string,
  path: string,
  headers: IncomingHttpHeaders
): string {
  const identity = Object.keys(headers)
    .filter((name) => name.startsWith(IDENTITY_PREFIX))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => `${name}:${headerText(headers[name])}`);
  return [
    CANONICAL_VERSION,
    String(seconds),
    method.toUpperCase(),
    path,
    ...identity,
  ].join('\n');
}

export function verifyProxyRequest(opts: {
  keys: readonly string[];
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  nowMs?: number;
}): ProxyAuthResult {
  const raw = opts.headers[PROXY_AUTH_HEADER];
  if (typeof raw !== 'string' || raw === '') {
    return { ok: false, reason: 'missing' };
  }
  const match = SIGNATURE_FORMAT.exec(raw);
  if (match === null) return { ok: false, reason: 'malformed' };
  // The platform signs String(Number(ts)), so leading zeros normalise.
  const seconds = Number(match[1]);
  const nowSeconds = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - seconds) > PROXY_AUTH_SKEW_SEC) {
    return { ok: false, reason: 'stale' };
  }
  const received = Buffer.from(match[2] ?? '', 'hex');
  const text = canonicalString(seconds, opts.method, opts.path, opts.headers);
  let accepted = false;
  // Every key is tried even after a match, so timing does not tell which
  // position in the rotation list matched.
  for (const key of opts.keys) {
    const expected = createHmac('sha256', key).update(text, 'utf8').digest();
    if (
      expected.length === received.length &&
      timingSafeEqual(expected, received)
    ) {
      accepted = true;
    }
  }
  return accepted ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
