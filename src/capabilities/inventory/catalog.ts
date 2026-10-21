/**
 * Product catalog use cases — what the `products_create`, `products_update`,
 * `products_archive` and `product_categories_*` tools do.
 *
 * A product card names the product, files it under a product category,
 * counts it in a sale unit (pcs, bottle) and a consumable unit (ml, g), and
 * prices it: the sale price a client pays and the cost price the location
 * pays. Titles, article numbers, barcodes and comments are other people's
 * text and go into the untrusted block only (see `./shared.ts`).
 *
 * Writes guard against repeats: the confirmation token is valid for ten
 * minutes and not single use, so a create first looks for a product or
 * category that already carries the same barcode, article number or title — a
 * repeated call finds the one it made — and a change re-reads the card and is
 * refused when it moved after the confirmation was shown.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { ProductCatalogAdapter } from '../../api/v1/product-catalog-adapter.js';
import type {
  Product,
  ProductCard,
  ProductCardWrite,
  ProductCatalogApi,
  ProductCategory,
  ProductUnit,
} from '../../api/inventory-api.js';
import { majorOf, moneyInput } from '../../api/money.js';
import { writeOptions } from '../../api/write-options.js';
import {
  ConfirmationRefusal,
  stateVersion,
  type ConfirmationDetail,
  type ConfirmedCall,
} from '../../tools/confirmation.js';
import { paginateCollection, type PageInput } from '../../tools/pagination.js';
import {
  withUntrustedBlock,
  type UntrustedField,
} from '../../tools/tool-result.js';
import { planConfirmed, planForConfirmation } from '../guarded-change.js';
import { InventoryInputError, InventoryNotFoundError } from './errors.js';
import {
  FIELD_MAX_CHARS,
  locationCurrency,
  mapWithConcurrency,
  money,
  productsApi,
  type InventoryResult,
} from './shared.js';

export function productCatalogApi(client: AltegioClient): ProductCatalogApi {
  return ProductCatalogAdapter.forClient(client);
}

// ========== shared ==========

/** Case, spacing and edge whitespace do not tell two names apart. */
function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function fenced(lines: string[], untrusted: UntrustedField[]): string {
  return withUntrustedBlock(lines.join('\n'), untrusted, {
    maxChars: FIELD_MAX_CHARS,
  });
}

// ========== product categories ==========

function categoryLine(c: ProductCategory): string {
  return `- ${c.id}: ${c.parent_id === null ? 'top level' : `inside category ${c.parent_id}`}${c.chain_category ? ' · chain category' : ''}`;
}

function categoryUntrusted(
  items: readonly ProductCategory[]
): UntrustedField[] {
  return items.map((c) => ({
    label: `product category ${c.id} title`,
    value: c.title,
  }));
}

export async function listProductCategories(
  client: AltegioClient,
  input: { location_id: number; query?: string } & PageInput
): Promise<InventoryResult> {
  const all = await productCatalogApi(client).listCategories(input.location_id);
  const query = normalized(input.query);
  const matching = query
    ? all.filter((c) => normalized(c.title).includes(query))
    : all;
  const { items, pagination } = paginateCollection(matching, input);
  const lines = [
    `${matching.length} product categor${matching.length === 1 ? 'y' : 'ies'}${query ? ' matching the query' : ''} at location ${input.location_id}; page ${pagination.page} shows ${items.length}:`,
    ...items.map(categoryLine),
  ];
  if (pagination.has_more)
    lines.push(
      `More follow: request page ${pagination.next_page} with page_size ${pagination.page_size}.`
    );
  return {
    text: fenced(lines, categoryUntrusted(items)),
    structuredContent: { location_id: input.location_id, items, pagination },
  };
}

async function findCategory(
  api: ProductCatalogApi,
  locationId: number,
  categoryId: number,
  role = 'category'
): Promise<{ category: ProductCategory; all: ProductCategory[] }> {
  const all = await api.listCategories(locationId);
  const category = all.find((c) => c.id === categoryId);
  if (!category) {
    throw new InventoryNotFoundError(
      `Product ${role} ${categoryId} was not found at location ${locationId}. Check the id with product_categories_list; a deleted category is gone.`
    );
  }
  return { category, all };
}

export interface CreateCategoryInput {
  location_id: number;
  title: string;
  parent_id?: number;
}

