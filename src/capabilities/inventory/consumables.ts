/**
 * Appointment consumables — what the `appointments_get_consumables` and
 * `appointments_set_consumables` tools do.
 *
 * The consumables of an appointment are the products one of its services
 * used, filled from the service's Bill of Materials and editable per
 * appointment. Three backend facts shape this module (see
 * `src/api/v1/inventory-adapter.ts` for the evidence):
 *
 * - the read returns every appointment of the visit, so it is filtered to the
 *   one asked about;
 * - the write replaces the service's whole list, so it is a read-modify-write
 *   here: lines the caller does not mention are sent back unchanged, and the
 *   confirmation shows the before/after;
 * - the write matches by service only, so two appointments of one visit with
 *   the same service would both receive the lines — that case is refused.
 *
 * Because the write re-plans on a fresh read, the confirmation binds the
 * version of what it showed (the list before and after, the Bill of Materials,
 * the attendance), and the write is refused when that version has moved:
 * otherwise a line added after the person approved would be kept or dropped
 * unseen, and a confirmed `replace` would remove it.
 *
 * Stock moves only while the appointment is marked arrived; the result says
 * which applies. Quantities are per one service, in the product's consumable
 * unit; the cost is Altegio's, at cost price.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import type {
  AppointmentServiceConsumables,
  AppointmentState,
  ConsumableLine,
  ConsumableWrite,
  Inventory,
  Product,
  ProductUnit,
} from '../../api/inventory-api.js';
import {
  withUntrustedBlock,
  type UntrustedField,
} from '../../tools/tool-result.js';
import { writeOptions } from '../../api/write-options.js';
import {
  ConfirmationRefusal,
  stateVersion,
  type ConfirmationDetail,
  type ConfirmedCall,
} from '../../tools/confirmation.js';
import { planConfirmed, planForConfirmation } from '../guarded-change.js';
import { InventoryInputError } from './errors.js';
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

// ========== rendering ==========

function stockNote(attendance: AppointmentState['attendance']): string {
  return attendance === 'arrived'
    ? 'The appointment is marked arrived, so these consumables are taken from stock.'
    : `The appointment is ${attendance === 'unknown' ? 'in an unknown status' : `marked ${attendance.replace('_', '-')}`}, so these consumables wait: they are taken from stock only once it is marked arrived.`;
}

function lineText(line: ConsumableLine, currency: string | null): string {
  return `product ${line.product_id}: ${quantity(line.quantity, line.unit)} from inventory ${line.inventory_id}, cost ${money(line.cost, currency)}`;
}

function consumablesUntrusted(
  blocks: readonly AppointmentServiceConsumables[],
  changes: readonly ConsumableChange[] = []
): UntrustedField[] {
  const fields: UntrustedField[] = [];
  const seen = new Set<string>();
  const once = (label: string, value: string | null) => {
    if (seen.has(label)) return;
    seen.add(label);
    fields.push({ label, value });
  };
  for (const b of blocks) {
    if (b.bill_of_materials)
      once(
        `Bill of Materials ${b.bill_of_materials.id} title`,
        b.bill_of_materials.title
      );
    for (const l of b.lines)
      once(`product ${l.product_id} title`, l.product_title);
  }
  // A removed product is no longer on the saved list; its title still names it.
  for (const c of changes) once(`product ${c.product_id} title`, c.title);
  return fields;
}

function serviceBlockLines(
  block: AppointmentServiceConsumables,
  currency: string | null
): string[] {
  return [
    `- service ${block.service_id}: ${block.lines.length} consumable(s)${block.bill_of_materials ? `, filled from Bill of Materials ${block.bill_of_materials.id}` : ''}`,
    ...block.lines.map(
      (l) => `  - line ${l.line_id ?? '?'}: ${lineText(l, currency)}`
    ),
  ];
}

/** Other appointments of the visit that carry the same service. */
function sameServiceElsewhere(
  blocks: readonly AppointmentServiceConsumables[],
  appointmentId: number,
  serviceId: number
): number[] {
  return blocks
    .filter(
      (b) => b.appointment_id !== appointmentId && b.service_id === serviceId
    )
    .map((b) => b.appointment_id);
}

// ========== read ==========

