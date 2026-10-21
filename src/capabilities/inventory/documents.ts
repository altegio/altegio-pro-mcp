/**
 * Inventory document use cases — what `inventory_update_document` and
 * `inventory_pay_document` do. Reading a document's lines is
 * `inventory_list_operations` with `document_id`.
 *
 * A document records one inventory operation (a product sale, a product
 * receipt, a write-off) with one stored line per product. Its lines can be
 * changed, added and removed, which moves stock at once; its date and comment
 * can be changed; its inventory cannot (Altegio would relabel the document
 * and leave the stock where it was). A product receipt is paid to its
 * Supplier with a financial transaction linked to the document.
 *
 * Writes are guarded: a change is planned on a fresh read of the document and
 * its lines and refused when they moved after the confirmation was shown, and
 * a payment is refused once the document is paid in full or when the same
 * payment was just recorded against it.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import type {
  DocumentLine,
  DocumentLineWrite,
  InventoryDocument,
  Product,
} from '../../api/inventory-api.js';
import type { FinancialTransaction } from '../../api/finance-api.js';
import {
  lineTotal,
  majorOf,
  moneyInput,
  MoneyInputError,
  moneyOf,
  sumMajor,
  type Money,
} from '../../api/money.js';
import { wallTime } from '../../api/v1/server-time.js';
import { writeOptions } from '../../api/write-options.js';
import { knownLocationTimezone } from '../analytics/location-timezone.js';
import { financeApi } from '../finance/ports.js';
import {
  stateVersion,
  type ConfirmationDetail,
  type ConfirmedCall,
} from '../../tools/confirmation.js';
import {
  withUntrustedBlock,
  type UntrustedField,
} from '../../tools/tool-result.js';
import { FinanceAccessError } from '../finance/errors.js';
import { planConfirmed, planForConfirmation } from '../guarded-change.js';
import { InventoryAccessError, InventoryInputError } from './errors.js';
import {
  FIELD_MAX_CHARS,
  inventoryApi,
  locationCurrency,
  money,
  productsApi,
  quantity,
  type InventoryResult,
  type ProductRef,
} from './shared.js';
import { planOperation, wireDate } from './use-cases.js';

const KIND_LABEL: Record<InventoryDocument['kind'], string> = {
  sale: 'product sale',
  consumption: 'consumption',
  receipt: 'product receipt',
  write_off: 'write-off',
  transfer: 'transfer',
  other: 'inventory operation',
};

/** The kinds whose documents and lines can be changed here. */
const EDITABLE = new Set<InventoryDocument['kind']>([
  'sale',
  'receipt',
  'write_off',
]);

function fenced(lines: string[], untrusted: UntrustedField[]): string {
  return withUntrustedBlock(lines.join('\n'), untrusted, {
    maxChars: FIELD_MAX_CHARS,
  });
}

// ========== reading a document ==========

export interface DocumentLineRow extends DocumentLine {
  product_title: string | null;
  unit: string | null;
}

export interface DocumentPaymentRow {
  id: number;
  /** Positive; a receipt's payments are expenses, a sale's income. */
  amount: number;
  account_id: number | null;
  payment_item_id: number | null;
  date: string | null;
  comment: string | null;
}

interface DocumentState {
  document: InventoryDocument;
  lines: DocumentLine[];
}

interface DocumentView extends DocumentState {
  currency: string | null;
  rows: DocumentLineRow[];
  total: number;
  /** Null when the payments could not be read (no Finances rights). */
  payments: DocumentPaymentRow[] | null;
  paid: number | null;
  amount_due: number | null;
}

async function readState(
  client: AltegioClient,
  locationId: number,
  documentId: number
): Promise<DocumentState> {
  const api = inventoryApi(client);
  // The document read is scoped to the location; the line list is not.
  const document = await api.getDocument(locationId, documentId);
  const lines = await api.getDocumentLines(locationId, documentId);
  return { document, lines };
}

function paymentRow(t: FinancialTransaction): DocumentPaymentRow {
  return {
    id: t.id,
    amount: Math.abs(t.amount),
    account_id: t.account_id,
    payment_item_id: t.payment_item_id,
    date: t.date,
    comment: t.comment,
  };
}