/** The category the create would duplicate: same title under the same parent. */
async function planCategoryCreate(
  client: AltegioClient,
  input: CreateCategoryInput
): Promise<{ parent: ProductCategory | null }> {
  const api = productCatalogApi(client);
  const all = await api.listCategories(input.location_id);
  const parentId = input.parent_id ?? null;
  const parent =
    parentId === null ? null : (all.find((c) => c.id === parentId) ?? null);
  if (parentId !== null && !parent) {
    throw new InventoryInputError(
      `Nothing was created: parent category ${parentId} was not found at location ${input.location_id}. Check it with product_categories_list.`
    );
  }
  const twin = all.find(
    (c) =>
      c.parent_id === parentId &&
      normalized(c.title) === normalized(input.title)
  );
  if (twin) {
    throw new InventoryInputError(
      `Nothing was created: product category ${twin.id} already has this title ${parentId === null ? 'at the top level' : `inside category ${parentId}`}. Use it, or give the new category another title.`
    );
  }
  return { parent };
}

export async function describeCategoryCreate(
  client: AltegioClient,
  input: CreateCategoryInput
): Promise<string> {
  const { parent } = await planForConfirmation(
    () =>
      planCategoryCreate(client, input).then((p) => ({ ...p, version: '' })),
    InventoryInputError
  );
  return parent
    ? `Inside category ${parent.id}.`
    : 'At the top level of the product categories.';
}

export async function createProductCategory(
  client: AltegioClient,
  input: CreateCategoryInput,
  confirmation?: ConfirmedCall
): Promise<InventoryResult> {
  await planCategoryCreate(client, input);
  const created = await productCatalogApi(client).createCategory(
    input.location_id,
    { title: input.title.trim(), parent_id: input.parent_id ?? null },
    writeOptions(confirmation)
  );
  return {
    text: fenced(
      [
        `Created product category ${created.id} at location ${input.location_id}, ${created.parent_id === null ? 'at the top level' : `inside category ${created.parent_id}`}. File products under it with category_id ${created.id} (products_create, products_update).`,
      ],
      categoryUntrusted([created])
    ),
    structuredContent: { location_id: input.location_id, category: created },
  };
}

export interface UpdateCategoryInput {
  location_id: number;
  category_id: number;
  title?: string;
  /** 0 moves the category to the top level. */
  parent_id?: number;
}

interface CategoryPlan {
  version: string;
  before: ProductCategory;
  after: { title: string; parent_id: number | null };
}

async function planCategoryUpdate(
  client: AltegioClient,
  input: UpdateCategoryInput
): Promise<CategoryPlan> {
  if (input.title === undefined && input.parent_id === undefined) {
    throw new InventoryInputError(
      'Nothing was changed: pass a new title, a new parent_id, or both.'
    );
  }
  const { category, all } = await findCategory(
    productCatalogApi(client),
    input.location_id,
    input.category_id
  );
  const parentId =
    input.parent_id === undefined
      ? category.parent_id
      : input.parent_id === 0
        ? null
        : input.parent_id;
  if (parentId !== null) {
    if (!all.some((c) => c.id === parentId)) {
      throw new InventoryInputError(
        `Nothing was changed: parent category ${parentId} was not found at location ${input.location_id}. Check it with product_categories_list.`
      );
    }
    // A category cannot move under itself or one of its own subcategories.
    const byId = new Map(all.map((c) => [c.id, c]));
    for (let at: number | null = parentId; at !== null;) {
      if (at === category.id) {
        throw new InventoryInputError(
          `Nothing was changed: category ${parentId} is category ${category.id} itself or one of its subcategories, so it cannot be its parent.`
        );
      }
      at = byId.get(at)?.parent_id ?? null;
    }
  }
  const title = input.title?.trim() ?? category.title ?? '';
  if (title === '') {
    throw new InventoryInputError(
      `Nothing was changed: category ${category.id} has no title to keep; pass one.`
    );
  }
  return {
    version: stateVersion(category),
    before: category,
    after: { title, parent_id: parentId },
  };
}

function categoryChange(plan: CategoryPlan): string {
  const changes: string[] = [];
  if (plan.after.title !== (plan.before.title ?? ''))
    changes.push('title: changed (both titles are in the block below)');
  if (plan.after.parent_id !== plan.before.parent_id)
    changes.push(
      `parent: ${plan.before.parent_id ?? 'top level'} → ${plan.after.parent_id ?? 'top level'}`
    );
  return changes.length ? changes.join('; ') : 'no change';
}

