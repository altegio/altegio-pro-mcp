/**
 * Inventory use cases — everything the `inventory_*`, `products_search` and
 * `suppliers_list` tools do.
 *
 * A use case takes the tool's parsed input plus an `AltegioClient`, calls the
 * `InventoryApi` / `ProductsApi` ports and returns the text summary next to
 * the structured content. Money carries the location's ISO currency code; a
 * quantity carries its unit. Titles and comments are other people's text and
 * go into the untrusted block only (see `./shared.ts`).
 *
 * The confirmation token of a write is valid for its arguments for ten
 * minutes and is not single use, so recording an operation first checks that
 * no identical one was just recorded (`findRepeat`): a repeated call would
 * otherwise move the stock twice. Each write hands the port the confirmed
 * call's idempotency key (`../../api/write-options.ts`).
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import type {
  BillOfMaterials,
  Inventory,
  InventoryDocument,
  InventoryMovement,
  InventoryOperationKind,
  OperationLineWrite,
  OperationWrite,
  Product,
  ProductStock,
  ProductUnit,
  ProductWithStock,
} from '../../api/inventory-api.js';
import {
  pageMetadata,
  paginateCollection,
  renderPage,
  type PageInput,
} from '../../tools/pagination.js';
import {
  withUntrustedBlock,
  type UntrustedField,
} from '../../tools/tool-result.js';
import { writeOptions } from '../../api/write-options.js';
import { instantOfWallTime, wallTime } from '../../api/v1/server-time.js';
import { knownLocationTimezone } from '../analytics/location-timezone.js';
import {
  ConfirmationRefusal,
  type ConfirmedCall,
} from '../../tools/confirmation.js';
import { InventoryInputError, InventoryNotFoundError } from './errors.js';
import {
  FIELD_MAX_CHARS,
  defaultInventory,
  inventoryApi,
  knownInventory,
  locationCurrency,
  mapWithConcurrency,
  money,
  productsApi,
  quantity,
  resolveProduct,
  round2,
  type InventoryResult,
  type ProductRef,
} from './shared.js';

// ========== inventories ==========

function inventoryRoles(i: Inventory): string {
  const roles = [
    i.for_sale ? 'default for product sales' : null,
    i.for_consumables
      ? 'consumables of services are written off from it'
      : null,
  ].filter(Boolean);
  return roles.length ? roles.join('; ') : 'no default role';
}

function inventoryUntrusted(items: readonly Inventory[]): UntrustedField[] {
  return items.flatMap((i) => [
    { label: `inventory ${i.id} title`, value: i.title },
    { label: `inventory ${i.id} comment`, value: i.comment },
  ]);
}

export async function listInventories(
  client: AltegioClient,
  input: { location_id: number } & PageInput
): Promise<InventoryResult> {
  const all = await inventoryApi(client).listInventories(input.location_id);
  const { items, pagination } = paginateCollection(all, input);
  const lines = [
    `${all.length} inventory(ies) at location ${input.location_id}; page ${pagination.page} shows ${items.length}:`,
    ...items.map((i) => `- ${i.id}: ${inventoryRoles(i)}`),
  ];
  if (pagination.has_more)
    lines.push(
      `More follow: request page ${pagination.next_page} with page_size ${pagination.page_size}.`
    );
  return {
    text: withUntrustedBlock(lines.join('\n'), inventoryUntrusted(items), {
      maxChars: FIELD_MAX_CHARS,
    }),
    structuredContent: { location_id: input.location_id, items, pagination },
  };
}

// ========== products ==========

interface UnitRef {
  id: number | null;
  name: string | null;
}

export interface ProductRow {
  id: number;
  title: string | null;
  category_id: number | null;
  sale_price: number | null;
  cost_price: number | null;
  currency: string | null;
  sale_unit: UnitRef;
  consumable_unit: UnitRef;
  consumable_units_per_sale_unit: number | null;
  loyalty_kind: Product['loyalty_kind'];
  chain_product: boolean;
  stock: (ProductStock & { inventory_title: string | null })[] | null;
  stock_total: { sale_quantity: number; consumable_quantity: number } | null;
}

function unitRef(
  units: Map<number, ProductUnit>,
  unitId: number | null
): UnitRef {
  const unit = unitId === null ? undefined : units.get(unitId);
  return { id: unitId, name: unit?.short_title ?? unit?.title ?? null };
}

function productRow(
  p: ProductWithStock,
  units: Map<number, ProductUnit>,
  inventories: Map<number, Inventory>,
  currency: string | null
): ProductRow {
  const stock =
    p.stock?.map((s) => ({
      ...s,
      inventory_title: inventories.get(s.inventory_id)?.title ?? null,
    })) ?? null;
  return {
    id: p.id,
    title: p.title,
    category_id: p.category_id,
    sale_price: p.sale_price,
    cost_price: p.cost_price,
    currency,
    sale_unit: unitRef(units, p.sale_unit_id),
    consumable_unit: unitRef(units, p.consumable_unit_id),
    consumable_units_per_sale_unit: p.consumable_units_per_sale_unit,
    loyalty_kind: p.loyalty_kind,
    chain_product: p.chain_product,
    stock,
    stock_total: stock
      ? {
          sale_quantity: round2(
            stock.reduce((sum, s) => sum + (s.sale_quantity ?? 0), 0)
          ),
          consumable_quantity: round2(
            stock.reduce((sum, s) => sum + (s.consumable_quantity ?? 0), 0)
          ),
        }
      : null,
  };
}

function productLine(row: ProductRow): string {
  const parts = [
    `sale price ${money(row.sale_price, row.currency)} per ${quantity(1, row.sale_unit.name).replace(/^1 /, '')}`,
    `cost price ${row.cost_price === null ? 'not visible' : money(row.cost_price, row.currency)}`,
  ];
  if (
    row.consumable_unit.id !== null &&
    row.consumable_unit.id !== row.sale_unit.id &&
    row.consumable_units_per_sale_unit !== null
  ) {
    parts.push(
      `1 ${quantity(1, row.sale_unit.name).replace(/^1 /, '')} = ${quantity(row.consumable_units_per_sale_unit, row.consumable_unit.name)}`
    );
  }
  if (row.stock_total) {
    const held = (row.stock ?? []).filter(
      (s) => (s.sale_quantity ?? 0) !== 0 || (s.consumable_quantity ?? 0) !== 0
    );
    parts.push(
      `stock ${quantity(row.stock_total.sale_quantity, row.sale_unit.name)} in all` +
        (held.length
          ? ` (${held
              .map(
                (s) =>
                  `inventory ${s.inventory_id}: ${quantity(s.sale_quantity, row.sale_unit.name)}`
              )
              .join(', ')})`
          : '')
    );
  }
  if (row.loyalty_kind)
    parts.push(
      `sells a ${row.loyalty_kind === 'membership' ? 'membership' : 'gift card'}`
    );
  return `- ${row.id}: ${parts.join(' · ')}`;
}

function productUntrusted(rows: readonly ProductRow[]): UntrustedField[] {
  const inventoryTitles = new Map<number, string | null>();
  for (const row of rows)
    for (const s of row.stock ?? [])
      inventoryTitles.set(s.inventory_id, s.inventory_title);
  return [
    ...rows.map((row) => ({
      label: `product ${row.id} title`,
      value: row.title,
    })),
    ...[...inventoryTitles].map(([inventoryId, title]) => ({
      label: `inventory ${inventoryId} title`,
      value: title,
    })),
  ];
}

/** The stock reads of one page: one product read per product, eight at a time. */
const PRODUCT_READ_CONCURRENCY = 8;