async function readView(
  client: AltegioClient,
  locationId: number,
  documentId: number
): Promise<DocumentView> {
  const state = await readState(client, locationId, documentId);
  const productIds = [
    ...new Set(
      state.lines
        .map((l) => l.product_id)
        .filter((id): id is number => id !== null)
    ),
  ];
  const [currency, products, units, payments] = await Promise.all([
    locationCurrency(client, locationId),
    productIds.length
      ? productsApi(client)
          .listProducts(locationId, {
            product_ids: productIds,
            page: 1,
            page_size: productIds.length,
          })
          .catch(() => [] as Product[])
      : Promise.resolve([] as Product[]),
    productsApi(client)
      .listUnits(locationId)
      .catch(() => []),
    financeApi(client)
      .listDocumentTransactions(locationId, documentId)
      .catch((error: unknown) => {
        if (error instanceof FinanceAccessError) return null;
        throw error;
      }),
  ]);
  const titles = new Map(products.map((p) => [p.id, p.title]));
  const unitNames = new Map(units.map((u) => [u.id, u.short_title ?? u.title]));
  const rows = state.lines.map((line) => ({
    ...line,
    product_title:
      line.product_id === null ? null : (titles.get(line.product_id) ?? null),
    unit: line.unit_id === null ? null : (unitNames.get(line.unit_id) ?? null),
  }));
  const total = sumMajor(state.lines.map((l) => l.total ?? 0));
  const paymentRows = payments?.map(paymentRow) ?? null;
  const paid = paymentRows ? sumMajor(paymentRows.map((p) => p.amount)) : null;
  const payable =
    state.document.kind === 'receipt' || state.document.kind === 'sale';
  return {
    ...state,
    currency,
    rows,
    total,
    payments: paymentRows,
    paid,
    amount_due:
      payable && paid !== null ? Math.max(0, sumMajor([total, -paid])) : null,
  };
}

function lineText(row: DocumentLineRow, currency: string | null): string {
  return (
    `- line ${row.id}: product ${row.product_id ?? 'not reported'}, ` +
    `${quantity(row.quantity, row.unit)} × ${money(row.unit_price, currency)}` +
    (row.discount_percent ? ` − ${row.discount_percent}%` : '') +
    ` = ${money(row.total, currency)}` +
    (row.supplier_id ? ` · Supplier ${row.supplier_id}` : '') +
    (row.appointment_id ? ` · appointment ${row.appointment_id}` : '')
  );
}

function viewUntrusted(view: DocumentView): UntrustedField[] {
  return [
    {
      label: `inventory ${view.document.inventory_id} title`,
      value: view.document.inventory_title,
    },
    {
      label: `document ${view.document.id} comment`,
      value: view.document.comment,
    },
    ...view.rows.flatMap((row) => [
      { label: `line ${row.id} product title`, value: row.product_title },
      { label: `line ${row.id} comment`, value: row.comment },
    ]),
    ...(view.payments ?? []).map((p) => ({
      label: `payment ${p.id} comment`,
      value: p.comment,
    })),
  ];
}

// ========== changing a document ==========

export interface LineChangeInput {
  line_id: number;
  quantity?: number;
  unit_price?: number;
  discount_percent?: number;
  remove?: boolean;
}

export interface AddLineInput extends ProductRef {
  quantity: number;
  unit?: 'sale' | 'consumable';
  unit_price?: number;
  discount_percent?: number;
}

export interface UpdateDocumentInput {
  location_id: number;
  document_id: number;
  date?: string;
  comment?: string;
  lines?: LineChangeInput[];
  add_lines?: AddLineInput[];
}

interface LineEdit {
  line: DocumentLine;
  write: DocumentLineWrite;
}

interface UpdateDocumentPlan {
  version: string;
  document: InventoryDocument;
  currency: string | null;
  header: { date_local: string; comment: string } | null;
  edits: LineEdit[];
  removals: DocumentLine[];
  additions: DocumentLineWrite[];
  /** The document total before and after. */
  total_before: number;
  total_after: number;
}

function money2(value: number, currency: string | null, field: string): Money {
  try {
    return moneyInput(value, currency, field);
  } catch (error) {
    if (error instanceof MoneyInputError) {
      throw new InventoryInputError(`Nothing was changed: ${error.message}`);
    }
    throw error;
  }
}