export async function getConsumables(
  client: AltegioClient,
  input: { location_id: number; appointment_id: number }
): Promise<InventoryResult> {
  const api = inventoryApi(client);
  const [blocks, appointment, currency] = await Promise.all([
    api.getAppointmentConsumables(input.location_id, input.appointment_id),
    api.getAppointment(input.location_id, input.appointment_id),
    locationCurrency(client, input.location_id),
  ]);
  const own = blocks.filter((b) => b.appointment_id === input.appointment_id);
  const others = [
    ...new Set(
      blocks
        .filter((b) => b.appointment_id !== input.appointment_id)
        .map((b) => b.appointment_id)
    ),
  ];
  const clashes = own
    .map((b) => ({
      service_id: b.service_id,
      appointment_ids: sameServiceElsewhere(
        blocks,
        input.appointment_id,
        b.service_id
      ),
    }))
    .filter((c) => c.appointment_ids.length > 0);

  const lines = [
    `Consumables of appointment ${input.appointment_id} at location ${input.location_id}, per service (quantities per one service, cost at cost price):`,
    ...own.flatMap((b) => serviceBlockLines(b, currency)),
  ];
  if (own.length === 0)
    lines.push('The appointment has no services with consumables.');
  lines.push(stockNote(appointment.attendance));
  for (const c of clashes)
    lines.push(
      `Service ${c.service_id} is also on appointment(s) ${c.appointment_ids.join(', ')} of the same visit, so appointments_set_consumables refuses to change it; edit it in the Altegio appointment window.`
    );
  if (others.length)
    lines.push(`Other appointments of the same visit: ${others.join(', ')}.`);

  return {
    text: withUntrustedBlock(lines.join('\n'), consumablesUntrusted(own), {
      maxChars: FIELD_MAX_CHARS,
    }),
    structuredContent: {
      location_id: input.location_id,
      appointment_id: input.appointment_id,
      attendance: appointment.attendance,
      stock_moved: appointment.attendance === 'arrived',
      currency,
      services: own,
      other_appointment_ids: others,
      services_on_other_appointments: clashes,
    },
  };
}

// ========== write ==========

export interface ConsumableLineInput extends ProductRef {
  quantity: number;
  inventory_id?: number;
}

export interface SetConsumablesInput {
  location_id: number;
  appointment_id: number;
  service_id: number;
  consumables: ConsumableLineInput[];
  replace: boolean;
}

interface PlannedConsumable extends ConsumableWrite {
  unit: string | null;
  product_title: string | null;
}

/** One line of the before → after of a service's list. */
interface ConsumableChange {
  kind: 'add' | 'change' | 'remove';
  product_id: number;
  inventory_id: number;
  /** The product title — other people's text, see `changeText`. */
  title: string | null;
  from: string | null;
  to: string | null;
}

/**
 * A change as one line. The confirmation names the product by title, cleaned
 * in place, because a person approves it; the result keeps titles out of our
 * lines and fences them (`consumablesUntrusted`).
 */
function changeText(c: ConsumableChange, withTitle: boolean): string {
  const label = `product ${c.product_id}${withTitle && c.title ? ` ${c.title}` : ''} (inventory ${c.inventory_id})`;
  if (c.kind === 'add') return `- add ${label}: ${c.to}`;
  if (c.kind === 'remove') return `- remove ${label}: ${c.from} → none`;
  return `- change ${label}: ${c.from} → ${c.to}`;
}

interface ConsumablesPlan {
  appointment: AppointmentState;
  before: ConsumableLine[];
  after: PlannedConsumable[];
  /** The before → after; empty when nothing changes. */
  changes: ConsumableChange[];
  /** Lines kept with the same quantity. */
  unchanged: number;
  bill_of_materials: AppointmentServiceConsumables['bill_of_materials'];
  /** `stateVersion` of what the confirmation shows; see the module note. */
  version: string;
}

const key = (productId: number, inventoryId: number) =>
  `${productId}:${inventoryId}`;

