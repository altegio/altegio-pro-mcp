/**
 * Reading notes for the universal executor.
 *
 * `altegio_describe_operation` renders the raw spec of an operation, which still
 * speaks the legacy dialect (`record`, `attendance`, `paid_full`, `is_mobile`)
 * and rarely spells out what its coded fields mean. A capable model fills the
 * gaps; a weaker one guesses. These notes bridge the gap: for the domains that
 * feed a location analysis, they legend the coded values and point at the
 * analytics data-model and playbook resources, so the long tail self-explains
 * the way the curated analytics tools already do.
 *
 * This module is intentionally *not* held to the analytics terminology guard —
 * unlike the agent-facing analytics surface, its whole job is to name the legacy
 * spec field (`attendance`) next to its canonical meaning (visit status), so a
 * caller reading the raw contract knows what the number is.
 */
import type { CatalogOperation } from './catalog.js';

const DATA_MODEL_URI = 'altegio://analytics/data-model';
const PLAYBOOK_URI = 'altegio://analytics/playbook';

/** Notes shared by every domain that rolls up into location analysis. */
const ANALYTICS_POINTER = `For how these fields roll up into metrics (revenue, average check, occupancy, new/returning/lost clients) read \`${DATA_MODEL_URI}\`; for how to reason with them read \`${PLAYBOOK_URI}\`. Prefer the curated \`analytics_*\` tools for aggregates — they return canonical vocabulary and period comparison.`;

/**
 * Domain → reading notes. Keyed by the catalog `domain` field so a note reaches
 * every operation in the domain without listing operation ids. Money and
 * attendance legends are the two most valuable, because they are where a wrong
 * guess most misleads an owner.
 */
const NOTES_BY_DOMAIN: Readonly<Record<string, readonly string[]>> = {
  appointments: [
    'This is an appointment (the v1 spec calls it a `record`); one appointment is one team member in one slot.',
    'Visit status is a coded field: `attendance`/`visit_attendance` = -1 no-show, 0 waiting, 1 arrived, 2 confirmed (V3 spells them no_show/waiting/arrived/confirmed/cancelled). Only an arrived appointment becomes a visit with revenue.',
    'Marking is manual: about one past appointment in eight is never moved off waiting/confirmed, so attendance-based counts undercount — treat them as a floor.',
    '`paid_full` = 1 means the appointment is fully paid. `is_mobile` = 0 (admin, app or web created by the team) · 1 (mobile-browser online widget) · 2 (desktop-browser online widget), so `is_mobile > 0` is an online booking. `visit_id` links the appointment to its billing visit.',
  ],
  visits: [
    'A visit is the billing unit: it groups one or more appointments and carries the items actually sold and the payments that settled them. Revenue, average check and the paid/unpaid state come from the visit, not the appointment.',
  ],
  payments: [
    'These are financial transactions — individual money movements. `real_money` = 1 is cash or card actually moving; 0 is a bonus, loyalty or promotional settlement (a write-off, not takings).',
    'An `account` is where money is held and counted (a till or a card terminal), which gives the cash-versus-non-cash split. `expense`/`expense_id` is the payment item (for example services or product sales), not a cost.',
  ],
  clients: [
    'A client card carries lifetime `spent` and `visits`, and first/last visit dates — these drive the new / returning / lost split. Clients are deduplicated by phone number, so two cards for one person count once.',
    '`importance` is a priority class (0 none, 1 bronze, 2 silver, 3 gold); `balance` is the client-account balance (store credit the location holds), not a login.',
  ],
  client_accounts: [
    'A client account is store credit the location holds for a client — money, not a login. A top-up is income when it arrives and a write-off when it is later spent on a visit.',
  ],
  sales: [
    'A sale line is one service or product sold on a visit. `cost` is the price after loyalty discounts; product margin is price minus cost price. A sale writes both a money movement and, for products, a stock movement.',
  ],
  loyalty: [
    'Loyalty cards, programs, memberships and gift cards are calculation modifiers applied to a visit before the final payment — each application is reversible until checkout. Value they settle is a write-off, not cash taken.',
  ],
  memberships: [
    'Memberships and gift cards are prepaid: sold once (revenue then), redeemed later (a write-off against the visit, no new cash). Value remaining and expiry are what the loyalty dataset reports.',
  ],
  schedule: [
    'Occupancy is booked time over scheduled time. A team member with no schedule contributes no scheduled time, so their occupancy is blank, not zero.',
  ],
};

/**
 * Reading notes for one operation, or an empty array when the domain has none.
 * The analytics pointer is appended whenever there is at least one note, so the
 * caller always learns where the aggregates and the reasoning live.
 */
export function readingNotesFor(op: CatalogOperation): string[] {
  const domainNotes = NOTES_BY_DOMAIN[op.domain];
  if (!domainNotes || domainNotes.length === 0) return [];
  return [...domainNotes, ANALYTICS_POINTER];
}
