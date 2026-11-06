/**
 * Gift card use cases — everything the `gift_cards_*` tools do.
 *
 * Gift card types are templates of a chain; a location sells some of them, and
 * a client's sold gift cards are found by the phone on their location card.
 * Titles and online-sale texts are other people's text: they go into the
 * untrusted block after our own summary, never into it.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { GiftCardsAdapter } from '../../api/v1/gift-cards-adapter.js';
import type {
  GiftCard,
  GiftCardType,
  GiftCardTypeFields,
  GiftCardUsage,
  GiftCardsApi,
  PeriodUnit,
} from '../../api/gift-cards-api.js';
import { GiftCardsInputError } from './errors.js';
import { assertCompaniesAllowed } from '../../request-context.js';
import { resolveLocationCurrency } from '../../api/v1/location-currency.js';
import {
  decimalsOf,
  majorOf,
  moneyInput,
  MoneyInputError,
  moneyOf,
  sameMajor,
  type Money,
} from '../../api/money.js';
import {
  paginateCollection,
  renderPage,
  type PageInput,
} from '../../tools/pagination.js';
import {
  withUntrustedBlock,
  type UntrustedField,
} from '../../tools/tool-result.js';

export interface GiftCardsResult {
  text: string;
  structuredContent: unknown;
  isError?: boolean;
}

function api(client: AltegioClient): GiftCardsApi {
  return GiftCardsAdapter.forClient(client);
}

const FIELD_MAX_CHARS = 200;

// ========== rendering ==========

const USAGE_TEXT: Record<GiftCardUsage, string> = {
  services_and_products: 'pays for any service or product',
  services: 'pays for any service, no products',
  products: 'pays for any product, no services',
  listed_services: 'pays for the listed services only',
  listed_services_and_products: 'pays for the listed services and any product',
};

function expiryText(t: GiftCardType): string {
  const e = t.expiry;
  if (e.type === 'never') return 'never expires';
  if (e.type === 'fixed_date')
    return `expires on ${e.date ?? 'a date not reported'}`;
  if (e.type === 'after_sale') {
    return `valid ${e.length ?? '?'} ${e.unit ?? 'period'}${e.length === 1 ? '' : 's'} after sale`;
  }
  return 'expiry not reported';
}

function typeLine(t: GiftCardType): string {
  return (
    `- Gift card type ${t.id}${t.chain_id ? ` (chain ${t.chain_id})` : ''}: value ${t.value ?? 'not reported'}` +
    (t.usage
      ? ` · ${USAGE_TEXT[t.usage]}${t.service_ids?.length ? ` (services ${t.service_ids.join(', ')})` : ''}`
      : '') +
    ` · ${t.multiple_use === false ? 'single use' : 'multiple use'}` +
    ` · ${expiryText(t)}` +
    (t.sold_count !== null ? ` · ${t.sold_count} sold` : '') +
    (t.archived ? ' · archived' : '')
  );
}

function typeUntrusted(t: GiftCardType): UntrustedField[] {
  const key = `gift card type ${t.id}`;
  return [
    { label: `${key} title`, value: t.title },
    ...(t.online_sale_title !== t.title
      ? [{ label: `${key} online sale title`, value: t.online_sale_title }]
      : []),
    {
      label: `${key} online sale description`,
      value: t.online_sale_description,
    },
  ];
}

function typeResult(
  verb: string,
  t: GiftCardType,
  notes: string[] = [],
  isError = false
): GiftCardsResult {
  return {
    text: withUntrustedBlock(
      [`${verb} ${typeLine(t).replace(/^- /, '')}`, ...notes].join('\n'),
      typeUntrusted(t),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: t,
    ...(isError ? { isError: true } : {}),
  };
}

function typePage(
  head: string,
  input: PageInput,
  items: GiftCardType[],
  total: number | null,
  extra: Record<string, unknown>,
  notes: string[]
): GiftCardsResult {
  return renderPage({
    input,
    items,
    ...(total !== null ? { total } : {}),
    render: ({ items: shown, pagination }) => ({
      text: withUntrustedBlock(
        [
          `${head}; page ${input.page} shows ${shown.length}${shown.length > 0 ? ':' : '.'}`,
          ...shown.map(typeLine),
          ...(pagination.has_more
            ? [`More follow: request page ${pagination.next_page}.`]
            : []),
          ...notes,
        ].join('\n'),
        shown.flatMap(typeUntrusted),
        { maxChars: FIELD_MAX_CHARS }
      ),
      structuredContent: { ...extra, items: shown, pagination },
    }),
  });
}

// ========== types: reads ==========

export async function listChainTypes(
  client: AltegioClient,
  input: { chain_id: number; query?: string } & PageInput
): Promise<GiftCardsResult> {
  const page = await api(client).listChainTypes(input.chain_id, {
    ...(input.query ? { title: input.query } : {}),
    page: input.page,
    page_size: input.page_size,
  });
  return typePage(
    `${page.total ?? page.items.length} gift card type(s) in chain ${input.chain_id}${input.query ? ' matching the title' : ''}`,
    input,
    page.items,
    page.total,
    { chain_id: input.chain_id },
    [
      'Locations, services and online sale of one: gift_cards_get_type. A client’s sold gift cards: gift_cards_list_for_client.',
    ]
  );
}

export async function listLocationTypes(
  client: AltegioClient,
  input: { location_id: number; query?: string } & PageInput
): Promise<GiftCardsResult> {
  const page = await api(client).listLocationTypes(input.location_id, {
    ...(input.query ? { title: input.query } : {}),
    page: input.page,
    page_size: input.page_size,
  });
  return typePage(
    `${page.total ?? page.items.length} gift card type(s) sold at location ${input.location_id}${input.query ? ' matching the title' : ''}`,
    input,
    page.items,
    page.total,
    { location_id: input.location_id },
    [
      'This location read reports neither the selling locations nor the sold count; gift_cards_get_type with the type’s chain_id does.',
    ]
  );
}

export async function getType(
  client: AltegioClient,
  input: { chain_id: number; type_id: number }
): Promise<GiftCardsResult> {
  const t = await api(client).getType(input.chain_id, input.type_id);
  return typeResult('Read', t, [
    `Sold at locations: ${t.location_ids === null ? 'not reported' : t.location_ids.join(', ') || 'none'}. Staff ${t.balance_editable === true ? 'may' : t.balance_editable === false ? 'may not' : 'may or may not (not reported)'} correct a sold card’s balance; ${t.sold_without_number ? 'it may be sold without a number' : 'each card needs a number'}; online sale ${t.online_sale_enabled ? `on at ${t.online_sale_price ?? '?'}` : 'off'}.`,
  ]);
}

// ========== types: writes ==========

export interface ExpiryInput {
  type: 'never' | 'fixed_date' | 'after_sale';
  date?: string;
  length?: number;
  unit?: PeriodUnit;
}

export interface TypeFieldsInput {
  title?: string;
  value?: number;
  location_ids?: number[];
  multiple_use?: boolean;
  usage?: GiftCardUsage;
  service_ids?: number[];
  expiry?: ExpiryInput;
  balance_editable?: boolean;
  sold_without_number?: boolean;
  online_sale_enabled?: boolean;
  online_sale_title?: string;
  online_sale_price?: number;
  online_sale_description?: string;
  type_category_id?: number | null;
}

interface TypeDraft {
  title: string;
  value: number;
  location_ids: number[];
  multiple_use: boolean;
  usage: GiftCardUsage;
  service_ids: number[];
  expiry: ExpiryInput;
  balance_editable: boolean;
  sold_without_number: boolean;
  online_sale_enabled: boolean;
  online_sale_title: string;
  online_sale_price: number;
  online_sale_description: string;
  type_category_id: number | null;
}

const FIELD_KEYS = [
  'title',
  'value',
  'location_ids',
  'multiple_use',
  'usage',
  'service_ids',
  'expiry',
  'balance_editable',
  'sold_without_number',
  'online_sale_enabled',
  'online_sale_title',
  'online_sale_price',
  'online_sale_description',
  'type_category_id',
] as const satisfies readonly (keyof TypeFieldsInput)[];

function passedFields(input: TypeFieldsInput): TypeFieldsInput {
  const out: Record<string, unknown> = {};
  for (const key of FIELD_KEYS) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out as TypeFieldsInput;
}

function draftFromType(t: GiftCardType): TypeDraft {
  const e = t.expiry;
  return {
    title: t.title ?? '',
    value: t.value ?? 0,
    location_ids: t.location_ids ?? [],
    multiple_use: t.multiple_use ?? true,
    usage: t.usage ?? 'services_and_products',
    service_ids: t.service_ids ?? [],
    expiry:
      e.type === 'fixed_date' && e.date
        ? { type: 'fixed_date', date: e.date }
        : e.type === 'after_sale' && e.length && e.unit
          ? { type: 'after_sale', length: e.length, unit: e.unit }
          : { type: 'never' },
    balance_editable: t.balance_editable ?? false,
    sold_without_number: t.sold_without_number ?? false,
    online_sale_enabled: t.online_sale_enabled ?? false,
    online_sale_title: t.online_sale_title ?? t.title ?? '',
    online_sale_price: t.online_sale_price ?? 0,
    online_sale_description: t.online_sale_description ?? '',
    type_category_id: t.type_category_id,
  };
}

function checkDraft(d: TypeDraft): void {
  if (!d.title.trim()) {
    throw new GiftCardsInputError('A gift card type needs a title.');
  }
  if (d.location_ids.length === 0) {
    throw new GiftCardsInputError(
      'A gift card type needs at least one selling location of the chain (location_ids).'
    );
  }
  const listed =
    d.usage === 'listed_services' || d.usage === 'listed_services_and_products';
  if (listed && d.service_ids.length === 0) {
    throw new GiftCardsInputError(
      `Usage ${d.usage} pays for listed services only: pass service_ids (services_list), or choose another usage.`
    );
  }
  if (!listed && d.service_ids.length > 0) {
    throw new GiftCardsInputError(
      `service_ids apply only to usage listed_services or listed_services_and_products, not ${d.usage}.`
    );
  }
  const e = d.expiry;
  if (e.type === 'fixed_date' && !e.date) {
    throw new GiftCardsInputError(
      'A fixed_date expiry needs expiry.date (YYYY-MM-DD).'
    );
  }
  if (e.type === 'after_sale' && (!e.length || !e.unit)) {
    throw new GiftCardsInputError(
      'An after_sale expiry needs expiry.length and expiry.unit, e.g. { type: "after_sale", length: 6, unit: "month" }.'
    );
  }
  if (d.online_sale_enabled && d.online_sale_price <= 0) {
    throw new GiftCardsInputError(
      'Online sale needs an online_sale_price above zero.'
    );
  }
}

async function typeWrite(
  client: AltegioClient,
  d: TypeDraft,
  changed: TypeFieldsInput
): Promise<GiftCardTypeFields> {
  const given = (['value', 'online_sale_price'] as const).filter(
    (key) => changed[key] !== undefined && decimalsOf(d[key]) > 0
  );
  const locationId = d.location_ids[0];
  const currency =
    given.length > 0 && locationId !== undefined
      ? await resolveLocationCurrency(client, locationId).catch(() => null)
      : null;
  // The API validates the online-sale texts and price even with online sale
  // off (non-empty title and description, price above zero, checked live
  // 2026-11-06), so dormant ones default to the type's title and value.
  const onlinePrice = d.online_sale_price > 0 ? d.online_sale_price : d.value;
  const money = (key: 'value' | 'online_sale_price'): Money => {
    if (changed[key] === undefined) {
      return moneyOf(key === 'value' ? d.value : onlinePrice, currency);
    }
    try {
      return moneyInput(d[key], currency, key);
    } catch (error) {
      if (error instanceof MoneyInputError) {
        throw new GiftCardsInputError(error.message);
      }
      throw error;
    }
  };
  const e = d.expiry;
  return {
    expiry:
      e.type === 'fixed_date'
        ? // The API takes a plain YYYY-MM-DD here (a datetime is refused).
          { type: 'fixed_date', date: e.date!.slice(0, 10) }
        : e.type === 'after_sale'
          ? { type: 'after_sale', length: e.length!, unit: e.unit! }
          : { type: 'never' },
    title: d.title.trim(),
    value: money('value'),
    multiple_use: d.multiple_use,
    usage: d.usage,
    service_ids: d.service_ids,
    type_category_id: d.type_category_id,
    location_ids: d.location_ids,
    balance_editable: d.balance_editable,
    sold_without_number: d.sold_without_number,
    online_sale_enabled: d.online_sale_enabled,
    online_sale_title: d.online_sale_title.trim() || d.title.trim(),
    online_sale_price: money('online_sale_price'),
    online_sale_description:
      d.online_sale_description.trim() ||
      d.online_sale_title.trim() ||
      d.title.trim(),
  };
}

/** The fields the caller asked for that did not come back stored. */
function notApplied(
  wanted: GiftCardTypeFields,
  changed: TypeFieldsInput,
  saved: GiftCardType
): string[] {
  const missed: string[] = [];
  const check = (key: keyof TypeFieldsInput, ok: boolean) => {
    if (changed[key] !== undefined && !ok) missed.push(key);
  };
  const sameSet = (a: readonly number[], b: readonly number[] | null) =>
    b !== null &&
    a.length === b.length &&
    [...a]
      .sort((x, y) => x - y)
      .every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
  check('title', saved.title === wanted.title);
  check(
    'value',
    saved.value !== null && sameMajor(saved.value, majorOf(wanted.value))
  );
  check('multiple_use', saved.multiple_use === wanted.multiple_use);
  check('usage', saved.usage === wanted.usage);
  check('service_ids', sameSet(wanted.service_ids, saved.service_ids));
  check(
    'location_ids',
    saved.location_ids === null ||
      sameSet(wanted.location_ids, saved.location_ids)
  );
  check('expiry', saved.expiry.type === wanted.expiry.type);
  return missed;
}