/** Every field of a stored line, for the update that replaces it whole. */
function lineWrite(
  line: DocumentLine,
  documentId: number,
  currency: string | null,
  change: Partial<
    Pick<LineChangeInput, 'quantity' | 'unit_price' | 'discount_percent'>
  > = {}
): DocumentLineWrite {
  if (line.product_id === null || line.unit_id === null) {
    throw new InventoryInputError(
      `Nothing was changed: line ${line.id} reports no product or unit, so it cannot be rewritten.`
    );
  }
  const qty = change.quantity ?? line.quantity ?? 0;
  const price =
    change.unit_price === undefined
      ? moneyOf(line.unit_price ?? 0, currency)
      : money2(change.unit_price, currency, `line ${line.id} unit_price`);
  const discount = change.discount_percent ?? line.discount_percent ?? 0;
  return {
    document_id: documentId,
    product_id: line.product_id,
    quantity: qty,
    unit_id: line.unit_id,
    unit_price: price,
    discount_percent: discount,
    total: lineTotal(qty, price, discount),
    supplier_id: line.supplier_id,
    team_member_id: line.team_member_id,
    client_id: line.client_id,
    comment: line.comment ?? '',
  };
}

async function planDocumentUpdate(
  client: AltegioClient,
  input: UpdateDocumentInput
): Promise<UpdateDocumentPlan> {
  const changes = input.lines ?? [];
  const adds = input.add_lines ?? [];
  if (
    input.date === undefined &&
    input.comment === undefined &&
    changes.length === 0 &&
    adds.length === 0
  ) {
    throw new InventoryInputError(
      'Nothing was changed: pass a date, a comment, line changes or lines to add.'
    );
  }
  const [state, currency] = await Promise.all([
    readState(client, input.location_id, input.document_id),
    locationCurrency(client, input.location_id),
  ]);
  const { document, lines } = state;
  if (!EDITABLE.has(document.kind)) {
    throw new InventoryInputError(
      `Nothing was changed: document ${document.id} is a ${KIND_LABEL[document.kind]}; only product sale, product receipt and write-off documents are changed here.`
    );
  }
  if (document.inventory_id === null || document.date_local === null) {
    throw new InventoryInputError(
      `Nothing was changed: document ${document.id} reports no inventory or date, so its header cannot be stored again.`
    );
  }
  const byId = new Map(lines.map((l) => [l.id, l]));
  const seen = new Set<number>();
  const edits: LineEdit[] = [];
  const removals: DocumentLine[] = [];
  for (const change of changes) {
    const line = byId.get(change.line_id);
    if (!line) {
      throw new InventoryInputError(
        `Nothing was changed: line ${change.line_id} is not a line of document ${document.id}; read its lines with inventory_list_operations and document_id.`
      );
    }
    if (seen.has(line.id)) {
      throw new InventoryInputError(
        `Nothing was changed: line ${line.id} is listed twice; put its whole change in one entry.`
      );
    }
    seen.add(line.id);
    if (line.appointment_id !== null) {
      throw new InventoryInputError(
        `Nothing was changed: line ${line.id} belongs to appointment ${line.appointment_id}; change it on the appointment (visits_add_product, appointments_set_consumables).`
      );
    }
    const edit =
      change.quantity !== undefined ||
      change.unit_price !== undefined ||
      change.discount_percent !== undefined;
    if (change.remove) {
      if (edit) {
        throw new InventoryInputError(
          `Nothing was changed: line ${line.id} is both removed and changed; do one.`
        );
      }
      removals.push(line);
    } else if (edit) {
      edits.push({
        line,
        write: lineWrite(line, document.id, currency, change),
      });
    } else {
      throw new InventoryInputError(
        `Nothing was changed: the entry for line ${line.id} changes nothing; pass quantity, unit_price, discount_percent or remove.`
      );
    }
  }
  if (removals.length === lines.length && adds.length === 0) {
    throw new InventoryInputError(
      `Nothing was changed: that would remove every line of document ${document.id}; delete the document with inventory_delete_document instead.`
    );
  }

  // Added lines are priced the way a new operation of this kind is.
  let additions: DocumentLineWrite[] = [];
  if (adds.length) {
    const kind = document.kind as 'sale' | 'receipt' | 'write_off';
    const first = lines.find((l) => l.supplier_id !== null) ?? lines[0];
    const planned = await planOperation(client, {
      location_id: input.location_id,
      kind,
      team_member_id: first?.team_member_id ?? 0,
      inventory_id: document.inventory_id,
      lines: adds,
    });
    additions = planned.lines.map((l) => ({
      document_id: document.id,
      product_id: l.product_id,
      quantity: l.quantity,
      unit_id: l.unit_id,
      unit_price: l.price,
      discount_percent: l.discount_percent,
      total: l.line_total,
      supplier_id: kind === 'receipt' ? (first?.supplier_id ?? null) : null,
      team_member_id: kind === 'sale' ? (first?.team_member_id ?? null) : null,
      client_id: kind === 'sale' ? (first?.client_id ?? null) : null,
      comment: document.comment ?? '',
    }));
  }

  const header =
    input.date !== undefined || input.comment !== undefined
      ? {
          date_local:
            input.date !== undefined
              ? wireDate(input.date)
              : document.date_local.replace('T', ' ').slice(0, 19),
          comment: input.comment ?? document.comment ?? '',
        }
      : null;

  const removed = new Set(removals.map((l) => l.id));
  const edited = new Map(edits.map((e) => [e.line.id, majorOf(e.write.total)]));
  const totalAfter = sumMajor([
    ...lines
      .filter((l) => !removed.has(l.id))
      .map((l) => edited.get(l.id) ?? l.total ?? 0),
    ...additions.map((a) => majorOf(a.total)),
  ]);
  return {
    version: stateVersion(state),
    document,
    currency,
    header,
    edits,
    removals,
    additions,
    total_before: sumMajor(lines.map((l) => l.total ?? 0)),
    total_after: totalAfter,
  };
}

