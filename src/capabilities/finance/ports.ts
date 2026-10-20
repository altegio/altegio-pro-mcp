/**
 * The ports the finance capability talks to (ADR-001 D5): `VisitsApi` for an
 * appointment's visit — its items, payments and product lines — and
 * `FinanceApi` for client accounts, accounts and cash registers, financial
 * transactions and payroll.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import type { FinanceApi } from '../../api/finance-api.js';
import type { VisitsApi } from '../../api/visits-api.js';
import { FinanceAdapter } from '../../api/v1/finance-adapter.js';
import { VisitsAdapter } from '../../api/visits-adapter.js';

export function financeApi(client: AltegioClient): FinanceApi {
  return FinanceAdapter.forClient(client);
}

export function visitsApi(client: AltegioClient): VisitsApi {
  return VisitsAdapter.forClient(client);
}