export async function describeCategoryUpdate(
  client: AltegioClient,
  input: UpdateCategoryInput
): Promise<ConfirmationDetail> {
  const plan = await planForConfirmation(
    () => planCategoryUpdate(client, input),
    InventoryInputError
  );
  return {
    text: fenced(
      [`Change: ${categoryChange(plan)}.`],
      [
        {
          label: `category ${plan.before.id} title now`,
          value: plan.before.title,
        },
        {
          label: `category ${plan.before.id} title after`,
          value: plan.after.title,
        },
      ]
    ),
    version: plan.version,
  };
}

export async function updateProductCategory(
  client: AltegioClient,
  input: UpdateCategoryInput,
  confirmation?: ConfirmedCall
): Promise<InventoryResult> {
  const plan = await planConfirmed(
    () => planCategoryUpdate(client, input),
    confirmation,
    () =>
      new InventoryInputError(
        `Nothing was changed: product category ${input.category_id} changed after the confirmation was shown. Read it again with product_categories_list and confirm the change again.`
      )
  );
  const saved = await productCatalogApi(client).updateCategory(
    input.location_id,
    input.category_id,
    plan.after,
    writeOptions(confirmation)
  );
  return {
    text: fenced(
      [
        `Changed product category ${saved.id} at location ${input.location_id}: ${categoryChange(plan)}.`,
      ],
      categoryUntrusted([saved])
    ),
    structuredContent: {
      location_id: input.location_id,
      before: plan.before,
      category: saved,
    },
  };
}

export async function describeCategory(
  client: AltegioClient,
  input: { location_id: number; category_id: number }
): Promise<string | undefined> {
  const all = await productCatalogApi(client).listCategories(input.location_id);
  const category = all.find((c) => c.id === input.category_id);
  if (!category) return undefined;
  const children = all.filter((c) => c.parent_id === category.id).length;
  return `product category "${category.title ?? ''}", id ${category.id}${children ? `, holding ${children} subcategor${children === 1 ? 'y' : 'ies'}` : ''}, at location ${input.location_id}`;
}

export async function deleteProductCategory(
  client: AltegioClient,
  input: { location_id: number; category_id: number },
  confirmation?: ConfirmedCall
): Promise<InventoryResult> {
  const api = productCatalogApi(client);
  await findCategory(api, input.location_id, input.category_id);
  await api.deleteCategory(
    input.location_id,
    input.category_id,
    writeOptions(confirmation)
  );
  return {
    text: `Deleted product category ${input.category_id} at location ${input.location_id}.`,
    structuredContent: {
      location_id: input.location_id,
      category_id: input.category_id,
      deleted: true,
    },
  };
}

// ========== units ==========

/** Units have no curated list: the executor reads them. */
const UNITS_HINT =
  'List the units with api_call_operation list_product_units and pass an id.';

/** A unit by id, or by its short title or title, case-insensitively. */
function resolveUnit(
  units: readonly ProductUnit[],
  ref: number | string,
  where: string
): ProductUnit {
  if (typeof ref === 'number') {
    const unit = units.find((u) => u.id === ref);
    if (!unit) {
      throw new InventoryInputError(
        `${where}: unit ${ref} is not a unit of this location. ${UNITS_HINT}`
      );
    }
    return unit;
  }
  const name = normalized(ref);
  // The V2 list can repeat a unit; one id is one unit.
  const matches = [
    ...new Map(
      units
        .filter(
          (u) =>
            normalized(u.short_title) === name || normalized(u.title) === name
        )
        .map((u) => [u.id, u])
    ).values(),
  ];
  if (matches.length === 1) return matches[0]!;
  throw new InventoryInputError(
    matches.length === 0
      ? `${where}: no unit is called that. ${UNITS_HINT}`
      : `${where}: ${matches.length} units are called that (ids ${matches.map((u) => u.id).join(', ')}); pass an id.`
  );
}

// ========== matching products ==========

export type MatchKind = 'barcode' | 'article' | 'title' | 'similar_title';

export interface ProductMatch {
  product_id: number;
  title: string | null;
  match: MatchKind;
  category_id: number | null;
  article: string | null;
  barcode: string | null;
  sale_price: number | null;
  cost_price: number | null;
}