export async function searchProducts(
  client: AltegioClient,
  input: {
    location_id: number;
    query?: string;
    product_ids?: number[];
    include_stock: boolean;
  } & PageInput
): Promise<InventoryResult> {
  const products = productsApi(client);
  const query = input.query?.trim();
  if (query !== undefined && query !== '' && input.product_ids?.length) {
    throw new InventoryInputError(
      'Pass either query or product_ids, not both.'
    );
  }
  if (query !== undefined && query.length > 0 && query.length < 2) {
    throw new InventoryInputError(
      'query needs at least two characters of a product name, article number or barcode.'
    );
  }
  const page = { page: input.page, page_size: input.page_size };
  const found = query
    ? await products.searchProducts(input.location_id, query, page)
    : await products.listProducts(input.location_id, {
        ...page,
        ...(input.product_ids?.length
          ? { product_ids: input.product_ids }
          : {}),
      });

  const [units, inventories, currency, detailed] = await Promise.all([
    products.listUnits(input.location_id).catch(() => [] as ProductUnit[]),
    input.include_stock
      ? inventoryApi(client)
          .listInventories(input.location_id)
          .catch(() => [] as Inventory[])
      : Promise.resolve([] as Inventory[]),
    locationCurrency(client, input.location_id),
    input.include_stock
      ? mapWithConcurrency(found, PRODUCT_READ_CONCURRENCY, (p) =>
          products.getProduct(input.location_id, p.id, { stock: true })
        )
      : Promise.resolve(found.map((p) => ({ ...p, stock: null }))),
  ]);
  const unitMap = new Map(units.map((u) => [u.id, u]));
  const inventoryMap = new Map(inventories.map((i) => [i.id, i]));
  const rows = detailed.map((p) =>
    productRow(p, unitMap, inventoryMap, currency)
  );

  return renderPage({
    input,
    items: rows,
    render: ({ items, pagination }) => {
      const what = query
        ? 'product(s) matching the query'
        : input.product_ids?.length
          ? 'of the requested product(s)'
          : 'product(s)';
      const lines = [
        `Page ${pagination.page} of ${what} at location ${input.location_id} shows ${items.length}${input.include_stock ? ', with stock per inventory' : ''}:`,
        ...items.map(productLine),
      ];
      if (items.length === 0) lines.push('No products match.');
      if (pagination.has_more)
        lines.push(
          `More may follow: request page ${pagination.next_page} with page_size ${pagination.page_size}.`
        );
      return {
        text: withUntrustedBlock(lines.join('\n'), productUntrusted(items), {
          maxChars: FIELD_MAX_CHARS,
        }),
        structuredContent: {
          location_id: input.location_id,
          currency,
          items,
          pagination,
        },
      };
    },
  });
}

