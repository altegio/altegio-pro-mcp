/**
 * The scope one catalog operation requires, by the domain the catalog files
 * it under and the level it works at. The executor serves reads only
 * (ADR-001 D2), so every entry is a read scope of the Altegio catalog; a
 * domain missing here means the operation cannot be run under a scoped token
 * until it is mapped, which the executor's coverage test turns into a
 * failing build.
 *
 * Chains and locations are separate grants (RFC decision 13): an operation
 * addressed by `chain_id` and no location needs the chain-level scope of its
 * domain, never the location one.
 */
import type { ToolScope } from '../scopes.js';

const SCOPE_BY_DOMAIN: Readonly<Record<string, ToolScope>> = {
  altegio_plan: 'locations:read',
  analytics: 'analytics:read',
  appointment_calendar: 'locations:read',
  appointments: 'appointments:read',
  client_accounts: 'client_accounts:read',
  clients: 'clients:read',
  custom_fields: 'clients:read',
  events: 'events:read',
  finance: 'finance:read',
  financial_transactions_accounts: 'finance:read',
  fiscalization: 'finance:read',
  gift_cards: 'loyalty:read',
  group_events: 'events:read',
  inventory: 'inventory:read',
  locations: 'locations:read',
  loyalty: 'loyalty:read',
  membership_types: 'chain_loyalty:read',
  memberships: 'loyalty:read',
  messaging: 'locations:read',
  online_booking: 'online_booking:read',
  payroll: 'payroll:read',
  positions: 'team_members:read',
  products: 'products:read',
  resources: 'locations:read',
  schedule: 'team_members:read',
  services: 'services:read',
  settings: 'locations:read',
  tags: 'appointments:read',
  team_member_schedules: 'team_members:read',
  team_members: 'team_members:read',
  users: 'team_members:read',
  utilities: 'locations:read',
  visits: 'checkout:read',
};

/** The chain-level reads the catalog has today, by domain. */
const CHAIN_SCOPE_BY_DOMAIN: Readonly<Record<string, ToolScope>> = {
  client_accounts: 'chain_client_accounts:read',
  clients: 'chain_clients:read',
  gift_cards: 'chain_loyalty:read',
  loyalty: 'chain_loyalty:read',
  membership_types: 'chain_loyalty:read',
  memberships: 'chain_loyalty:read',
  services: 'chain_services:read',
};

const LOCATION_PARAMETERS = new Set(['location_id', 'company_id', 'salon_id']);

export interface ScopedOperation {
  readonly domain: string;
  readonly path?: string;
  readonly parameters?: ReadonlyArray<{
    readonly name: string;
    readonly in?: string;
  }>;
}

/** Addressed by a chain and no location: `/chains/{chain_id}/…`, `/deposits/chain/{chain_id}`. */
export function isChainLevelOperation(op: ScopedOperation): boolean {
  const parameters = op.parameters ?? [];
  const byChain = parameters.some(
    (p) => p.in === 'path' && p.name.toLowerCase() === 'chain_id'
  );
  const byLocation = parameters.some((p) =>
    LOCATION_PARAMETERS.has(p.name.toLowerCase())
  );
  return byChain && !byLocation;
}

/** The read scope of the operation's domain at its level, or `undefined` when unmapped. */
export function executorScopeFor(op: ScopedOperation): ToolScope | undefined {
  const table = isChainLevelOperation(op)
    ? CHAIN_SCOPE_BY_DOMAIN
    : SCOPE_BY_DOMAIN;
  return Object.hasOwn(table, op.domain) ? table[op.domain] : undefined;
}