export async function createType(
  client: AltegioClient,
  input: TypeFieldsInput & {
    chain_id: number;
    title: string;
    value: number;
    location_ids: number[];
  }
): Promise<GiftCardsResult> {
  const changed = passedFields(input);
  const draft: TypeDraft = {
    title: input.title,
    value: input.value,
    location_ids: input.location_ids,
    multiple_use: input.multiple_use ?? true,
    usage: input.usage ?? 'services_and_products',
    service_ids: input.service_ids ?? [],
    expiry: input.expiry ?? { type: 'never' },
    balance_editable: input.balance_editable ?? false,
    sold_without_number: input.sold_without_number ?? false,
    online_sale_enabled: input.online_sale_enabled ?? false,
    online_sale_title: input.online_sale_title ?? '',
    online_sale_price: input.online_sale_price ?? 0,
    online_sale_description: input.online_sale_description ?? '',
    type_category_id: input.type_category_id ?? null,
  };
  checkDraft(draft);
  // The path names the chain; the selling locations travel in the body and
  // must stay inside the consent too.
  assertCompaniesAllowed(draft.location_ids);
  const fields = await typeWrite(client, draft, changed);
  const saved = await api(client).createType(input.chain_id, fields);
  const missed = notApplied(fields, changed, saved);
  if (missed.length > 0) {
    return typeResult(
      'Created, but not as requested:',
      saved,
      [
        `The API did not store ${missed.join(', ')}. Check the ids (locations and services must belong to the chain), then fix the type with gift_cards_update_type or delete it with gift_cards_delete_type.`,
      ],
      true
    );
  }
  return typeResult('Created', saved, [
    'Gift cards of this type can now be sold at its locations. Once one is sold, the type cannot be changed or deleted.',
  ]);
}

