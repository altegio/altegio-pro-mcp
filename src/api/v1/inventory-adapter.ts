/**
 * V1 adapter for the `InventoryApi` port.
 *
 * V2 has no inventory, inventory-operation, Bill of Materials, Supplier or
 * appointment-consumables operation (checked against the B2B V2 spec,
 * 2026-10-19), so these calls run on V1, on the URLs the spec documents. The
 * model never learns the wire vocabulary: `storage`, `good`,
 * `goods_transactions`, `technological_card`, `record`, `master`, `type_id`,
 * `for_service` and `operation_unit_type` stop here.
 *
 * Contract details verified against the backend (biz.erp, 2026-10-19/20;
 * the inventory operation spec was corrected to match in
 * biz.erp.api.docs#149):
 *
 * - `POST /storage_operations/operation/{id}` reads `type_id`, `storage_id`,
 *   `master_id` (the spec's canonical `team_member_id` is aliased to it),
 *   `client.id`, `date` (`Y-m-d H:i:s`, location time; any other format
 *   silently becomes "now"), `document.comment` and `goods_transactions[]`.
 *   Only types 1, 3 and 4 are accepted (2,
 *   consumption, and 5, transfer, are refused with 422: the document accepts
 *   1/3/4/5/6, the operation 1/2/3/4), a team member is mandatory, a date
 *   more than five minutes ahead is refused, and the document comment
 *   overwrites every line's comment. Only a sale keeps the team member and
 *   client on its lines; a receipt keeps the Supplier.
 *   Without `paid` + `account_id` no financial transaction is created. The
 *   answer lists the document and its lines as `goods_transactions`.
 * - Inside `goods_transactions[]` the legacy `good_id` is what the DTO reads;
 *   a line counts in the sale unit unless `unit_id` names the consumable unit
 *   (the operation's unit type follows from it), and
 *   `cost` is stored as sent, so the use case computes it.
 * - `DELETE /storage_operations/documents/{id}/{doc}` soft-deletes the
 *   document and its product lines (the stock comes back) and leaves any
 *   financial transaction of the document in place. It resolves only
 *   inventory-operation documents: a visit's product sale and an appointment's
 *   consumables are 404 there.
 * - `GET /technological_cards/record_consumables/{id}/{record}` returns one
 *   block per appointment of the whole visit. Quantities and costs are per one
 *   service; the backend multiplies by the service count when it stores them.
 * - `PUT …/consumables/{id}/{record}/{service}` replaces that service's list:
 *   every stored line is recreated with a new id and an omitted one is
 *   deleted. The backend matches blocks by service only, so a second
 *   appointment of the visit with the same service receives the same lines
 *   (the use case refuses that case). It also detaches the Bill of Materials
 *   from that service. `price` is ignored: the cost is recomputed from the
 *   product's cost price.
 * - Consumables stored on an appointment that is not marked arrived are held
 *   as pending lines; they move stock when the attendance becomes arrived and
 *   stop moving it when it changes away from arrived.
 * - V1 has no idempotency header, so the write methods ignore the
 *   `idempotency_key` of their `WriteOptions` (`../write-options.ts`).
 */
import {
  httpFromClient,
  queryString,
  type AltegioHttp,
} from '../altegio-http.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import {
  mapInventoryHttpError,
  type InventoryErrorHints,
} from '../../capabilities/inventory/errors.js';
import type {
  AppointmentAttendance,
  AppointmentServiceConsumables,
  AppointmentState,
  BillOfMaterials,
  ConsumableLine,
  ConsumableWrite,
  CreatedOperation,
  Inventory,
  InventoryApi,
  InventoryDocument,
  InventoryMovement,
  InventoryMovementKind,
  InventoryOperationKind,
  MovementQuery,
  OperationWrite,
  Supplier,
  SupplierType,
} from '../inventory-api.js';

// ========== wire vocabulary ==========

const KIND_TO_WIRE: Record<InventoryOperationKind, number> = {
  sale: 1,
  receipt: 3,
  write_off: 4,
};

const KIND_FROM_WIRE: Record<number, InventoryMovementKind> = {
  1: 'sale',
  2: 'consumption',
  3: 'receipt',
  4: 'write_off',
  5: 'transfer',
};

const SUPPLIER_TYPE_FROM_WIRE: Record<number, SupplierType> = {
  0: 'legal_entity',
  1: 'sole_proprietor',
  2: 'individual',
};

