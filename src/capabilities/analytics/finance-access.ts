/**
 * Preconditions shared by the finance-ledger reports (client cash receipts and
 * client payer cohorts): a whole-month period and a verified finance boundary.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { readUserPermissions } from '../../api/v1/user-permissions.js';
import {
  AnalyticsAccessError,
  AnalyticsInputError,
  AnalyticsUnavailableError,
} from './errors.js';

/**
 * Standard finance income categories (`CTransactions` type ids), in the order
 * the cash-receipt streams are reported. Any other income category is custom
 * and stays unclassified.
 */
export const INCOME_CATEGORY_IDS = {
  services: 5,
  products: 7,
  client_account_topups: 10,
  miscellaneous_income: 8,
  memberships: 6,
  gift_cards: 12,
  penalties: 13,
} as const;

/** Most local calendar months one finance report call covers. */
export const MAX_FINANCE_MONTHS = 12;

/**
 * The finance report rounds any period out to whole local months, so only a
 * period that already is whole months reports what was asked for.
 */
export function validateCompleteMonths(from: string, to: string): void {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start.toISOString().slice(0, 10) !== from ||
    end.toISOString().slice(0, 10) !== to ||
    start.getUTCDate() !== 1 ||
    end.getUTCDate() !==
      new Date(
        Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)
      ).getUTCDate() ||
    start > end
  ) {
    throw new AnalyticsInputError(
      'Select complete local calendar months: date_from must be the first day of a month and date_to the last day of a month.'
    );
  }
  const months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    end.getUTCMonth() -
    start.getUTCMonth() +
    1;
  if (months > MAX_FINANCE_MONTHS)
    throw new AnalyticsInputError(
      `This report covers at most ${MAX_FINANCE_MONTHS} complete calendar months per call; split the period.`
    );
}

/**
 * Verify the effective finance rights of the request's user before reading the
 * finance report, and return them.
 *
 * The backend treats an empty allowed-account list as "no filter", so an
 * account-limited user with no listed account would silently see every
 * account; that case is refused rather than widened.
 */
export async function assertFinanceReportAccess(
  client: AltegioClient,
  locationId: number
): Promise<Readonly<Record<string, unknown>>> {
  const rights = (await readUserPermissions(client, locationId)).finances;
  if (!rights) {
    throw new AnalyticsUnavailableError(
      'Effective finance permissions could not be verified for this location; retry, or ask a location owner to check the user’s finance rights.',
      502
    );
  }
  if (rights.finances_year_report_access !== true) {
    throw new AnalyticsAccessError(
      'The signed-in user needs the finance annual-report right in this location. Ask a location owner to grant it.'
    );
  }
  if (typeof rights.finances_accounts_limited_access !== 'boolean') {
    throw new AnalyticsUnavailableError(
      'The effective finance account boundary could not be verified for this location.',
      502
    );
  }
  if (rights.finances_accounts_limited_access) {
    const ids = rights.finances_accounts_ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)
    ) {
      throw new AnalyticsAccessError(
        'No authorized finance accounts are listed for this account-limited user, so the finance report cannot be read safely. Ask a location owner to assign the user’s accounts.'
      );
    }
  }
  return rights;
}