export async function updateType(
  client: AltegioClient,
  input: TypeFieldsInput & { chain_id: number; type_id: number }
): Promise<GiftCardsResult> {
  const changed = passedFields(input);
  if (Object.keys(changed).length === 0) {
    throw new GiftCardsInputError(
      'Nothing to update: pass at least one field of the gift card type to change.'
    );
  }
  if (changed.location_ids !== undefined) {
    assertCompaniesAllowed(changed.location_ids);
  }
  const port = api(client);
  const current = await port.getType(input.chain_id, input.type_id);
  if ((current.sold_count ?? 0) > 0) {
    throw new GiftCardsInputError(
      `Gift card type ${input.type_id} has ${current.sold_count} sold gift card(s), and a type with sold cards cannot be changed. Create a new type with gift_cards_create_type instead.`
    );
  }
  const draft: TypeDraft = { ...draftFromType(current) };
  for (const key of FIELD_KEYS) {
    if (changed[key] !== undefined) {
      (draft as unknown as Record<string, unknown>)[key] = changed[key];
    }
  }
  // Usage that lists no services drops the old list unless one was passed.
  if (
    changed.usage !== undefined &&
    changed.service_ids === undefined &&
    draft.usage !== 'listed_services' &&
    draft.usage !== 'listed_services_and_products'
  ) {
    draft.service_ids = [];
  }
  checkDraft(draft);
  const fields = await typeWrite(client, draft, changed);
  const saved = await port.updateType(input.chain_id, input.type_id, fields);
  const missed = notApplied(fields, changed, saved);
  if (missed.length > 0) {
    return typeResult(
      'Updated only in part:',
      saved,
      [
        `The API kept the current ${missed.join(', ')}. Check the ids (locations and services must belong to the chain) and read the type with gift_cards_get_type.`,
      ],
      true
    );
  }
  return typeResult('Updated', saved);
}