function planLines(plan: UpdateDocumentPlan): string[] {
  const c = plan.currency;
  const out: string[] = [];
  if (plan.header) {
    if (
      plan.header.date_local !==
      plan.document.date_local?.replace('T', ' ').slice(0, 19)
    )
      out.push(
        `- date: ${plan.document.date_local ?? 'not reported'} → ${plan.header.date_local} location time (every line moves with it)`
      );
    if (plan.header.comment !== (plan.document.comment ?? ''))
      out.push('- comment: changed (both are in the block below)');
  }
  for (const e of plan.edits) {
    out.push(
      `- line ${e.line.id} (product ${e.line.product_id}): ${quantity(e.line.quantity, null).replace(/ units$/, '')} × ${money(e.line.unit_price, c)} = ${money(e.line.total, c)} → ${e.write.quantity} × ${money(majorOf(e.write.unit_price), c)}${e.write.discount_percent ? ` − ${e.write.discount_percent}%` : ''} = ${money(majorOf(e.write.total), c)}`
    );
  }
  for (const l of plan.removals) {
    out.push(
      `- line ${l.id} (product ${l.product_id}, ${l.quantity} × ${money(l.unit_price, c)}): removed`
    );
  }
  for (const a of plan.additions) {
    out.push(
      `- new line: product ${a.product_id}, ${a.quantity} × ${money(majorOf(a.unit_price), c)}${a.discount_percent ? ` − ${a.discount_percent}%` : ''} = ${money(majorOf(a.total), c)}`
    );
  }
  out.push(
    `Document total: ${money(plan.total_before, c)} → ${money(plan.total_after, c)}.`
  );
  return out;
}

function stockNote(plan: UpdateDocumentPlan): string | null {
  if (!plan.edits.length && !plan.removals.length && !plan.additions.length)
    return null;
  return plan.document.kind === 'receipt'
    ? 'Stock follows at once: a larger or added line brings more into the inventory, a smaller or removed one takes it out again.'
    : 'Stock follows at once: a larger or added line takes more from the inventory, a smaller or removed one puts it back.';
}

export async function describeDocumentUpdate(
  client: AltegioClient,
  input: UpdateDocumentInput
): Promise<ConfirmationDetail> {
  const plan = await planForConfirmation(
    () => planDocumentUpdate(client, input),
    InventoryInputError
  );
  const note = stockNote(plan);
  return {
    text: fenced(
      [...planLines(plan), ...(note ? [note] : [])],
      plan.header && plan.header.comment !== (plan.document.comment ?? '')
        ? [
            {
              label: `document ${plan.document.id} comment now`,
              value: plan.document.comment,
            },
            {
              label: `document ${plan.document.id} comment after`,
              value: plan.header.comment,
            },
          ]
        : []
    ),
    version: plan.version,
  };
}

