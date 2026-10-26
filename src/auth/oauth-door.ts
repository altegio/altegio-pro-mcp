/**
 * The HTTP door for Altegio OAuth access tokens.
 *
 * The platform proxy passes an `ag_at_…` bearer through untouched, so this
 * server is the OAuth protected resource: before a request reaches the MCP
 * transport, the token's grants are resolved once per token (and cached for
 * its lifetime). A token Altegio refuses is answered the way RFC 9728 hosts
 * expect — 401 with `WWW-Authenticate: Bearer … resource_metadata="…"` naming
 * the proxy's protected-resource document — so the host refreshes the token
 * or signs in again instead of reading an in-band error it cannot act on.
 */
import type { RequestHandler } from 'express';
import { loadConfig } from '../config/schema.js';
import { getRequestUserToken } from '../request-context.js';
import { createLogger } from '../utils/logger.js';
import { AuthenticationError } from '../utils/errors.js';
import {
  OauthGrantsUnavailableError,
  OauthTokenRejectedError,
  fetchOauthGrants,
  isOauthAccessToken,
  oauthGrantsCache,
  resolveOauthGrants,
} from './oauth-access.js';

const logger = createLogger('oauth-door');

/** `/mcp/<view>` → `<view>`: the section of Pro the proxy serves at `/pro/<view>`. */
const VIEW_SEGMENT = /^\/mcp\/([a-z][a-z0-9_-]{0,63})(?:\/|$)/;

/**
 * The protected-resource metadata document for the address the request came
 * in on: `/mcp` is `/pro`, `/mcp/<view>` is `/pro/<view>`. RFC 9728 §3.3 has
 * the document name exactly that address, so a host that checks `resource`
 * against the URL it connected to accepts it; the read-only view is its own
 * route (`/pro/readonly`).
 */
export function protectedResourceMetadataUrl(
  publicBaseUrl: string,
  requestPath: string
): string {
  const base = new URL(publicBaseUrl);
  const path = base.pathname.replace(/\/+$/, '');
  const view = VIEW_SEGMENT.exec(requestPath)?.[1];
  return `${base.origin}/.well-known/oauth-protected-resource${path}${view ? `/${view}` : ''}`;
}

export interface OauthDoorOptions {
  apiBase: string;
  partnerToken: string;
  publicBaseUrl: string;
  fetchImpl?: typeof fetch;
}

/** Express middleware: admit, challenge or defer an `ag_at_` request. */
export function oauthDoor(options: OauthDoorOptions): RequestHandler {
  const realm = new URL(options.publicBaseUrl).host;
  return async (req, res, next) => {
    if (!req.path.startsWith('/mcp')) return next();
    const header = req.headers['x-altegio-user-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!isOauthAccessToken(token)) return next();
    try {
      await resolveOauthGrants({
        token: token!,
        apiBase: options.apiBase,
        partnerToken: options.partnerToken,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      next();
    } catch (error) {
      if (error instanceof OauthTokenRejectedError) {
        const metadata = protectedResourceMetadataUrl(
          options.publicBaseUrl,
          req.path
        );
        logger.info(
          {
            event: 'oauth_token_rejected',
            route: req.path,
            http_status: 401,
            outcome: 'error',
            error_type: 'invalid_token',
          },
          'Altegio refused the access token'
        );
        res
          .status(401)
          .set(
            'WWW-Authenticate',
            `Bearer realm="${realm}", error="invalid_token", resource_metadata="${metadata}", error_description="Sign in with Altegio again"`
          )
          .json({
            error: 'invalid_token',
            error_description:
              'The Altegio access token was not accepted. Refresh it or sign in with Altegio again.',
          });
        return;
      }
      if (error instanceof OauthGrantsUnavailableError) {
        logger.warn(
          {
            event: 'oauth_grants_unavailable',
            route: req.path,
            http_status: 503,
            outcome: 'error',
            error_type: 'altegio_unavailable',
          },
          'Altegio could not verify the access token'
        );
        res
          .status(503)
          .set('Retry-After', '5')
          .json({ error: 'temporarily_unavailable' });
        return;
      }
      next(error);
    }
  };
}

/**
 * Ask Altegio for a fresh verdict on the current request's OAuth token before
 * serving data this server holds locally (a stored report, an onboarding
 * checkpoint). Every API-backed call is refused by Altegio itself the moment
 * a consent is withdrawn; local data would not be, without this. A legacy
 * token or stdio has nothing to ask about.
 */
export async function assertOauthTokenLive(
  fetchImpl?: typeof fetch
): Promise<void> {
  const token = getRequestUserToken();
  if (token === undefined || !isOauthAccessToken(token)) return;
  const { altegio } = loadConfig();
  try {
    const grants = await fetchOauthGrants({
      token,
      apiBase: altegio.apiBase,
      partnerToken: altegio.partnerToken,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    oauthGrantsCache.set(token, grants);
  } catch (error) {
    if (error instanceof OauthTokenRejectedError) {
      oauthGrantsCache.evict(token);
      throw new AuthenticationError(
        'The Altegio sign-in of this connection is no longer valid. Sign in again in your MCP client, then retry.'
      );
    }
    throw error;
  }
}