export interface MatchQuery {
  title?: string;
  article?: string;
  barcode?: string;
}

/** Candidates a search reads per line; the closest are kept. */
const CANDIDATES_PER_TERM = 5;
const CARD_READ_CONCURRENCY = 6;

const MATCH_ORDER: Record<MatchKind, number> = {
  barcode: 0,
  article: 1,
  title: 2,
  similar_title: 3,
};

function matchKind(card: ProductCard, query: MatchQuery): MatchKind | null {
  if (query.barcode && normalized(card.barcode) === normalized(query.barcode))
    return 'barcode';
  if (query.article && normalized(card.article) === normalized(query.article))
    return 'article';
  if (query.title && normalized(card.title) === normalized(query.title))
    return 'title';
  return query.title ? 'similar_title' : null;
}

/**
 * The live products a line may already be: searched by its barcode, article
 * number and title (each of at least two characters), then read whole for
 * the article number and barcode the search does not return. Archived
 * products are not found: Altegio's search leaves them out.
 */
async function matchesFor(
  client: AltegioClient,
  locationId: number,
  query: MatchQuery
): Promise<ProductMatch[]> {
  const products = productsApi(client);
  const terms = [query.barcode, query.article, query.title]
    .map((t) => t?.trim())
    .filter((t): t is string => !!t && t.length >= 2);
  const found = new Map<number, Product>();
  for (const term of new Set(terms)) {
    const hits = await products.searchProducts(locationId, term, {
      page: 1,
      page_size: CANDIDATES_PER_TERM,
    });
    for (const p of hits) found.set(p.id, p);
  }
  const api = productCatalogApi(client);
  const cards = await mapWithConcurrency(
    [...found.keys()],
    CARD_READ_CONCURRENCY,
    (productId) => api.getProductCard(locationId, productId)
  );
  return cards
    .map((card) => ({ card, kind: matchKind(card, query) }))
    .filter((m): m is { card: ProductCard; kind: MatchKind } => m.kind !== null)
    .sort((a, b) => MATCH_ORDER[a.kind] - MATCH_ORDER[b.kind])
    .map(({ card, kind }) => ({
      product_id: card.id,
      title: card.title,
      match: kind,
      category_id: card.category_id,
      article: card.article,
      barcode: card.barcode,
      sale_price: card.sale_price,
      cost_price: card.cost_price,
    }));
}

/** An exact match by barcode, article number or title blocks a create. */
function isDuplicate(match: ProductMatch): boolean {
  return match.match !== 'similar_title';
}

// ========== product cards: create ==========

export interface ProductFieldsInput {
  title?: string;
  category_id?: number;
  sale_price?: number;
  cost_price?: number;
  sale_unit?: number | string;
  consumable_unit?: number | string;
  consumable_units_per_sale_unit?: number;
  article?: string;
  barcode?: string;
  print_title?: string;
  comment?: string;
  critical_quantity?: number;
  desired_quantity?: number;
}

export interface NewProductInput extends ProductFieldsInput {
  title: string;
  category_id: number;
}

export interface CreateProductsInput {
  location_id: number;
  products: NewProductInput[];
  skip_existing: boolean;
}

interface PlannedProduct {
  line: number;
  write: ProductCardWrite;
  sale_unit: ProductUnit;
  consumable_unit: ProductUnit;
  /** Exact matches: the line is not created. */
  existing: ProductMatch[];
}

interface CreatePlan {
  currency: string | null;
  planned: PlannedProduct[];
}

/** The sale unit a product gets when none is named: the piece. */
const DEFAULT_SALE_UNIT = 'pcs';

function moneyField(
  value: number | undefined,
  currency: string | null,
  field: string
) {
  return value === undefined ? undefined : moneyInput(value, currency, field);
}