export async function updateDocument(
  client: AltegioClient,
  input: UpdateDocumentInput,
  confirmation?: ConfirmedCall
): Promise<InventoryResult> {
  const plan = await planConfirmed(
    () => planDocumentUpdate(client, input),
    confirmation,
    () =>
      new InventoryInputError(
        `Nothing was changed: document ${input.document_id} or its lines changed after the confirmation was shown. Read its lines again with inventory_list_operations and document_id, and confirm the change again.`
      )
  );
  const api = inventoryApi(client);
  const options = writeOptions(confirmation);
  const done: string[] = [];
  const failed: string[] = [];
  const step = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run();
      done.push(what);
    } catch (error) {
      failed.push(
        `${what}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
  if (plan.header) {
    const header = plan.header;
    await step('header', () =>
      api.updateDocument(
        input.location_id,
        plan.document.id,
        {
          kind: plan.document.kind,
          inventory_id: plan.document.inventory_id!,
          ...header,
        },
        options
      )
    );
  }
  for (const e of plan.edits) {
    await step(`line ${e.line.id}`, () =>
      api.updateDocumentLine(input.location_id, e.line.id, e.write, options)
    );
  }
  for (const a of plan.additions) {
    await step(`new line for product ${a.product_id}`, () =>
      api.addDocumentLine(input.location_id, a, options)
    );
  }
  for (const l of plan.removals) {
    await step(`removal of line ${l.id}`, () =>
      api.deleteDocumentLine(input.location_id, l.id, options)
    );
  }
  const after = await readView(client, input.location_id, plan.document.id);
  const lines = [
    failed.length
      ? `Document ${plan.document.id} was changed in part: done ${done.join(', ') || 'nothing'}; not done ${failed.join('; ')}. Read its lines with inventory_list_operations and document_id before trying again.`
      : `Changed document ${plan.document.id} at location ${input.location_id}: ${done.join(', ')}.`,
    `It now has ${after.rows.length} line(s), total ${money(after.total, after.currency)}.`,
    ...after.rows.map((row) => lineText(row, after.currency)),
  ];
  if (
    after.amount_due !== null &&
    after.paid !== null &&
    after.paid > after.total
  )
    lines.push(
      `Its payments (${money(after.paid, after.currency)}) now exceed its total; delete the extra payment with financial_transactions_delete.`
    );
  return {
    text: fenced(lines, viewUntrusted(after)),
    structuredContent: {
      location_id: input.location_id,
      currency: after.currency,
      document: after.document,
      lines: after.rows,
      total: after.total,
      paid: after.paid,
      amount_due: after.amount_due,
      done,
      failed,
    },
    ...(failed.length ? { isError: true } : {}),
  };
}

// ========== paying a product receipt ==========

/** The standard "Product purchase" payment item every location has. */
export const PRODUCT_PURCHASE_ITEM = 2;

/** How recent an identical payment of the document must be to be a repeat. */
const REPEAT_WINDOW_MS = 10 * 60 * 1000;

export interface PayDocumentInput {
  location_id: number;
  document_id: number;
  account_id: number;
  amount?: number;
  payment_item_id?: number;
  date?: string;
  comment?: string;
}

interface PayPlan {
  version: string;
  view: DocumentView;
  amount: Money;
  payment_item_id: number;
  supplier_id: number | null;
  local_date: string;
}

async function planPayment(
  client: AltegioClient,
  input: PayDocumentInput,
  now = Date.now()
): Promise<PayPlan> {
  const [view, items, zone] = await Promise.all([
    readView(client, input.location_id, input.document_id),
    financeApi(client).listPaymentItems(input.location_id),
    knownLocationTimezone(client, input.location_id),
  ]);
  const d = view.document;
  if (d.kind !== 'receipt') {
    throw new InventoryInputError(
      `Nothing was paid: document ${d.id} is a ${KIND_LABEL[d.kind]}; only a product receipt is paid to its Supplier here. A sale on a visit is paid with visits_add_payment.`
    );
  }
  if (
    view.payments === null ||
    view.paid === null ||
    view.amount_due === null
  ) {
    throw new InventoryAccessError(
      `Nothing was paid: the payments of document ${d.id} cannot be read, so its amount due is unknown. Paying needs the Finances access rights at the location.`
    );
  }
  if (view.amount_due <= 0) {
    throw new InventoryInputError(
      `Nothing was paid: document ${d.id} is paid in full (${money(view.paid, view.currency)} of ${money(view.total, view.currency)}).`
    );
  }
  const amount =
    input.amount === undefined
      ? moneyOf(view.amount_due, view.currency)
      : (() => {
          try {
            return moneyInput(input.amount, view.currency, 'amount', [
              view.amount_due,
            ]);
          } catch (error) {
            if (error instanceof MoneyInputError)
              throw new InventoryInputError(
                `Nothing was paid: ${error.message}`
              );
            throw error;
          }
        })();
  if (majorOf(amount) > view.amount_due) {
    throw new InventoryInputError(
      `Nothing was paid: ${money(majorOf(amount), view.currency)} is more than the amount due of document ${d.id}, ${money(view.amount_due, view.currency)}.`
    );
  }
  const itemId = input.payment_item_id ?? PRODUCT_PURCHASE_ITEM;
  const item = items.find((i) => i.id === itemId);
  if (!item || item.direction !== 'expense') {
    throw new InventoryInputError(
      `Nothing was paid: payment item ${itemId} is not an expense item of location ${input.location_id}. Pick one with financial_transactions_list_payment_items.`
    );
  }
  const repeat = view.payments.find(
    (p) =>
      p.account_id === input.account_id &&
      p.amount === majorOf(amount) &&
      p.date !== null &&
      now - Date.parse(p.date) < REPEAT_WINDOW_MS &&
      now - Date.parse(p.date) > -REPEAT_WINDOW_MS
  );
  if (repeat) {
    throw new InventoryInputError(
      `Nothing was paid: financial transaction ${repeat.id} paid the same ${money(repeat.amount, view.currency)} from account ${repeat.account_id} for document ${d.id} a moment ago, so this looks like a repeat of the same call. If a second payment is really meant, give it another amount or account; it needs a new confirmation.`
    );
  }
  if (zone === null && input.date === undefined) {
    throw new InventoryInputError(
      `Nothing was paid: the time zone of location ${input.location_id} is unknown, so pass the date as YYYY-MM-DDTHH:MM at the location.`
    );
  }
  return {
    version: stateVersion({
      document: d,
      lines: view.lines,
      payments: view.payments,
    }),
    view,
    amount,
    payment_item_id: itemId,
    supplier_id:
      view.lines.find((l) => l.supplier_id !== null)?.supplier_id ?? null,
    local_date:
      input.date !== undefined ? wireDate(input.date) : wallTime(now, zone!),
  };
}

function payLines(plan: PayPlan, input: PayDocumentInput): string[] {
  const c = plan.view.currency;
  return [
    `Document ${plan.view.document.id} totals ${money(plan.view.total, c)}; paid so far ${money(plan.view.paid, c)}; amount due ${money(plan.view.amount_due, c)}.`,
    `This payment: ${money(majorOf(plan.amount), c)} from account ${input.account_id} under payment item ${plan.payment_item_id}${plan.supplier_id ? ` to Supplier ${plan.supplier_id}` : ''}, dated ${plan.local_date} location time.`,
  ];
}

export async function describeDocumentPayment(
  client: AltegioClient,
  input: PayDocumentInput
): Promise<ConfirmationDetail> {
  const plan = await planForConfirmation(
    () => planPayment(client, input),
    InventoryInputError
  );
  return { text: payLines(plan, input).join('\n'), version: plan.version };
}

export async function payDocument(
  client: AltegioClient,
  input: PayDocumentInput,
  confirmation?: ConfirmedCall
): Promise<InventoryResult> {
  const plan = await planConfirmed(
    () => planPayment(client, input),
    confirmation,
    () =>
      new InventoryInputError(
        `Nothing was paid: document ${input.document_id}, its lines or its payments changed after the confirmation was shown. Ask for the confirmation again: it shows the amount due.`
      )
  );
  const transaction = await financeApi(client).createFinancialTransaction(
    input.location_id,
    {
      payment_item_id: plan.payment_item_id,
      account_id: input.account_id,
      amount: plan.amount,
      local_date: plan.local_date,
      client_id: null,
      team_member_id: null,
      supplier_id: plan.supplier_id,
      comment: input.comment ?? '',
      document_id: plan.view.document.id,
    },
    writeOptions(confirmation)
  );
  const c = plan.view.currency;
  const due = Math.max(
    0,
    sumMajor([plan.view.amount_due ?? 0, -majorOf(plan.amount)])
  );
  return {
    text: fenced(
      [
        `Paid ${money(majorOf(plan.amount), c)} for product receipt ${plan.view.document.id} from account ${input.account_id}: financial transaction ${transaction.id}. Amount due now ${money(due, c)}.`,
        `To undo it, delete financial transaction ${transaction.id} with financial_transactions_delete; the document and its stock stay.`,
      ],
      [
        {
          label: `payment ${transaction.id} comment`,
          value: transaction.comment,
        },
      ]
    ),
    structuredContent: {
      location_id: input.location_id,
      currency: c,
      document_id: plan.view.document.id,
      transaction,
      amount: majorOf(plan.amount),
      amount_due: due,
    },
  };
}