/** V1 attendance codes of an appointment. */
const ATTENDANCE_FROM_WIRE: Record<number, AppointmentAttendance> = {
  [-1]: 'no_show',
  0: 'waiting',
  1: 'arrived',
  2: 'confirmed',
};

// ========== value helpers ==========

type Row = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type QueryValue = string | number | undefined;

function asRow(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter(
        (v): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
      )
    : [];
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A positive integer id, or null for 0, empty or a non-id. */
function id(value: unknown): number | null {
  const n = num(value);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** `true` for 1, "1" and true. */
function flag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

/**
 * `2026-12-05T16:30:00+0400` → `2026-12-05T16:30:00+04:00`. A line in the
 * create answer carries location time instead (`2026-12-05 16:30:00`), which
 * becomes `2026-12-05T16:30:00`, with no offset.
 */
function rfc3339(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  return raw.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

/** `2026-12-05 14:30:00` → `2026-12-05T14:30:00`. */
function localDateTime(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  return raw.replace(' ', 'T');
}

async function safeJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

// ========== mapping ==========

function inventoryFromWire(row: Row): Inventory {
  return {
    id: id(row.id) ?? 0,
    title: text(row.title),
    for_sale: flag(row.for_sale),
    for_consumables: flag(row.for_service),
    comment: text(row.comment),
  };
}

function kindFromWire(value: unknown): InventoryMovementKind {
  const n = num(value);
  return (n !== null && KIND_FROM_WIRE[n]) || 'other';
}

function movementFromWire(row: Row): InventoryMovement {
  const amount = num(row.amount);
  const good = asRow(row.good);
  const storage = asRow(row.storage);
  return {
    id: id(row.id) ?? 0,
    document_id: id(row.document_id),
    kind: kindFromWire(row.type_id),
    date: rfc3339(row.create_date),
    product_id: id(good.id ?? row.good_id),
    product_title: text(good.title),
    quantity: amount === null ? null : Math.abs(amount),
    direction:
      amount === null || amount === 0 ? null : amount < 0 ? 'out' : 'in',
    unit: text(asRow(row.unit).short_title) ?? text(asRow(row.unit).title),
    unit_price: num(row.cost_per_unit),
    discount_percent: num(row.discount),
    total: num(row.cost),
    inventory_id: id(storage.id ?? row.storage_id),
    inventory_title: text(storage.title),
    team_member_id: id(asRow(row.master).id ?? row.master_id),
    client_id: id(asRow(row.client).id ?? row.client_id),
    supplier_id: id(asRow(row.supplier).id ?? row.supplier_id),
    appointment_id: id(row.record_id),
    service_id: id(asRow(row.service).id ?? row.service_id),
    comment: text(row.comment),
  };
}

function documentFromWire(row: Row): InventoryDocument {
  const storage = asRow(row.storage);
  return {
    id: id(row.id) ?? 0,
    kind: kindFromWire(row.type_id),
    number: id(row.number),
    inventory_id: id(row.storage_id ?? storage.id),
    inventory_title: text(storage.title),
    date_local: localDateTime(row.create_date),
    comment: text(row.comment),
  };
}

function supplierFromWire(row: Row): Supplier {
  const type = num(row.type_id);
  return {
    id: id(row.id) ?? 0,
    title: text(row.title),
    type: (type !== null && SUPPLIER_TYPE_FROM_WIRE[type]) || 'unknown',
  };
}

function consumableLineFromWire(row: Row, lineId: unknown): ConsumableLine {
  const good = asRow(row.good);
  return {
    line_id: id(lineId),
    product_id: id(row.good_id ?? good.id) ?? 0,
    product_title: text(good.title),
    inventory_id: id(row.storage_id) ?? 0,
    quantity: num(row.amount) ?? 0,
    unit: text(good.unit),
    cost: num(row.price),
  };
}

function billFromWire(row: Row): BillOfMaterials {
  return {
    id: id(row.id) ?? 0,
    title: text(row.title),
    lines: rows(row.technological_card_items).map((item) =>
      consumableLineFromWire(item, null)
    ),
  };
}

function consumablesFromWire(row: Row): AppointmentServiceConsumables {
  const bill = rows(row.technological_cards)[0];
  return {
    appointment_id: id(row.record_id) ?? 0,
    service_id: id(row.service_id) ?? 0,
    bill_of_materials: bill
      ? { id: id(bill.id) ?? 0, title: text(bill.title) }
      : null,
    lines: rows(row.consumables).map((line) =>
      consumableLineFromWire(line, line.goods_transaction_id)
    ),
  };
}

// ========== the adapter ==========

export class InventoryAdapter implements InventoryApi {
  constructor(private readonly http: AltegioHttp) {}

  static forClient(client: AltegioClient): InventoryAdapter {
    return new InventoryAdapter(httpFromClient(client));
  }

  private async call(
    path: string,
    context: string,
    options: {
      method?: Method;
      query?: Record<string, QueryValue>;
      body?: unknown;
      hints?: InventoryErrorHints;
    } = {}
  ): Promise<{ data: unknown; meta: Row }> {
    if (!this.http.isAuthenticated()) {
      throw mapInventoryHttpError(401, undefined, context);
    }
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await this.http.request(
      `${path}${options.query ? queryString(options.query) : ''}`,
      {
        method: options.method ?? 'GET',
        headers,
        ...(body !== undefined ? { body } : {}),
      }
    );
    const payload = await safeJson(response);
    if (!response.ok) {
      throw mapInventoryHttpError(
        response.status,
        payload,
        context,
        options.hints
      );
    }
    const envelope = asRow(payload);
    if (envelope.success === false) {
      throw mapInventoryHttpError(422, payload, context, options.hints);
    }
    return { data: envelope.data ?? null, meta: asRow(envelope.meta) };
  }

  async listInventories(locationId: number): Promise<Inventory[]> {
    const { data } = await this.call(
      `/storages/${locationId}`,
      `list the inventories of location ${locationId}`
    );
    return rows(data).map(inventoryFromWire);
  }

  async listMovements(
    locationId: number,
    query: MovementQuery
  ): Promise<InventoryMovement[]> {
    const { data } = await this.call(
      `/storages/transactions/${locationId}`,
      `list the inventory operations of location ${locationId}`,
      {
        query: {
          start_date: query.date_from,
          end_date: query.date_to,
          document_id: query.document_id,
          page: query.page,
          count: query.page_size,
        },
      }
    );
    return rows(data).map(movementFromWire);
  }

  async getDocument(
    locationId: number,
    documentId: number
  ): Promise<InventoryDocument> {
    const { data } = await this.call(
      `/storage_operations/documents/${locationId}/${documentId}`,
      `read document ${documentId} of location ${locationId}`,
      {
        hints: {
          notFound:
            'Take the document id from inventory_list_operations. Only inventory operation documents are found here: a product sale on a visit bill and the consumables of an appointment are not, and a deleted document is gone.',
        },
      }
    );
    return documentFromWire(asRow(data));
  }

  async deleteDocument(locationId: number, documentId: number): Promise<void> {
    await this.call(
      `/storage_operations/documents/${locationId}/${documentId}`,
      `delete document ${documentId} of location ${locationId}`,
      {
        method: 'DELETE',
        hints: {
          forbidden:
            'Deleting inventory operations is a separate access right at the location; ask the location owner for it.',
          notFound:
            'Take the document id from inventory_list_operations; a product sale on a visit bill and the consumables of an appointment cannot be deleted here.',
        },
      }
    );
  }

  async createOperation(
    locationId: number,
    operation: OperationWrite
  ): Promise<CreatedOperation> {
    const body: Row = {
      type_id: KIND_TO_WIRE[operation.kind],
      storage_id: operation.inventory_id,
      master_id: operation.team_member_id,
      ...(operation.date_local ? { date: operation.date_local } : {}),
      ...(operation.client_id ? { client: { id: operation.client_id } } : {}),
      document: { comment: operation.comment ?? '' },
      goods_transactions: operation.lines.map((line) => ({
        good_id: line.product_id,
        amount: line.quantity,
        unit_id: line.unit_id,
        cost_per_unit: line.unit_price,
        discount: line.discount_percent,
        cost: line.total,
        ...(operation.supplier_id
          ? { supplier_id: operation.supplier_id }
          : {}),
      })),
    };
    const { data } = await this.call(
      `/storage_operations/operation/${locationId}`,
      `record the ${operation.kind.replace('_', '-')} at location ${locationId}`,
      {
        method: 'POST',
        body,
        hints: {
          invalid:
            'Check that the team member works at the location and is not dismissed, that the date is not in the future, and that the inventory holds enough stock when the location forbids negative stock.',
          notFound:
            'Check the product ids with products_search, the inventory id with inventory_list and the team member id with team_members_list.',
        },
      }
    );
    const created = asRow(data);
    return {
      document: documentFromWire(asRow(created.document)),
      lines: rows(created.goods_transactions ?? created.transactions).map(
        movementFromWire
      ),
    };
  }

  async listSuppliers(locationId: number): Promise<Supplier[]> {
    const { data } = await this.call(
      `/references/suppliers/${locationId}`,
      `list the Suppliers and Partners of location ${locationId}`,
      {
        hints: {
          forbidden:
            'Suppliers and Partners need the Finances access rights at the location; ask the location owner for them.',
        },
      }
    );
    return rows(data).map(supplierFromWire);
  }

  async listBillsOfMaterials(
    locationId: number,
    query: { title?: string; page: number; page_size: number }
  ): Promise<BillOfMaterials[]> {
    const { data } = await this.call(
      `/technological_cards/${locationId}`,
      `list the Bills of Materials of location ${locationId}`,
      {
        query: {
          search: query.title,
          page: query.page,
          count: query.page_size,
        },
      }
    );
    return rows(data).map(billFromWire);
  }

  async getTeamMemberServiceBillOfMaterials(
    locationId: number,
    teamMemberId: number,
    serviceId: number
  ): Promise<BillOfMaterials | null> {
    const { data } = await this.call(
      `/technological_cards/default_for_staff_and_service/${locationId}/${teamMemberId}/${serviceId}`,
      `read the Bill of Materials of service ${serviceId} for team member ${teamMemberId}`,
      {
        hints: {
          notFound:
            'The team member may not provide the service (services_list shows who does), or one of the ids is wrong.',
        },
      }
    );
    const row = asRow(data);
    return id(row.id) === null ? null : billFromWire(row);
  }

  async getAppointment(
    locationId: number,
    appointmentId: number
  ): Promise<AppointmentState> {
    const { data } = await this.call(
      `/locations/${locationId}/appointments/${appointmentId}`,
      `read appointment ${appointmentId}`,
      {
        hints: {
          notFound:
            'Check the appointment id with appointments_list; a deleted appointment has no consumables.',
        },
      }
    );
    const row = asRow(data);
    const code = num(row.attendance ?? row.visit_attendance);
    return {
      id: id(row.id) ?? appointmentId,
      location_id: id(row.company_id),
      attendance: (code !== null && ATTENDANCE_FROM_WIRE[code]) || 'unknown',
      service_ids: rows(row.services)
        .map((service) => id(service.id))
        .filter((value): value is number => value !== null),
    };
  }

  async getAppointmentConsumables(
    locationId: number,
    appointmentId: number
  ): Promise<AppointmentServiceConsumables[]> {
    const { data } = await this.call(
      `/technological_cards/record_consumables/${locationId}/${appointmentId}`,
      `read the consumables of appointment ${appointmentId}`,
      {
        hints: {
          notFound:
            'Check the appointment id with appointments_list; a deleted appointment has no consumables.',
          forbidden:
            'Reading consumables needs the Inventory access rights or the right to edit appointment consumables at the location; ask the location owner.',
        },
      }
    );
    return rows(data).map(consumablesFromWire);
  }

  async setAppointmentServiceConsumables(
    locationId: number,
    appointmentId: number,
    serviceId: number,
    lines: readonly ConsumableWrite[]
  ): Promise<AppointmentServiceConsumables[]> {
    const { data } = await this.call(
      `/technological_cards/record_consumables/consumables/${locationId}/${appointmentId}/${serviceId}`,
      `save the consumables of service ${serviceId} on appointment ${appointmentId}`,
      {
        method: 'PUT',
        body: {
          consumables: lines.map((line) => ({
            goods_transaction_id: line.line_id ?? 0,
            record_id: appointmentId,
            service_id: serviceId,
            good_id: line.product_id,
            storage_id: line.inventory_id,
            amount: line.quantity,
          })),
        },
        hints: {
          forbidden:
            'Changing consumables needs the right to edit appointment consumables at the location; ask the location owner.',
          invalid:
            'Check the product and inventory ids; when the location forbids negative stock, the inventory must hold enough of each product.',
        },
      }
    );
    return rows(data).map(consumablesFromWire);
  }
}