export async function deleteType(
  client: AltegioClient,
  input: { chain_id: number; type_id: number }
): Promise<GiftCardsResult> {
  await api(client).deleteType(input.chain_id, input.type_id);
  return {
    text: `Deleted gift card type ${input.type_id} in chain ${input.chain_id}. It is no longer sold anywhere in the chain.`,
    structuredContent: {
      chain_id: input.chain_id,
      type_id: input.type_id,
      deleted: true,
    },
  };
}

/** A short, resolved description of a type for confirmation prompts. */
export async function describeType(
  client: AltegioClient,
  input: { chain_id: number; type_id: number }
): Promise<string> {
  const t = await api(client).getType(input.chain_id, input.type_id);
  return [
    `gift card type ${t.id}`,
    t.title ? `"${t.title}"` : null,
    t.value !== null ? `with value ${t.value}` : null,
    t.sold_count !== null ? `(${t.sold_count} sold)` : null,
    `in chain ${input.chain_id}`,
  ]
    .filter(Boolean)
    .join(' ');
}

// ========== a client's gift cards ==========

function giftCardLine(g: GiftCard): string {
  return (
    `- Gift card ${g.id}${g.number ? ` number ${g.number}` : ' (no number)'}: ${g.status.replace('_', ' ')}` +
    ` · balance ${g.balance ?? 'not reported'} of ${g.initial_balance ?? '?'}` +
    ` · type ${g.type_id ?? '?'}${g.chain_id ? ` (chain ${g.chain_id})` : ''}` +
    ` · expires ${g.expires_at ?? 'never or not reported'}`
  );
}

export async function listClientGiftCards(
  client: AltegioClient,
  input: { location_id: number; client_id: number } & PageInput
): Promise<GiftCardsResult> {
  const [all, currency] = await Promise.all([
    api(client).listClientGiftCards(input.location_id, input.client_id),
    resolveLocationCurrency(client, input.location_id).catch(() => null),
  ]);
  const { items, pagination } = paginateCollection(all, input);
  return {
    text: withUntrustedBlock(
      [
        `${pagination.total} gift card(s) of client ${input.client_id}, looked up in location ${input.location_id}; page ${input.page} shows ${items.length}${items.length > 0 ? ':' : '.'}`,
        ...items.map(giftCardLine),
        ...(pagination.has_more
          ? [`More follow: request page ${pagination.next_page}.`]
          : []),
        `Gift cards are found by the phone on the client card; one sold under an earlier phone is missed.${currency ? ` Balances are in ${currency}.` : ''}`,
      ].join('\n'),
      items.map((g) => ({
        label: `gift card ${g.id} type title`,
        value: g.type_title,
      })),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: {
      location_id: input.location_id,
      client_id: input.client_id,
      currency,
      items,
      pagination,
    },
  };
}
