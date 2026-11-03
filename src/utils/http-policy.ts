import type { RequestHandler } from 'express';
import type { EnvConfig } from '../config/schema.js';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const values = (value: string | undefined) =>
  value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? [];

export function httpMode(
  env: EnvConfig,
  hasProxyKeys: boolean
): 'local' | 'hosted' {
  return (
    env.MCP_HTTP_MODE ??
    (hasProxyKeys || env.REQUIRE_DELEGATED_IDENTITY ? 'hosted' : 'local')
  );
}

/** Validate the direct Host/Origin; forwarded headers are never an authority. */
export function browserBoundary(
  env: EnvConfig,
  hosted: boolean
): RequestHandler {
  const hosts = new Set(
    [
      ...LOOPBACK_HOSTS,
      ...(hosted ? [new URL(env.MCP_PUBLIC_BASE_URL).hostname] : []),
      ...values(env.MCP_HTTP_ALLOWED_HOSTS),
    ].map((h) => h.toLowerCase())
  );
  const configuredOrigins = values(env.MCP_HTTP_ALLOWED_ORIGINS);
  for (const origin of configuredOrigins) {
    let valid = false;
    try {
      const url = new URL(origin);
      valid =
        ['http:', 'https:'].includes(url.protocol) && url.origin === origin;
    } catch {
      /* Refuse invalid configured origins. */
    }
    if (!valid)
      throw new Error(
        'MCP_HTTP_ALLOWED_ORIGINS must contain exact HTTP(S) origins'
      );
  }
  const origins = new Set([
    ...(hosted ? [new URL(env.MCP_PUBLIC_BASE_URL).origin] : []),
    ...configuredOrigins,
  ]);
  return (req, res, next) => {
    if (!req.path.startsWith('/mcp')) return next();
    const host = req.headers.host;
    let hostname: string | undefined;
    try {
      if (host && !/[\s/@?#\\]/.test(host))
        hostname = new URL(`http://${host}`).hostname;
    } catch {
      /* A malformed Host is refused below. */
    }
    const origin = req.headers.origin;
    if (
      !hostname ||
      !hosts.has(hostname.toLowerCase()) ||
      (origin !== undefined && !origins.has(origin))
    ) {
      res.status(403).json({ error: 'untrusted_host_or_origin' });
      return;
    }
    next();
  };
}