async function planCreate(
  client: AltegioClient,
  input: CreateProductsInput
): Promise<CreatePlan> {
  const keys = new Map<string, number>();
  input.products.forEach((p, index) => {
    for (const [kind, value] of [
      ['barcode', p.barcode],
      ['article', p.article],
      ['title', p.title],
    ] as const) {
      if (!value?.trim()) continue;
      const key = `${kind}:${normalized(value)}`;
      const first = keys.get(key);
      if (first !== undefined) {
        throw new InventoryInputError(
          `Nothing was created: lines ${first + 1} and ${index + 1} have the same ${kind}. Merge them into one product, or tell them apart.`
        );
      }
      keys.set(key, index);
    }
  });
  const [units, categories, currency] = await Promise.all([
    productsApi(client).listUnits(input.location_id),
    productCatalogApi(client).listCategories(input.location_id),
    locationCurrency(client, input.location_id),
  ]);
  const categoryIds = new Set(categories.map((c) => c.id));
  const planned: PlannedProduct[] = [];
  for (const [index, p] of input.products.entries()) {
    const where = `Line ${index + 1}`;
    if (!categoryIds.has(p.category_id)) {
      throw new InventoryInputError(
        `Nothing was created: ${where}: product category ${p.category_id} was not found at location ${input.location_id}. Check it with product_categories_list, or create it with product_categories_create.`
      );
    }
    const saleUnit = resolveUnit(
      units,
      p.sale_unit ?? DEFAULT_SALE_UNIT,
      where
    );
    const consumableUnit =
      p.consumable_unit === undefined
        ? saleUnit
        : resolveUnit(units, p.consumable_unit, where);
    const ratio =
      p.consumable_units_per_sale_unit ??
      (consumableUnit.id === saleUnit.id ? 1 : undefined);
    if (ratio === undefined) {
      throw new InventoryInputError(
        `Nothing was created: ${where}: the consumable unit differs from the sale unit, so pass consumable_units_per_sale_unit (how many consumable units one sale unit holds, such as 250 ml in a bottle).`
      );
    }
    planned.push({
      line: index + 1,
      sale_unit: saleUnit,
      consumable_unit: consumableUnit,
      existing: (await matchesFor(client, input.location_id, p)).filter(
        isDuplicate
      ),
      write: {
        title: p.title.trim(),
        category_id: p.category_id,
        sale_unit_id: saleUnit.id,
        consumable_unit_id: consumableUnit.id,
        consumable_units_per_sale_unit: ratio,
        sale_price: moneyField(p.sale_price, currency, `${where}: sale_price`),
        cost_price: moneyField(p.cost_price, currency, `${where}: cost_price`),
        article: p.article?.trim(),
        barcode: p.barcode?.trim(),
        print_title: p.print_title?.trim(),
        comment: p.comment,
        critical_quantity: p.critical_quantity,
        desired_quantity: p.desired_quantity,
      },
    });
  }
  const existing = planned.filter((p) => p.existing.length > 0);
  if (existing.length > 0 && !input.skip_existing) {
    throw new InventoryInputError(
      `Nothing was created: ${existing
        .map(
          (p) =>
            `line ${p.line} already exists as ${p.existing.map((m) => `product ${m.product_id} (same ${m.match})`).join(', ')}`
        )
        .join(
          '; '
        )}. Receive or change the existing products instead, or pass skip_existing: true to create only the other lines.`
    );
  }
  if (existing.length === planned.length) {
    throw new InventoryInputError(
      `Nothing was created: every line already exists (${existing.map((p) => `line ${p.line}: product ${p.existing[0]!.product_id}`).join('; ')}).`
    );
  }
  return { currency, planned };
}

function plannedLine(p: PlannedProduct, currency: string | null): string {
  if (p.existing.length) {
    return `- line ${p.line}: skipped, already exists as product ${p.existing[0]!.product_id} (same ${p.existing[0]!.match})`;
  }
  const w = p.write;
  const parts = [
    `category ${w.category_id}`,
    `sale price ${w.sale_price ? money(majorOf(w.sale_price), currency) : 'none'}`,
    `cost price ${w.cost_price ? money(majorOf(w.cost_price), currency) : 'none'}`,
    `sold per unit ${p.sale_unit.id}` +
      (p.consumable_unit.id === p.sale_unit.id
        ? ''
        : `, used per unit ${p.consumable_unit.id} (${w.consumable_units_per_sale_unit} in one)`),
  ];
  return `- line ${p.line}: ${parts.join(' · ')}`;
}