// ========== inventory operations: reads ==========

const KIND_LABEL: Record<InventoryMovement['kind'], string> = {
  sale: 'product sale',
  consumption: 'consumption',
  receipt: 'product receipt',
  write_off: 'write-off',
  transfer: 'transfer between inventories',
  other: 'operation of another kind',
};

export interface MovementRow extends InventoryMovement {
  currency: string | null;
}

function movementLine(m: MovementRow): string {
  const sign = m.direction === 'out' ? '−' : m.direction === 'in' ? '+' : '';
  const parts = [
    `${m.id}: ${KIND_LABEL[m.kind]}`,
    m.date ?? 'date not reported',
    `product ${m.product_id ?? '?'} ${sign}${quantity(m.quantity, m.unit)}`,
    `inventory ${m.inventory_id ?? '?'}`,
    `total ${money(m.total, m.currency)}`,
  ];
  if (m.unit_price !== null)
    parts.push(`unit price ${money(m.unit_price, m.currency)}`);
  if (m.discount_percent) parts.push(`discount ${m.discount_percent}%`);
  if (m.appointment_id) parts.push(`appointment ${m.appointment_id}`);
  if (m.team_member_id) parts.push(`team member ${m.team_member_id}`);
  if (m.client_id) parts.push(`client ${m.client_id}`);
  if (m.supplier_id) parts.push(`supplier ${m.supplier_id}`);
  return `  - ${parts.join(' · ')}`;
}

function movementUntrusted(
  rows: readonly InventoryMovement[]
): UntrustedField[] {
  const seen = new Set<string>();
  const fields: UntrustedField[] = [];
  const once = (label: string, value: string | null) => {
    if (seen.has(label)) return;
    seen.add(label);
    fields.push({ label, value });
  };
  for (const m of rows) {
    if (m.product_id) once(`product ${m.product_id} title`, m.product_title);
    if (m.inventory_id)
      once(`inventory ${m.inventory_id} title`, m.inventory_title);
    once(`line ${m.id} comment`, m.comment);
  }
  return fields;
}

