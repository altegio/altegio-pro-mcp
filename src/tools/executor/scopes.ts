/**
 * The scope one catalog operation requires, by the domain the catalog files
 * it under. The executor serves reads only (ADR-001 D2), so every entry is a
 * read scope of the Altegio catalog; a domain missing here means the
 * operation cannot be run under a scoped token until it is mapped, which the
 * executor's coverage test turns into a failing build.
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

/** The read scope of the operation's domain, or `undefined` when unmapped. */
export function executorScopeFor(op: {
  readonly domain: string;
}): ToolScope | undefined {
  return Object.hasOwn(SCOPE_BY_DOMAIN, op.domain)
    ? SCOPE_BY_DOMAIN[op.domain]
    : undefined;
}
