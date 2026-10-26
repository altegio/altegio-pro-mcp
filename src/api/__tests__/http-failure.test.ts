import { AltegioApiError, AuthenticationError } from '../../utils/errors.js';
import { runOnView, type ServingView } from '../../tools/serving-view.js';
import {
  mapHttpFailure,
  notSignedIn,
  sessionExpired,
  type FailureClasses,
} from '../http-failure.js';
import {
  FinanceAccessError,
  FinanceInputError,
  FinanceNotFoundError,
  mapFinanceHttpError,
} from '../../capabilities/finance/errors.js';
import { mapInventoryHttpError } from '../../capabilities/inventory/errors.js';
import { mapEventsHttpError } from '../../capabilities/events/errors.js';
import { mapMembershipsHttpError } from '../../capabilities/memberships/errors.js';
import { mapClientsHttpError } from '../../capabilities/clients/errors.js';

/** A hosted view: password login withheld, as on `/mcp`. */
const HOSTED: ServingView = {
  serves: (tool) => tool !== 'auth_login',
  addressesServing: () => [],
};

const onHosted = <T>(fn: () => T): T => runOnView(HOSTED, fn);

describe('sign-in wording', () => {
  it('names auth_login where the connection can call it', () => {
    expect(sessionExpired('read the visit').message).toBe(
      'Session expired while trying to read the visit. Call auth_login to re-authenticate.'
    );
    expect(notSignedIn('read the visit').message).toBe(
      'Not authenticated. Call auth_login before trying to read the visit.'
    );
    expect(notSignedIn().message).toBe(
      'Not authenticated. Call auth_login first.'
    );
  });

  it('sends a hosted connection to its MCP client instead', () => {
    for (const error of onHosted(() => [
      sessionExpired('read the visit'),
      notSignedIn('read the visit'),
      notSignedIn(),
    ])) {
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error.message).not.toContain('auth_login');
      expect(error.message).toMatch(/Sign in (again )?in your MCP client/);
    }
    expect(onHosted(() => sessionExpired('read the visit')).message).toContain(
      'expired while trying to read the visit'
    );
  });

  it.each([
    ['finance', () => mapFinanceHttpError(401, undefined, 'read the visit')],
    ['inventory', () => mapInventoryHttpError(401, undefined, 'list stock')],
    ['events', () => mapEventsHttpError(401, undefined, 'list events')],
    [
      'memberships',
      () => mapMembershipsHttpError(401, undefined, 'list memberships'),
    ],
    ['clients', () => mapClientsHttpError(401, undefined, 'search clients')],
  ])('the %s 401 follows the connection', (_domain, map) => {
    expect(map().message).toContain('auth_login');
    const hosted = onHosted(map);
    expect(hosted).toBeInstanceOf(AuthenticationError);
    expect(hosted.message).not.toContain('auth_login');
  });
});

describe('mapHttpFailure', () => {
  const classes: FailureClasses = {
    input: FinanceInputError,
    access: FinanceAccessError,
    notFound: FinanceNotFoundError,
  };
  const wording = {
    service: 'finance',
    forbidden: 'Ask the owner.',
    notFound: 'Check the ids.',
    alsoInvalid: [409],
  };
  const body = {
    success: false,
    meta: { message: 'An error occurred', errors: { '[amount]': ['too big'] } },
  };

  it('names our next step and quotes the API after it', () => {
    const error = mapHttpFailure(
      403,
      body,
      'record a payment',
      classes,
      wording
    );
    expect(error).toBeInstanceOf(FinanceAccessError);
    expect(error.message).toMatch(
      /^The signed-in user may not record a payment\. Ask the owner\. /
    );
    expect(error.message).toContain('An error occurred (amount: too big)');
  });

  it('lets one call name its own next step', () => {
    const error = mapHttpFailure(404, undefined, 'read it', classes, wording, {
      notFound: 'Check the appointment id.',
    });
    expect(error).toBeInstanceOf(FinanceNotFoundError);
    expect(error.message).toBe(
      'Not found while trying to read it. Check the appointment id.'
    );
  });

  it.each([400, 422, 409])('refuses %i as bad input', (status) => {
    expect(
      mapHttpFailure(status, undefined, 'save it', classes, wording)
    ).toBeInstanceOf(FinanceInputError);
  });

  it('reads a 429 as a rate limit: pause, then one request at a time', () => {
    const limited = mapHttpFailure(429, undefined, 'save it', classes, wording);
    expect(limited).toBeInstanceOf(AltegioApiError);
    expect(limited.statusCode).toBe(429);
    expect(limited.message).toBe(
      'Altegio is limiting the request rate while trying to save it (HTTP 429). Wait a few seconds before the next request, and send requests one at a time rather than in parallel.'
    );
  });

  it('reads a 5xx as the service being down, and anything else as itself', () => {
    const down = mapHttpFailure(503, undefined, 'save it', classes, wording);
    expect(down.message).toBe(
      'The finance service is temporarily unavailable while trying to save it (HTTP 503). Retry in a moment.'
    );
    const other = mapHttpFailure(418, undefined, 'save it', classes, wording);
    expect(other).toBeInstanceOf(AltegioApiError);
    expect(other.message).toBe('Could not save it (HTTP 418).');
  });
});
