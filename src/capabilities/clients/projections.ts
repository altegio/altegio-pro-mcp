/**
 * Clients projections — text summaries for the tool results.
 *
 * The structured content is the port DTO (already canonical and budgeted); these
 * helpers build the short human-readable summary that rides next to it. Money is
 * printed in major units, exactly as the API reports it, with no rounding.
 */
import type {
  ClientCard,
  ClientLookupRow,
  ClientSegment,
  VisitHistory,
} from '../../api/clients-api.js';

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
  for (const row of segment.rows.slice(0, showRows)) {
    lines.push(`- ${row.name || '(no name)'} — id ${row.id}`);
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
  return lines.join('\n');
}

export function cardSummary(card: ClientCard): string {
  const name =
    [card.name, card.surname].filter(Boolean).join(' ') || '(no name)';
  return [
    `Client ${name} (id ${card.id}):`,
    `Phone: ${card.phone ?? 'n/a'}, email: ${card.email ?? 'n/a'}`,
    `Importance: ${card.importance ?? 'n/a'}, discount: ${card.discount ?? 0}%`,
    `Visits: ${card.visit_count ?? 'n/a'}, total spent: ${formatMoney(card.total_spent)}, client-account balance: ${formatMoney(card.client_account_balance)}`,
    `Tags: ${
      card.tags
        .map((t) => t.title)
        .filter(Boolean)
        .join(', ') || 'none'
    }`,
    `SMS birthday greeting: ${card.sms_birthday_greeting ? 'on' : 'off'}, excluded from campaigns: ${card.sms_excluded_from_campaigns ? 'yes' : 'no'}`,
  ].join('\n');
}

export function visitHistorySummary(history: VisitHistory): string {
  if (history.items.length === 0) {
    return 'No visits found for this client and filter.';
  }
  const lines = [`${history.items.length} visit item(s) on this page:`];
  for (const item of history.items.slice(0, 15)) {
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
    lines.push(
      `- ${item.date ?? 'n/a'} [${item.outcome ?? 'sale'}] ${what || '—'} · sold ${formatMoney(item.total_cost)}, paid ${formatMoney(item.total_paid)}`
    );
  }
  if (history.has_more) {
    lines.push(
      `More visits before this page: pass date_to=${history.next_to ?? '(next_to)'} to continue.`
    );
  }
  return lines.join('\n');
}

export function lookupSummary(rows: ClientLookupRow[]): string {
  if (rows.length === 0) return 'No matching client found.';
  return [
    `${rows.length} match(es):`,
    ...rows.map(
      (r) =>
        `- ${r.name ?? '(no name)'} — id ${r.id}${r.phone ? `, ${r.phone}` : ''}`
    ),
  ].join('\n');
}