async function planConsumables(
  client: AltegioClient,
  input: SetConsumablesInput
): Promise<ConsumablesPlan> {
  const api = inventoryApi(client);
  const [blocks, appointment] = await Promise.all([
    api.getAppointmentConsumables(input.location_id, input.appointment_id),
    api.getAppointment(input.location_id, input.appointment_id),
  ]);
  const target = blocks.find(
    (b) =>
      b.appointment_id === input.appointment_id &&
      b.service_id === input.service_id
  );
  if (!target) {
    const services = blocks
      .filter((b) => b.appointment_id === input.appointment_id)
      .map((b) => b.service_id);
    throw new InventoryInputError(
      `Service ${input.service_id} is not on appointment ${input.appointment_id}; its services are ${services.join(', ') || 'none'} (appointments_get_consumables lists them).`
    );
  }
  const clash = sameServiceElsewhere(
    blocks,
    input.appointment_id,
    input.service_id
  );
  if (clash.length) {
    throw new InventoryInputError(
      `Service ${input.service_id} is also on appointment(s) ${clash.join(', ')} of the same visit. Altegio would store these consumables on each of them, so this tool does not change them; edit them in the Altegio appointment window.`
    );
  }

  const products = productsApi(client);
  const before = target.lines;
  const resolved: Product[] = await mapWithConcurrency(
    input.consumables.map((line, index) => ({ line, index })),
    8,
    ({ line, index }) =>
      line.product_id !== undefined &&
      line.product === undefined &&
      before.some((b) => b.product_id === line.product_id)
        ? Promise.resolve({ id: line.product_id } as Product)
        : resolveProduct(
            products,
            input.location_id,
            line,
            `consumables[${index}]`
          )
  );

  // Inventories and units are read only when a new product needs them.
  let inventories: Inventory[] | undefined;
  const loadInventories = async () =>
    (inventories ??= await api.listInventories(input.location_id));
  let units: Map<number, ProductUnit> | undefined;
  const loadUnits = async () =>
    (units ??= new Map(
      (await products.listUnits(input.location_id).catch(() => [])).map((u) => [
        u.id,
        u,
      ])
    ));

  const after: PlannedConsumable[] = input.replace
    ? []
    : before.map((b) => ({
        line_id: b.line_id ?? undefined,
        product_id: b.product_id,
        inventory_id: b.inventory_id,
        quantity: b.quantity,
        unit: b.unit,
        product_title: b.product_title,
      }));
  const touched = new Set<string>();

  for (const [index, line] of input.consumables.entries()) {
    const product = resolved[index]!;
    const where = `consumables[${index}] (product ${product.id})`;
    if (product.loyalty_kind)
      throw new InventoryInputError(
        `${where} sells a membership or a gift card, not a consumable.`
      );
    const existing = before.filter((b) => b.product_id === product.id);
    let inventoryId = line.inventory_id;
    if (inventoryId === undefined) {
      if (existing.length > 1)
        throw new InventoryInputError(
          `${where} is recorded from inventories ${existing.map((b) => b.inventory_id).join(', ')}; pass inventory_id to say which line.`
        );
      inventoryId =
        existing[0]?.inventory_id ??
        defaultInventory(await loadInventories(), 'consumables', where).id;
    } else if (!existing.some((b) => b.inventory_id === inventoryId)) {
      knownInventory(await loadInventories(), inventoryId, input.location_id);
    }
    const k = key(product.id, inventoryId);
    if (touched.has(k))
      throw new InventoryInputError(
        `${where} is listed twice for inventory ${inventoryId}; give it once.`
      );
    touched.add(k);

    const index_ = after.findIndex(
      (a) => key(a.product_id, a.inventory_id) === k
    );
    if (line.quantity === 0) {
      if (index_ >= 0) after.splice(index_, 1);
      continue;
    }
    if (index_ >= 0) {
      after[index_] = { ...after[index_]!, quantity: line.quantity };
      continue;
    }
    // Under `replace` a line the caller keeps is re-sent with its line id.
    const known = before.find((b) => key(b.product_id, b.inventory_id) === k);
    const sameProduct = known ?? existing[0];
    const unit =
      sameProduct?.unit ??
      (typeof product.consumable_unit_id === 'number'
        ? ((await loadUnits()).get(product.consumable_unit_id)?.short_title ??
          null)
        : null);
    after.push({
      ...(known?.line_id ? { line_id: known.line_id } : {}),
      product_id: product.id,
      inventory_id: inventoryId,
      quantity: line.quantity,
      unit,
      product_title: sameProduct?.product_title ?? product.title ?? null,
    });
  }

  const changes: ConsumableChange[] = [];
  let unchanged = 0;
  for (const b of before) {
    const now = after.find(
      (a) =>
        key(a.product_id, a.inventory_id) === key(b.product_id, b.inventory_id)
    );
    const base = {
      product_id: b.product_id,
      inventory_id: b.inventory_id,
      title: b.product_title,
      from: quantity(b.quantity, b.unit),
    };
    if (!now) changes.push({ ...base, kind: 'remove', to: null });
    else if (round2(now.quantity) !== round2(b.quantity))
      changes.push({
        ...base,
        kind: 'change',
        to: quantity(now.quantity, b.unit),
      });
    else unchanged += 1;
  }
  for (const a of after) {
    if (
      !before.some(
        (b) =>
          key(b.product_id, b.inventory_id) ===
          key(a.product_id, a.inventory_id)
      )
    )
      changes.push({
        kind: 'add',
        product_id: a.product_id,
        inventory_id: a.inventory_id,
        title: a.product_title,
        from: null,
        to: quantity(a.quantity, a.unit),
      });
  }
  const shape = (
    lines: readonly Pick<
      ConsumableWrite,
      'product_id' | 'inventory_id' | 'quantity'
    >[]
  ) =>
    lines
      .map((l) => `${key(l.product_id, l.inventory_id)}:${round2(l.quantity)}`)
      .sort();
  return {
    appointment,
    before,
    after,
    changes,
    unchanged,
    bill_of_materials: target.bill_of_materials,
    version: stateVersion({
      attendance: appointment.attendance,
      bill_of_materials: target.bill_of_materials?.id ?? null,
      before: shape(before),
      after: shape(after),
    }),
  };
}