function plannedUntrusted(
  planned: readonly PlannedProduct[]
): UntrustedField[] {
  return planned.flatMap((p) => [
    { label: `line ${p.line} title`, value: p.write.title },
    { label: `line ${p.line} article number`, value: p.write.article ?? null },
    { label: `line ${p.line} barcode`, value: p.write.barcode ?? null },
    {
      label: `line ${p.line} sale unit`,
      value: p.sale_unit.short_title ?? p.sale_unit.title,
    },
    {
      label: `line ${p.line} consumable unit`,
      value: p.consumable_unit.short_title ?? p.consumable_unit.title,
    },
  ]);
}

export async function describeProductsCreate(
  client: AltegioClient,
  input: CreateProductsInput
): Promise<string> {
  const plan = await planForConfirmation(
    () => planCreate(client, input).then((p) => ({ ...p, version: '' })),
    InventoryInputError
  );
  return fenced(
    plan.planned.map((p) => plannedLine(p, plan.currency)),
    plannedUntrusted(plan.planned)
  );
}

export async function createProducts(
  client: AltegioClient,
  input: CreateProductsInput,
  confirmation?: ConfirmedCall
): Promise<InventoryResult> {
  // Planned again on a fresh read: a repeat finds what the first call made.
  const plan = await planCreate(client, input);
  const api = productCatalogApi(client);
  const created: { line: number; product: ProductCard }[] = [];
  const failed: { line: number; reason: string }[] = [];
  for (const p of plan.planned) {
    if (p.existing.length) continue;
    try {
      created.push({
        line: p.line,
        product: await api.createProduct(
          input.location_id,
          p.write,
          writeOptions(confirmation)
        ),
      });
    } catch (error) {
      failed.push({
        line: p.line,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const skipped = plan.planned.filter((p) => p.existing.length);
  const lines = [
    `Created ${created.length} product(s) at location ${input.location_id}${created.length ? `: ${created.map((c) => `line ${c.line} → product ${c.product.id}`).join(', ')}` : ''}.`,
  ];
  if (skipped.length)
    lines.push(
      `Skipped ${skipped.length} line(s) that already exist: ${skipped.map((p) => `line ${p.line} → product ${p.existing[0]!.product_id}`).join(', ')}.`
    );
  if (failed.length)
    lines.push(
      `Not created: ${failed.map((f) => `line ${f.line} (${f.reason})`).join('; ')}. The products created above stay; fix the failed lines and call again for them only.`
    );
  lines.push(
    'Stock is not changed: record a product receipt with inventory_create_operation. Archive a product created by mistake with products_archive.'
  );
  return {
    text: fenced(
      lines,
      created.map((c) => ({
        label: `product ${c.product.id} title`,
        value: c.product.title,
      }))
    ),
    structuredContent: {
      location_id: input.location_id,
      currency: plan.currency,
      created: created.map((c) => ({ line: c.line, ...c.product })),
      skipped: skipped.map((p) => ({
        line: p.line,
        product_id: p.existing[0]!.product_id,
        match: p.existing[0]!.match,
      })),
      failed,
    },
    ...(failed.length ? { isError: true } : {}),
  };
}

// ========== product cards: change ==========

export interface UpdateProductInput extends ProductFieldsInput {
  location_id: number;
  product_id: number;
}

interface UpdatePlan {
  version: string;
  before: ProductCard;
  write: ProductCardWrite;
  unit_change: boolean;
  changes: string[];
  currency: string | null;
}

const CHANGEABLE: readonly (keyof ProductFieldsInput)[] = [
  'title',
  'category_id',
  'sale_price',
  'cost_price',
  'sale_unit',
  'consumable_unit',
  'consumable_units_per_sale_unit',
  'article',
  'barcode',
  'print_title',
  'comment',
  'critical_quantity',
  'desired_quantity',
];

async function planUpdate(
  client: AltegioClient,
  input: UpdateProductInput
): Promise<UpdatePlan> {
  if (CHANGEABLE.every((field) => input[field] === undefined)) {
    throw new InventoryInputError(
      'Nothing was changed: pass at least one field to change.'
    );
  }
  // The V2 read refuses an archived product; the card read does not.
  await productsApi(client).getProduct(input.location_id, input.product_id, {
    stock: false,
  });
  const api = productCatalogApi(client);
  const [before, units, currency, categories] = await Promise.all([
    api.getProductCard(input.location_id, input.product_id),
    productsApi(client).listUnits(input.location_id),
    locationCurrency(client, input.location_id),
    input.category_id === undefined
      ? Promise.resolve(null)
      : api.listCategories(input.location_id),
  ]);
  if (before.loyalty_kind) {
    throw new InventoryInputError(
      `Nothing was changed: product ${before.id} sells a ${before.loyalty_kind === 'membership' ? 'membership' : 'gift card'}; change it with its ${before.loyalty_kind === 'membership' ? 'membership type' : 'gift card type'}, not here.`
    );
  }
  if (categories && !categories.some((c) => c.id === input.category_id)) {
    throw new InventoryInputError(
      `Nothing was changed: product category ${input.category_id} was not found at location ${input.location_id}. Check it with product_categories_list.`
    );
  }
  const where = `Product ${before.id}`;
  const saleUnitId =
    input.sale_unit === undefined
      ? before.sale_unit_id
      : resolveUnit(units, input.sale_unit, where).id;
  const consumableUnitId =
    input.consumable_unit === undefined
      ? before.consumable_unit_id
      : resolveUnit(units, input.consumable_unit, where).id;
  if (saleUnitId === null || consumableUnitId === null) {
    throw new InventoryInputError(
      `Nothing was changed: ${where} reports no sale or consumable unit; pass both sale_unit and consumable_unit.`
    );
  }
  const ratio =
    input.consumable_units_per_sale_unit ??
    before.consumable_units_per_sale_unit ??
    1;
  const unitChange =
    saleUnitId !== before.sale_unit_id ||
    consumableUnitId !== before.consumable_unit_id ||
    ratio !== before.consumable_units_per_sale_unit;
  const title = input.title?.trim() ?? before.title ?? '';
  const categoryId = input.category_id ?? before.category_id;
  if (title === '' || categoryId === null) {
    throw new InventoryInputError(
      `Nothing was changed: ${where} reports no ${title === '' ? 'title' : 'category'}; pass one.`
    );
  }
  const write: ProductCardWrite = {
    title,
    category_id: categoryId,
    sale_unit_id: saleUnitId,
    consumable_unit_id: consumableUnitId,
    consumable_units_per_sale_unit: ratio,
    sale_price: moneyField(input.sale_price, currency, 'sale_price'),
    cost_price: moneyField(input.cost_price, currency, 'cost_price'),
    article: input.article?.trim(),
    barcode: input.barcode?.trim(),
    print_title: input.print_title?.trim(),
    comment: input.comment,
    critical_quantity: input.critical_quantity,
    desired_quantity: input.desired_quantity,
  };
  const changes: string[] = [];
  if (input.title !== undefined) changes.push('title');
  if (
    input.category_id !== undefined &&
    input.category_id !== before.category_id
  )
    changes.push(
      `category ${before.category_id ?? 'none'} → ${input.category_id}`
    );
  if (input.sale_price !== undefined)
    changes.push(
      `sale price ${money(before.sale_price, currency)} → ${money(input.sale_price, currency)}`
    );
  if (input.cost_price !== undefined)
    changes.push(
      `cost price ${before.cost_price === null ? 'not visible' : money(before.cost_price, currency)} → ${money(input.cost_price, currency)}`
    );
  if (unitChange)
    changes.push(
      `units: sale ${before.sale_unit_id} → ${saleUnitId}, consumable ${before.consumable_unit_id} → ${consumableUnitId}, ${before.consumable_units_per_sale_unit} → ${ratio} per sale unit`
    );
  for (const field of [
    'article',
    'barcode',
    'print_title',
    'comment',
  ] as const) {
    if (input[field] !== undefined) changes.push(field.replace('_', ' '));
  }
  if (input.critical_quantity !== undefined)
    changes.push(
      `critical stock ${before.critical_quantity ?? 'none'} → ${input.critical_quantity}`
    );
  if (input.desired_quantity !== undefined)
    changes.push(
      `desired stock ${before.desired_quantity ?? 'none'} → ${input.desired_quantity}`
    );
  return {
    version: stateVersion(before),
    before,
    write,
    unit_change: unitChange,
    changes,
    currency,
  };
}

function updateUntrusted(plan: UpdatePlan): UntrustedField[] {
  const id = plan.before.id;
  const fields: UntrustedField[] = [
    { label: `product ${id} title now`, value: plan.before.title },
  ];
  if (plan.write.title !== plan.before.title)
    fields.push({
      label: `product ${id} title after`,
      value: plan.write.title,
    });
  if (plan.write.article !== undefined)
    fields.push({
      label: `product ${id} article number after`,
      value: plan.write.article,
    });
  if (plan.write.barcode !== undefined)
    fields.push({
      label: `product ${id} barcode after`,
      value: plan.write.barcode,
    });
  if (plan.write.print_title !== undefined)
    fields.push({
      label: `product ${id} receipt name after`,
      value: plan.write.print_title,
    });
  if (plan.write.comment !== undefined)
    fields.push({
      label: `product ${id} comment after`,
      value: plan.write.comment,
    });
  return fields;
}

export async function describeProductUpdate(
  client: AltegioClient,
  input: UpdateProductInput
): Promise<ConfirmationDetail> {
  const plan = await planForConfirmation(
    () => planUpdate(client, input),
    InventoryInputError
  );
  const lines = [`Changes: ${plan.changes.join('; ')}.`];
  if (plan.unit_change)
    lines.push(
      'A unit change converts the product’s past inventory operations by Altegio’s rules: sales and consumption keep their consumable-unit quantities, receipts, write-offs and transfers their sale-unit quantities.'
    );
  return { text: fenced(lines, updateUntrusted(plan)), version: plan.version };
}

export async function updateProduct(
  client: AltegioClient,
  input: UpdateProductInput,
  confirmation?: ConfirmedCall
): Promise<InventoryResult> {
  const plan = await planConfirmed(
    () => planUpdate(client, input),
    confirmation,
    () =>
      new InventoryInputError(
        `Nothing was changed: product ${input.product_id} changed after the confirmation was shown. Read it again with products_search and confirm the change again.`
      )
  );
  const saved = await productCatalogApi(client).updateProduct(
    input.location_id,
    input.product_id,
    plan.write,
    { ...writeOptions(confirmation), unit_change: plan.unit_change }
  );
  return {
    text: fenced(
      [
        `Changed product ${saved.id} at location ${input.location_id}: ${plan.changes.join('; ')}.`,
      ],
      [{ label: `product ${saved.id} title`, value: saved.title }]
    ),
    structuredContent: {
      location_id: input.location_id,
      currency: plan.currency,
      before: plan.before,
      product: saved,
    },
  };
}

// ========== product cards: archive ==========

export async function describeProduct(
  client: AltegioClient,
  input: { location_id: number; product_id: number }
): Promise<string | undefined> {
  const card = await productCatalogApi(client).getProductCard(
    input.location_id,
    input.product_id
  );
  return `product "${card.title ?? ''}", id ${card.id}, at location ${input.location_id}`;
}

export async function describeProductArchive(
  client: AltegioClient,
  input: { location_id: number; product_id: number }
): Promise<string> {
  const product = await productsApi(client)
    .getProduct(input.location_id, input.product_id, { stock: true })
    .catch((error: unknown) => {
      if (error instanceof InventoryNotFoundError) {
        throw new ConfirmationRefusal(
          `Product ${input.product_id} is not a live product of location ${input.location_id}: it is archived already or does not exist.`
        );
      }
      throw error;
    });
  const held = (product.stock ?? []).filter(
    (s) => (s.sale_quantity ?? 0) !== 0
  );
  return held.length
    ? `Stock it still holds stays recorded but is no longer offered: ${held.map((s) => `inventory ${s.inventory_id}: ${s.sale_quantity}`).join(', ')} (sale units).`
    : 'It holds no stock.';
}

export async function archiveProduct(
  client: AltegioClient,
  input: { location_id: number; product_id: number },
  confirmation?: ConfirmedCall
): Promise<InventoryResult> {
  // A product that never existed is refused here; an archived one still reads.
  await productCatalogApi(client).getProductCard(
    input.location_id,
    input.product_id
  );
  const outcome = await productCatalogApi(client).archiveProduct(
    input.location_id,
    input.product_id,
    writeOptions(confirmation)
  );
  return {
    text:
      outcome === 'archived'
        ? `Archived product ${input.product_id} at location ${input.location_id}: it no longer appears in products_search, sales or receipts. The API offers no way back.`
        : `Product ${input.product_id} at location ${input.location_id} was archived already; nothing changed.`,
    structuredContent: {
      location_id: input.location_id,
      product_id: input.product_id,
      outcome,
    },
  };
}