/** Lines grouped by their document, in the order the page lists them. */
function groupedLines(rows: readonly MovementRow[]): string[] {
  const groups = new Map<string, MovementRow[]>();
  for (const row of rows) {
    const key = row.document_id === null ? 'none' : String(row.document_id);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].flatMap(([key, group]) => [
    key === 'none' ? '- no document:' : `- document ${key}:`,
    ...group.map(movementLine),
  ]);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function listOperations(
  client: AltegioClient,
  input: {
    location_id: number;
    date_from?: string;
    date_to?: string;
    document_id?: number;
  } & PageInput
): Promise<InventoryResult> {
  for (const [name, value] of [
    ['date_from', input.date_from],
    ['date_to', input.date_to],
  ] as const) {
    if (value !== undefined && !DATE.test(value))
      throw new InventoryInputError(`${name} must be YYYY-MM-DD.`);
  }
  if (input.date_from && input.date_to && input.date_from > input.date_to)
    throw new InventoryInputError('date_from must not be after date_to.');
  const [movements, currency] = await Promise.all([
    inventoryApi(client).listMovements(input.location_id, {
      date_from: input.date_from,
      date_to: input.date_to,
      document_id: input.document_id,
      page: input.page,
      page_size: input.page_size,
    }),
    locationCurrency(client, input.location_id),
  ]);
  const rows: MovementRow[] = movements.map((m) => ({ ...m, currency }));
  return renderPage({
    input,
    items: rows,
    render: ({ items, pagination }) => {
      const scope = input.document_id
        ? `of document ${input.document_id}`
        : input.date_from || input.date_to
          ? `from ${input.date_from ?? 'the start'} to ${input.date_to ?? 'today'}`
          : 'newest first';
      const lines = [
        `Inventory operation lines at location ${input.location_id} ${scope}; page ${pagination.page} shows ${items.length} (− lowers stock, + raises it):`,
        ...groupedLines(items),
      ];
      if (items.length === 0) lines.push('No lines match.');
      if (pagination.has_more)
        lines.push(
          `More may follow: request page ${pagination.next_page} with page_size ${pagination.page_size}.`
        );
      return {
        text: withUntrustedBlock(lines.join('\n'), movementUntrusted(items), {
          maxChars: FIELD_MAX_CHARS,
        }),
        structuredContent: {
          location_id: input.location_id,
          currency,
          items,
          pagination,
        },
      };
    },
  });
}

// ========== inventory operations: create ==========

export interface OperationLineInput extends ProductRef {
  quantity: number;
  unit?: 'sale' | 'consumable';
  unit_price?: number;
  discount_percent?: number;
}

export interface CreateOperationInput {
  location_id: number;
  kind: InventoryOperationKind;
  team_member_id: number;
  lines: OperationLineInput[];
  inventory_id?: number;
  client_id?: number;
  supplier_id?: number;
  date?: string;
  comment?: string;
}

interface PlannedLine extends OperationLineWrite {
  product: Product;
  unit_kind: 'sale' | 'consumable';
  unit_name: string | null;
  price_source: 'given' | 'sale_price' | 'cost_price';
}

interface OperationPlan {
  inventory: Inventory;
  currency: string | null;
  lines: PlannedLine[];
  write: OperationWrite;
}

const LOCAL_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/;

/** `2026-10-19T14:05` → `2026-10-19 14:05:00`, the only format the API reads. */
function wireDate(value: string): string {
  const match = LOCAL_DATETIME.exec(value);
  if (!match) {
    throw new InventoryInputError(
      'date must be the time at the location as YYYY-MM-DDTHH:MM (seconds optional), with no offset.'
    );
  }
  return `${match[1]} ${match[2]}${match[3] ?? ':00'}`;
}

/** Where a kind takes stock from by default. */
const DEFAULT_PURPOSE: Record<
  InventoryOperationKind,
  'sale' | 'consumables' | null
> = {
  sale: 'sale',
  receipt: null,
  write_off: null,
};

/**
 * Resolve products, units, prices and the inventory, and compute every line
 * total, without writing. The confirmation detail and the handler both run it,
 * so what a person approves is computed exactly the way the call will be.
 */
async function planOperation(
  client: AltegioClient,
  input: CreateOperationInput
): Promise<OperationPlan> {
  if (input.client_id !== undefined && input.kind !== 'sale')
    throw new InventoryInputError('client_id belongs to a product sale only.');
  if (input.supplier_id !== undefined && input.kind !== 'receipt')
    throw new InventoryInputError(
      'supplier_id belongs to a product receipt only.'
    );
  const date = input.date === undefined ? undefined : wireDate(input.date);
  const products = productsApi(client);
  const [inventories, currency] = await Promise.all([
    inventoryApi(client).listInventories(input.location_id),
    locationCurrency(client, input.location_id),
  ]);
  const inventory =
    input.inventory_id === undefined
      ? defaultInventory(
          inventories,
          DEFAULT_PURPOSE[input.kind],
          'This operation'
        )
      : knownInventory(inventories, input.inventory_id, input.location_id);
  const [units, resolved] = await Promise.all([
    products.listUnits(input.location_id).catch(() => [] as ProductUnit[]),
    mapWithConcurrency(
      input.lines.map((line, index) => ({ line, index })),
      PRODUCT_READ_CONCURRENCY,
      ({ line, index }) =>
        resolveProduct(products, input.location_id, line, `lines[${index}]`)
    ),
  ]);
  const unitNames = new Map(units.map((u) => [u.id, u.short_title ?? u.title]));

  const lines = input.lines.map((line, index): PlannedLine => {
    const product = resolved[index]!;
    const where = `lines[${index}] (product ${product.id})`;
    if (product.loyalty_kind) {
      throw new InventoryInputError(
        `${where} sells a ${product.loyalty_kind === 'membership' ? 'membership' : 'gift card'}; record that sale on the client's visit in Altegio, not as an inventory operation.`
      );
    }
    const unitKind = line.unit ?? 'sale';
    const unitId =
      unitKind === 'sale' ? product.sale_unit_id : product.consumable_unit_id;
    if (unitId === null)
      throw new InventoryInputError(
        `${where} reports no ${unitKind} unit; use the other unit.`
      );
    const ratio = product.consumable_units_per_sale_unit ?? 1;
    const perUnit = (perSaleUnit: number | null) =>
      perSaleUnit === null
        ? null
        : unitKind === 'sale'
          ? perSaleUnit
          : perSaleUnit / (ratio || 1);
    const defaultSource = input.kind === 'sale' ? 'sale_price' : 'cost_price';
    const unitPrice =
      line.unit_price ??
      perUnit(
        defaultSource === 'sale_price' ? product.sale_price : product.cost_price
      );
    if (unitPrice === null) {
      throw new InventoryInputError(
        `${where} has no ${defaultSource === 'sale_price' ? 'sale price' : 'cost price visible to the user'}; pass unit_price.`
      );
    }
    const discount = line.discount_percent ?? 0;
    const roundedPrice = round2(unitPrice);
    return {
      product,
      product_id: product.id,
      quantity: line.quantity,
      unit_id: unitId,
      unit_kind: unitKind,
      unit_name: unitNames.get(unitId) ?? null,
      unit_price: roundedPrice,
      discount_percent: discount,
      total: round2(line.quantity * roundedPrice * (1 - discount / 100)),
      price_source: line.unit_price === undefined ? defaultSource : 'given',
    };
  });

  const seen = new Set<string>();
  for (const line of lines) {
    const key = `${line.product_id}:${line.unit_id}`;
    if (seen.has(key))
      throw new InventoryInputError(
        `Product ${line.product_id} appears twice in the same unit; put the whole quantity on one line.`
      );
    seen.add(key);
  }

  return {
    inventory,
    currency,
    lines,
    write: {
      kind: input.kind,
      inventory_id: inventory.id,
      team_member_id: input.team_member_id,
      ...(input.client_id ? { client_id: input.client_id } : {}),
      ...(input.supplier_id ? { supplier_id: input.supplier_id } : {}),
      ...(date ? { date_local: date } : {}),
      ...(input.comment ? { comment: input.comment } : {}),
      lines: lines.map((l) => ({
        product_id: l.product_id,
        quantity: l.quantity,
        unit_id: l.unit_id,
        unit_price: l.unit_price,
        discount_percent: l.discount_percent,
        total: l.total,
      })),
    },
  };
}

function plannedLineText(line: PlannedLine, currency: string | null): string {
  const source =
    line.price_source === 'given'
      ? ''
      : ` (${line.price_source === 'sale_price' ? 'sale price' : 'cost price'})`;
  return (
    `product ${line.product_id} ${line.product.title ?? ''}: ` +
    `${quantity(line.quantity, line.unit_name)} × ${money(line.unit_price, currency)}${source}` +
    (line.discount_percent ? ` − ${line.discount_percent}%` : '') +
    ` = ${money(line.total, currency)}`
  );
}

function stockEffect(kind: InventoryOperationKind): string {
  return kind === 'receipt' ? 'adds to' : 'takes from';
}

// ========== inventory operations: the repeat guard ==========

/** How recent an identical undated operation must be to count as a repeat. */
const REPEAT_WINDOW_MS = 10 * 60 * 1000;
/** Lines of the window's days the repeat check reads at most. */
const REPEAT_PAGE_SIZE = 100;
const REPEAT_PAGES_MAX = 5;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** One planned line, in the terms a recorded movement line reads back in. */
function lineKey(
  productId: number | null,
  quantity_: number | null,
  unitPrice: number | null,
  discount: number | null
): string {
  return [
    productId,
    quantity_ === null ? null : round3(quantity_),
    unitPrice === null ? null : round2(unitPrice),
    round2(discount ?? 0),
  ].join(':');
}

/** Widest a location's clock can be from UTC, for when its zone is unknown. */
const MAX_ZONE_OFFSET_MS = 14 * 60 * 60 * 1000;

/**
 * Where a check for `now` has to look: the location days to read, and how
 * close to `now` a line's time must be. The list stores a line's date as the
 * location's wall time (and labels it with the server's offset, which is not
 * the location's), so only the wall time is read, placed in the location's
 * zone. When the zone is unknown, every day and every offset a location could
 * have is allowed: refusing a genuine call is cheap, a comment tells it apart.
 */
async function repeatWindow(
  client: AltegioClient,
  locationId: number,
  now: number
): Promise<{
  date_from: string;
  date_to: string;
  recent: (wall: string) => boolean;
}> {
  const zone = await knownLocationTimezone(client, locationId).catch(
    () => null
  );
  if (zone) {
    return {
      date_from: wallTime(now - REPEAT_WINDOW_MS, zone).slice(0, 10),
      date_to: wallTime(now, zone).slice(0, 10),
      recent: (wall) => {
        const at = instantOfWallTime(wall, zone);
        return at !== null && Math.abs(now - at) <= REPEAT_WINDOW_MS;
      },
    };
  }
  return {
    date_from: new Date(now - MAX_ZONE_OFFSET_MS).toISOString().slice(0, 10),
    date_to: new Date(now + MAX_ZONE_OFFSET_MS).toISOString().slice(0, 10),
    recent: (wall) => {
      const at = instantOfWallTime(wall, 'UTC');
      return (
        at !== null &&
        Math.abs(now - at) <= MAX_ZONE_OFFSET_MS + REPEAT_WINDOW_MS
      );
    },
  };
}

/**
 * A document already recorded with the same kind, inventory, lines (product,
 * quantity, unit price, discount), date and comment — and, where the lines
 * keep them, the same client (a sale) or Supplier (a receipt). That is the
 * trace a repeated confirmed call leaves. With a `date` the document must be
 * dated the same minute; without one, it must have been recorded within the
 * last ten minutes, the life of a confirmation token.
 */
async function findRepeat(
  client: AltegioClient,
  input: CreateOperationInput,
  plan: OperationPlan,
  now: number
): Promise<InventoryMovement[] | undefined> {
  const dated = plan.write.date_local;
  const window = dated
    ? undefined
    : await repeatWindow(client, input.location_id, now);
  const range = dated
    ? { date_from: dated.slice(0, 10), date_to: dated.slice(0, 10) }
    : { date_from: window!.date_from, date_to: window!.date_to };
  const sameTime = (m: InventoryMovement) => {
    // `YYYY-MM-DD HH:MM:SS`, the location's wall time; the offset is dropped.
    const wall = m.date?.slice(0, 19).replace('T', ' ');
    if (!wall) return false;
    return dated
      ? wall.slice(0, 16) === dated.slice(0, 16)
      : window!.recent(wall);
  };

  const documents = new Map<number, InventoryMovement[]>();
  const api = inventoryApi(client);
  for (let page = 1; page <= REPEAT_PAGES_MAX; page += 1) {
    const rows = await api.listMovements(input.location_id, {
      ...range,
      page,
      page_size: REPEAT_PAGE_SIZE,
    });
    for (const m of rows) {
      if (m.document_id === null) continue;
      documents.set(m.document_id, [
        ...(documents.get(m.document_id) ?? []),
        m,
      ]);
    }
    if (rows.length < REPEAT_PAGE_SIZE) break;
  }

  const comment = input.comment ?? '';
  const wanted = plan.lines
    .map((l) =>
      lineKey(l.product_id, l.quantity, l.unit_price, l.discount_percent)
    )
    .sort();
  for (const lines of documents.values()) {
    if (lines.length !== wanted.length) continue;
    const same = lines.every(
      (m) =>
        m.kind === input.kind &&
        m.inventory_id === plan.inventory.id &&
        (m.comment ?? '') === comment &&
        sameTime(m) &&
        (input.kind !== 'sale' || m.client_id === (input.client_id ?? null)) &&
        (input.kind !== 'receipt' ||
          m.supplier_id === (input.supplier_id ?? null))
    );
    if (!same) continue;
    const got = lines
      .map((m) =>
        lineKey(m.product_id, m.quantity, m.unit_price, m.discount_percent)
      )
      .sort();
    if (got.every((key, index) => key === wanted[index])) return lines;
  }
  return undefined;
}

function repeatRefusal(
  input: CreateOperationInput,
  lines: readonly InventoryMovement[]
): InventoryInputError {
  const first = lines[0]!;
  return new InventoryInputError(
    `Nothing was recorded: document ${first.document_id} — a ${KIND_LABEL[input.kind]} with the same inventory, lines, quantities, prices${input.date ? ', date' : ''} and comment — was already recorded (dated ${first.date ? `${first.date.slice(0, 16).replace('T', ' ')} location time` : 'not reported'}), so this looks like a repeat of the same call. If a second identical ${KIND_LABEL[input.kind]} is really meant, call again with a comment that tells the two apart; it needs a new confirmation.`
  );
}

/** The confirmation detail: inventory and every priced line, resolved. */
export async function describeOperation(
  client: AltegioClient,
  input: CreateOperationInput,
  now: number = Date.now()
): Promise<string> {
  let plan: OperationPlan;
  try {
    plan = await planOperation(client, input);
    const repeat = await findRepeat(client, input, plan, now);
    if (repeat) throw repeatRefusal(input, repeat);
  } catch (error) {
    if (error instanceof InventoryInputError)
      throw new ConfirmationRefusal(
        error.message.replace(/^Nothing was recorded: /, '')
      );
    throw error;
  }
  const sum = round2(plan.lines.reduce((s, l) => s + l.total, 0));
  return [
    `It ${stockEffect(input.kind)} inventory ${plan.inventory.id} ${plan.inventory.title ?? ''}:`,
    ...plan.lines.map((l) => `- ${plannedLineText(l, plan.currency)}`),
    `Document total ${money(sum, plan.currency)}.`,
  ].join('\n');
}

function documentLine(d: InventoryDocument): string {
  return (
    `document ${d.id}${d.number !== null && d.number !== d.id ? ` (number ${d.number})` : ''}: ` +
    `${KIND_LABEL[d.kind]} · inventory ${d.inventory_id ?? '?'} · ${d.date_local ?? 'date not reported'} (location time)`
  );
}

export async function createOperation(
  client: AltegioClient,
  input: CreateOperationInput,
  now: number = Date.now(),
  confirmation?: ConfirmedCall
): Promise<InventoryResult> {
  const plan = await planOperation(client, input);
  // A repeated call with the same confirmation token must not move stock twice.
  const repeat = await findRepeat(client, input, plan, now);
  if (repeat) throw repeatRefusal(input, repeat);
  const created = await inventoryApi(client).createOperation(
    input.location_id,
    plan.write,
    writeOptions(confirmation)
  );
  const lines: MovementRow[] = created.lines.map((m) => ({
    ...m,
    currency: plan.currency,
  }));
  const sum = round2(lines.reduce((s, l) => s + (l.total ?? 0), 0));
  const text = [
    `Recorded ${documentLine(created.document)} with ${lines.length} line(s), total ${money(sum, plan.currency)}:`,
    ...lines.map(movementLine),
    input.kind === 'sale' || input.kind === 'receipt'
      ? 'No payment was recorded with it. To undo the operation, delete the document with inventory_delete_document.'
      : 'To undo the operation, delete the document with inventory_delete_document.',
  ].join('\n');
  return {
    text: withUntrustedBlock(
      text,
      [
        {
          label: `document ${created.document.id} comment`,
          value: created.document.comment,
        },
        {
          label: `inventory ${plan.inventory.id} title`,
          value: plan.inventory.title,
        },
        ...movementUntrusted(lines).filter((f) => !f.label.endsWith('comment')),
      ],
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: {
      location_id: input.location_id,
      currency: plan.currency,
      document: created.document,
      lines,
      total: sum,
    },
  };
}

// ========== documents: delete ==========

/** The target label of the delete confirmation: kind, inventory, date. */
export async function describeDocument(
  client: AltegioClient,
  input: { location_id: number; document_id: number }
): Promise<string> {
  const d = await inventoryApi(client).getDocument(
    input.location_id,
    input.document_id
  );
  return `${documentLine(d)} at location ${input.location_id}`;
}

/** Most lines one document read lists; a document holds far fewer. */
const DOCUMENT_LINES_MAX = 100;

async function documentLines(
  client: AltegioClient,
  locationId: number,
  documentId: number
): Promise<InventoryMovement[]> {
  return inventoryApi(client).listMovements(locationId, {
    document_id: documentId,
    page: 1,
    page_size: DOCUMENT_LINES_MAX,
  });
}

/** The confirmation detail: what the document moved, which comes back. */
export async function describeDocumentLines(
  client: AltegioClient,
  input: { location_id: number; document_id: number }
): Promise<string> {
  try {
    await inventoryApi(client).getDocument(
      input.location_id,
      input.document_id
    );
  } catch (error) {
    if (error instanceof InventoryNotFoundError)
      throw new ConfirmationRefusal(error.message);
    throw error;
  }
  const [lines, currency] = await Promise.all([
    documentLines(client, input.location_id, input.document_id),
    locationCurrency(client, input.location_id),
  ]);
  if (lines.length === 0) return 'The document holds no product lines.';
  return [
    'Stock comes back as it was before these lines:',
    ...lines.map(
      (m) =>
        `- product ${m.product_id ?? '?'} ${m.product_title ?? ''}: ${m.direction === 'out' ? '−' : '+'}${quantity(m.quantity, m.unit)} in inventory ${m.inventory_id ?? '?'}, total ${money(m.total, currency)}`
    ),
  ].join('\n');
}

export async function deleteDocument(
  client: AltegioClient,
  input: { location_id: number; document_id: number },
  confirmation?: ConfirmedCall
): Promise<InventoryResult> {
  const api = inventoryApi(client);
  const document = await api.getDocument(input.location_id, input.document_id);
  const [lines, currency] = await Promise.all([
    documentLines(client, input.location_id, input.document_id),
    locationCurrency(client, input.location_id),
  ]);
  await api.deleteDocument(
    input.location_id,
    input.document_id,
    writeOptions(confirmation)
  );
  const rows: MovementRow[] = lines.map((m) => ({ ...m, currency }));
  return {
    text: withUntrustedBlock(
      [
        `Deleted ${documentLine(document)} and its ${rows.length} line(s); the stock they moved is reversed:`,
        ...rows.map(movementLine),
        'A payment recorded for the document, if any, was not deleted.',
      ].join('\n'),
      [
        { label: `document ${document.id} comment`, value: document.comment },
        ...movementUntrusted(rows),
      ],
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: {
      location_id: input.location_id,
      deleted: true,
      document,
      lines: rows,
      currency,
    },
  };
}

// ========== suppliers ==========

export async function listSuppliers(
  client: AltegioClient,
  input: { location_id: number; query?: string } & PageInput
): Promise<InventoryResult> {
  const all = await inventoryApi(client).listSuppliers(input.location_id);
  const needle = input.query?.trim().toLowerCase();
  const matching = needle
    ? all.filter((s) => s.title?.toLowerCase().includes(needle))
    : all;
  const { items, pagination } = paginateCollection(matching, input);
  const lines = [
    `${matching.length} Supplier(s) and Partner(s) at location ${input.location_id}${needle ? ' matching the query' : ''}; page ${pagination.page} shows ${items.length}:`,
    ...items.map((s) => `- ${s.id}: ${s.type.replace('_', ' ')}`),
  ];
  if (items.length === 0) lines.push('No Suppliers match.');
  if (pagination.has_more)
    lines.push(
      `More follow: request page ${pagination.next_page} with page_size ${pagination.page_size}.`
    );
  if (items.length > 0)
    lines.push(
      'Use an id as supplier_id in financial_transactions_create, _update or _list, or in a product receipt (inventory_create_operation).'
    );
  return {
    text: withUntrustedBlock(
      lines.join('\n'),
      items.map((s) => ({ label: `supplier ${s.id} title`, value: s.title })),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: { location_id: input.location_id, items, pagination },
  };
}

// ========== Bills of Materials ==========

function billLines(b: BillOfMaterials, currency: string | null): string[] {
  return [
    `- ${b.id}: ${b.lines.length} consumable(s) per service`,
    ...b.lines.map(
      (l) =>
        `  - product ${l.product_id}: ${quantity(l.quantity, l.unit)} from inventory ${l.inventory_id}, cost ${money(l.cost, currency)}`
    ),
  ];
}

function billUntrusted(bills: readonly BillOfMaterials[]): UntrustedField[] {
  const fields: UntrustedField[] = [];
  const products = new Set<number>();
  for (const b of bills) {
    fields.push({ label: `Bill of Materials ${b.id} title`, value: b.title });
    for (const l of b.lines) {
      if (products.has(l.product_id)) continue;
      products.add(l.product_id);
      fields.push({
        label: `product ${l.product_id} title`,
        value: l.product_title,
      });
    }
  }
  return fields;
}

export async function listBillsOfMaterials(
  client: AltegioClient,
  input: {
    location_id: number;
    query?: string;
    team_member_id?: number;
    service_id?: number;
  } & PageInput
): Promise<InventoryResult> {
  if ((input.team_member_id === undefined) !== (input.service_id === undefined))
    throw new InventoryInputError(
      'Pass team_member_id and service_id together to read the Bill of Materials one team member applies to one service.'
    );
  const api = inventoryApi(client);
  const currency = await locationCurrency(client, input.location_id);
  if (input.team_member_id !== undefined && input.service_id !== undefined) {
    const bill = await api.getTeamMemberServiceBillOfMaterials(
      input.location_id,
      input.team_member_id,
      input.service_id
    );
    const items = bill ? [bill] : [];
    const pagination = pageMetadata(
      { page: 1, page_size: 1 },
      items.length,
      items.length
    );
    return {
      text: withUntrustedBlock(
        [
          bill
            ? `Bill of Materials applied when team member ${input.team_member_id} provides service ${input.service_id} (quantities per one service, cost at cost price):`
            : `Team member ${input.team_member_id} has no Bill of Materials for service ${input.service_id}.`,
          ...(bill ? billLines(bill, currency) : []),
        ].join('\n'),
        billUntrusted(items),
        { maxChars: FIELD_MAX_CHARS }
      ),
      structuredContent: {
        location_id: input.location_id,
        currency,
        items,
        pagination,
      },
    };
  }
  const bills = await api.listBillsOfMaterials(input.location_id, {
    title: input.query?.trim() || undefined,
    page: input.page,
    page_size: input.page_size,
  });
  return renderPage({
    input,
    items: bills,
    render: ({ items, pagination }) => {
      const lines = [
        `Bills of Materials at location ${input.location_id}${input.query ? ' matching the query' : ''}; page ${pagination.page} shows ${items.length} (quantities per one service, cost at cost price):`,
        ...items.flatMap((b) => billLines(b, currency)),
      ];
      if (items.length === 0) lines.push('No Bills of Materials match.');
      if (pagination.has_more)
        lines.push(
          `More may follow: request page ${pagination.next_page} with page_size ${pagination.page_size}.`
        );
      return {
        text: withUntrustedBlock(lines.join('\n'), billUntrusted(items), {
          maxChars: FIELD_MAX_CHARS,
        }),
        structuredContent: {
          location_id: input.location_id,
          currency,
          items,
          pagination,
        },
      };
    },
  });
}