/** The confirmation detail: the before/after of the service's list. */
export async function describeConsumablesChange(
  client: AltegioClient,
  input: SetConsumablesInput
): Promise<ConfirmationDetail> {
  const plan = await planForConfirmation(
    () => planConsumables(client, input),
    InventoryInputError
  );
  if (plan.changes.length === 0)
    throw new ConfirmationRefusal(
      `the consumables of service ${input.service_id} on appointment ${input.appointment_id} already match; there is nothing to change.`
    );
  return {
    text: [
      'Changes (quantities per one service):',
      ...plan.changes.map((c) => changeText(c, true)),
      `${plan.unchanged} other line(s) stay as they are; ${plan.after.length} line(s) in all afterwards.`,
      plan.bill_of_materials
        ? `The lines were filled from Bill of Materials ${plan.bill_of_materials.id}; after this change they no longer follow it.`
        : '',
      stockNote(plan.appointment.attendance),
    ]
      .filter(Boolean)
      .join('\n'),
    version: plan.version,
  };
}

export async function setConsumables(
  client: AltegioClient,
  input: SetConsumablesInput,
  confirmation?: ConfirmedCall
): Promise<InventoryResult> {
  const plan = await planConfirmed(
    () => planConsumables(client, input),
    confirmation,
    () =>
      new InventoryInputError(
        `Nothing was changed: the consumables of service ${input.service_id} on appointment ${input.appointment_id} (or its attendance) changed after the confirmation was shown, so this call would no longer make the change approved. Read them again with appointments_get_consumables, then repeat the call without confirmation_token to confirm the change against what they hold now.`
      )
  );
  const currency = await locationCurrency(client, input.location_id);
  if (plan.changes.length === 0) {
    return {
      text: `Nothing changed: the consumables of service ${input.service_id} on appointment ${input.appointment_id} already match.`,
      structuredContent: {
        location_id: input.location_id,
        appointment_id: input.appointment_id,
        service_id: input.service_id,
        changed: false,
        attendance: plan.appointment.attendance,
        stock_moved: plan.appointment.attendance === 'arrived',
        currency,
        lines: plan.before,
      },
    };
  }
  const blocks = await inventoryApi(client).setAppointmentServiceConsumables(
    input.location_id,
    input.appointment_id,
    input.service_id,
    plan.after.map((a) => ({
      ...(a.line_id ? { line_id: a.line_id } : {}),
      product_id: a.product_id,
      inventory_id: a.inventory_id,
      quantity: a.quantity,
    })),
    writeOptions(confirmation)
  );
  const saved = blocks.find(
    (b) =>
      b.appointment_id === input.appointment_id &&
      b.service_id === input.service_id
  );
  const lines = saved?.lines ?? [];
  return {
    text: withUntrustedBlock(
      [
        `Saved the consumables of service ${input.service_id} on appointment ${input.appointment_id} (quantities per one service, cost at cost price):`,
        ...plan.changes.map((c) => changeText(c, false)),
        lines.length > 0
          ? `Now ${lines.length} line(s); every line has a new line id:`
          : 'No consumables remain on this service.',
        ...lines.map(
          (l) => `  - line ${l.line_id ?? '?'}: ${lineText(l, currency)}`
        ),
        ...(plan.bill_of_materials
          ? [
              `The service no longer follows Bill of Materials ${plan.bill_of_materials.id} on this appointment.`,
            ]
          : []),
        stockNote(plan.appointment.attendance),
      ].join('\n'),
      consumablesUntrusted(saved ? [saved] : [], plan.changes),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: {
      location_id: input.location_id,
      appointment_id: input.appointment_id,
      service_id: input.service_id,
      changed: true,
      attendance: plan.appointment.attendance,
      stock_moved: plan.appointment.attendance === 'arrived',
      currency,
      lines,
    },
  };
}
