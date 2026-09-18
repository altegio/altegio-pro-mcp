/**
 * Clients projections — text summaries for the tool results.
 *
 * The structured content is the port DTO (already canonical and budgeted); these
 * helpers build the short human-readable summary that rides next to it. Money is
 * printed in major units, exactly as the API reports it, with no rounding.
 *
 * Two rules hold everywhere in this module:
 *
 *  - Free text belongs to other people. Names, tags, comments, service titles
 *    and contacts were typed by clients and staff, so they are never
 *    interpolated into one of our sentences; they go in the fenced untrusted
 *    block that `withUntrustedBlock` appends, keyed back to our own rows by id
 *    or index.
 *  - Contacts are opt-in. Phone and email are withheld unless the caller asked
 *    for them, matching the "read clients without contacts" access level.
 */
import type {
  ClientCard,
  ClientLookupRow,
  ClientSegment,
  VisitHistory,
} from '../../api/clients-api.js';
import {
  withUntrustedBlock,
  type UntrustedField,
} from '../../tools/tool-result.js';
import { CONTACTS_WITHHELD_NOTICE } from '../../tools/contacts.js';

/** Format a major-unit amount, or `n/a` when the API reported nothing. */
export function formatMoney(amount: number | null): string {
  if (amount === null || amount === undefined) return 'n/a';
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

export function segmentSummary(
  segment: ClientSegment,
  orderBy: string | undefined,
  showRows: number
): string {
  const lines = [
    `${segment.total_count} client(s) match this filter.`,
    `Showing page ${segment.page} (${segment.rows.length} of up to ${segment.page_size} rows${orderBy ? `, ordered by ${orderBy}` : ''}).`,
  ];
  const shown = segment.rows.slice(0, showRows);
  if (shown.length > 0) {
    lines.push(
      `Client ids on this page: ${shown.map((r) => r.id).join(', ')}.`
    );
  }
  if (segment.rows.length > showRows) {
    lines.push(
      `… ${segment.rows.length - showRows} more in the structured result.`
    );
  }
  if (segment.total_count > segment.page * segment.page_size) {
    lines.push(
      `More pages available: ask for page ${segment.page + 1} to continue.`
    );
  }

  const names: UntrustedField[] = shown.map((row) => ({
    label: `client ${row.id} name`,
    value: row.name,
  }));
  return withUntrustedBlock(lines.join('\n'), names, { maxChars: 120 });
}

export function cardSummary(
  card: ClientCard,
  options: { includeContacts?: boolean } = {}
): string {
  const lines = [
    `Client id ${card.id}:`,
    `Importance: ${card.importance ?? 'n/a'}, discount: ${card.discount ?? 0}%`,
    `Visits: ${card.visit_count ?? 'n/a'}, total spent: ${formatMoney(card.total_spent)}, client-account balance: ${formatMoney(card.client_account_balance)}`,
    `SMS birthday greeting: ${card.sms_birthday_greeting ? 'on' : 'off'}, excluded from campaigns: ${card.sms_excluded_from_campaigns ? 'yes' : 'no'}`,
  ];
  if (!options.includeContacts) lines.push(CONTACTS_WITHHELD_NOTICE);

  const fields: UntrustedField[] = [
    {
      label: 'name',
      value: [card.name, card.surname].filter(Boolean).join(' '),
    },
    ...(options.includeContacts
      ? [
          { label: 'phone', value: card.phone },
          { label: 'email', value: card.email },
        ]
      : []),
    {
      label: 'tags',
      value: card.tags
        .map((t) => t.title)
        .filter(Boolean)
        .join(', '),
    },
    { label: 'comment', value: card.comment },
  ];
  return withUntrustedBlock(lines.join('\n'), fields);
}

export function visitHistorySummary(history: VisitHistory): string {
  if (history.items.length === 0) {
    return 'No visits found for this client and filter.';
  }
  const shown = history.items.slice(0, 15);
  const lines = [`${history.items.length} visit item(s) on this page:`];
  const detail: UntrustedField[] = [];

  shown.forEach((item, index) => {
    const ref = index + 1;
    lines.push(
      `- [${ref}] ${item.date ?? 'n/a'} [${item.outcome ?? 'sale'}] · sold ${formatMoney(item.total_cost)}, paid ${formatMoney(item.total_paid)}`
    );
    const what =
      item.services.length > 0
        ? item.services
            .map((s) => s.title)
            .filter(Boolean)
            .join(', ')
        : item.products
            .map((p) => p.title)
            .filter(Boolean)
            .join(', ');
    detail.push({ label: `[${ref}] items`, value: what });
    detail.push({
      label: `[${ref}] team member`,
      value: item.team_member_name,
    });
  });

  if (history.has_more) {
    lines.push(
      `More visits before this page: pass date_to=${history.next_to ?? '(next_to)'} to continue.`
    );
  }
  return withUntrustedBlock(lines.join('\n'), detail, { maxChars: 200 });
}

export function lookupSummary(
  rows: ClientLookupRow[],
  options: { includeContacts?: boolean } = {}
): string {
  if (rows.length === 0) return 'No matching client found.';
  const lines = [
    `${rows.length} match(es), client ids: ${rows.map((r) => r.id).join(', ')}.`,
  ];
  if (!options.includeContacts) lines.push(CONTACTS_WITHHELD_NOTICE);

  const fields: UntrustedField[] = [];
  for (const row of rows) {
    fields.push({ label: `client ${row.id} name`, value: row.name });
    if (options.includeContacts) {
      fields.push({ label: `client ${row.id} phone`, value: row.phone });
    }
  }
  return withUntrustedBlock(lines.join('\n'), fields, { maxChars: 120 });
}
