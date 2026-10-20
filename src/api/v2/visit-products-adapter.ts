/**
 * V2 adapter for the `VisitProductsApi` port: a product sold on a visit, or
 * taken off it, saved the way the web app's appointment window saves it.
 *
 * The write is `POST /locations/{id}/attendance/appointments`, a replace: each
 * record sent replaces the whole appointment — start, team member, length,
 * resources, tags, color, visitor, custom fields, reminder settings,
 * assistants, services and products. So a sale, and its undo, is a
 * read-modify-write:
 *
 * 1. read the appointment with every include the echo needs
 *    (`GET /locations/{id}/attendances/record_{appointment_id}/appointments`),
 *    plus the V1 appointment for the visitor's type when it has a visitor;
 * 2. read it again right before the save and refuse when it changed since the
 *    read the sale was planned on (`version`, a hash of everything echoed);
 * 3. send the appointment back exactly as read, with the one product line
 *    added, raised, lowered or left out, `ignore_conflicts: false` and no
 *    instant notification;
 * 4. read it back and name anything that changed besides the product line and
 *    the status the caller asked for.
 *
 * Facts verified live on location 4564 (2026-10-20) and in the backend:
 *
 * - The backend re-saves the appointment itself whenever it judges it changed,
 *   and it judges almost every echo changed (an appointment without a visitor
 *   or without a color always compares as changed), so the echo must carry
 *   assistants too: an omitted list removes them.
 * - `date` is the stored wall time at the location; it equals the record's
 *   `timestamp` read as `Asia/Dubai` wall time, which is checked here.
 * - Product lines are echoed with `manual_cost` (after the line's discount,
 *   before loyalty); echoing `cost`, which includes loyalty, would apply a
 *   loyalty discount twice. A same-product raise keeps the line id.
 * - A line left out of the echo is soft-deleted and its product returns to the
 *   line's inventory; a lowered line keeps its id and returns the difference.
 * - Product lines of the visit's other appointments are re-sent by the backend
 *   from their post-loyalty totals. That keeps a line without a loyalty
 *   discount as it is and discounts one with a discount twice, so the read
 *   counts those lines per appointment, the use case refuses when there are
 *   any, and the read-back names any other appointment whose lines changed.
 * - A gift card or membership line is echoed with the number and the planned
 *   activation date its issued card reads back with, which keeps it as it is;
 *   one whose card does not read back cannot be echoed.
 * - A group event appointment is checked against its stored event: exactly
 *   one service line, the same service, the seat limits. The exact echo,
 *   seats included, passes them.
 * - Custom fields: every save of an appointment that is or becomes arrived is
 *   checked against the custom fields the location requires on arrival, and
 *   only the values in the request count, not the stored ones. So the echo
 *   carries the values read whenever the appointment is or becomes arrived;
 *   otherwise it sends `custom_field_values: null`, which keeps them. When the
 *   read is refused them, `null` is sent, and a location that requires such a
 *   field refuses the save. No route says which fields a location requires.
 * - The visitor (`comer`: the person, pet or vehicle the appointment is for)
 *   reads back from V2 as id and title only. The save needs
 *   `{id, title, slug, type}`, and an absent type means a person, which would
 *   turn a pet or a vehicle into one; the V1 appointment read carries the
 *   slug, which gives the type. `comer: null`, or an empty title, removes the
 *   visitor.
 * - Failures answer with the V1 envelope `{success:false, meta:{message}}`:
 *   403 for a status that cannot sell products or a missing right, 406 when the
 *   location forbids negative stock, 409 for a schedule conflict, 400 for a
 *   printed receipt or another refusal. The message follows `Accept-Language`, so
 *   the save asks for English and known refusals are recognized by their text. * - V2 has no idempotency header, so the writes ignore the `idempotency_key`
 *   of their `WriteOptions` (`../write-options.ts`).
 */
import { createHash } from 'node:crypto';
import type { AltegioHttp } from '../altegio-http.js';
import { httpFromClient } from '../altegio-http.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import type { AltegioApiError } from '../../utils/errors.js';
import {
  apiMessage,
  FinanceAccessError,
  FinanceInputError,
  FinanceNotFoundError,
  mapFinanceHttpError,
} from '../../capabilities/finance/errors.js';
import { upstreamDetail } from '../../tools/tool-result.js';
import { V1_SERVER_TIMEZONE, wallTime } from '../v1/server-time.js';
import { asPositiveId, asRecord, asText } from '../v1/wire-values.js';
import { sameMajor } from '../money.js';
import type {
  AddProductLineRequest,
  ProductLineSaveResult,
  ReduceProductLineRequest,
  AppointmentAttendance,
  AppointmentSale,
  ProductForSale,
  ProductStockForSale,
  VisitProductLine,
  VisitProductsApi,
  VisitServiceLine,
} from '../visit-products-api.js';
import {
  callJsonApi,
  IncludedIndex,
  primaryList,
  primaryOne,
  relationshipRefs,
  type JsonApiDocument,
  type JsonApiResource,
} from './jsonapi-http.js';

/** Every include the echo reads back, as the web app requests them. */
export const APPOINTMENT_INCLUDES = [
  'attendance_service_items',
  'attendance_service_items.assistants',
  'attendance_service_items.attendance_service_composite.composite_service',
  'attendance_good_items',
  'attendance_good_items.good',
  'attendance_good_items.marks',
  'attendance_good_items.loyalty_abonement',
  'attendance_good_items.loyalty_certificate',
  'resource_instances',
  'labels',
  'comer',
  'client_notification_settings',
  'duration_details',
  'client',
  'custom_field_values',
] as const;

/** The include a user without the right to see custom fields may be refused. */
const CUSTOM_FIELDS_INCLUDE = 'custom_field_values';

/** `attendance_status` of an arrived appointment. */
const ARRIVED = 1;

/** The visitor's type the save needs, by the slug the V1 read gives. */
const VISITOR_TYPES: Record<string, number> = { person: 1, pet: 2, vehicle: 3 };

function visitorType(slug: string | null): number | null {
  return slug !== null && Object.hasOwn(VISITOR_TYPES, slug)
    ? VISITOR_TYPES[slug]!
    : null;
}

// ========== wire reading ==========

type Attrs = Record<string, unknown>;

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function id(value: unknown): number | null {
  const n = num(value);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function attrs(resource: JsonApiResource | undefined | null): Attrs {
  return resource?.attributes ?? {};
}

const ATTENDANCE: Record<number, AppointmentAttendance> = {
  [-1]: 'no_show',
  0: 'waiting',
  1: 'arrived',
  2: 'confirmed',
};

/** One service line exactly as the save needs it back. */
interface WireService {
  id: number;
  service_id: number;
  quantity: number;
  cost_per_unit: number;
  manual_cost: number;
  discount_percent: number;
  cost: number | null;
  composite_service_id: number | null;
  /** On a combined service whose id did not read back. */
  composite_unresolved: boolean;
}

/** The visitor: the person, pet or vehicle the appointment is for. */
interface WireVisitor {
  id: number | null;
  title: string;
  /** `person`, `pet` or `vehicle`, from the V1 read; null until read. */
  slug: string | null;
}

/** One custom field value of the appointment, keyed by the field's code. */
interface WireCustomField {
  code: string;
  value: string | number;
}

interface WireAssistant {
  service_id: number;
  assistant_id: number;
  compensation_share_percent: number;
}

/** One product line exactly as the save needs it back. */
interface WireGood {
  id: number;
  good_id: number;
  unit_id: number;
  storage_id: number;
  staff_id: number;
  operation_unit_type: string;
  quantity: number;
  cost_per_unit: number;
  manual_cost: number;
  discount_percent: number;
  cost: number | null;
  marks: string[];
  loyalty_kind: 'gift_card' | 'membership' | null;
  /** The issued gift card's or membership's number, as read. */
  number: string | null;
  /** A membership's planned activation date, `YYYY-MM-DD`, as read. */
  planned_activation_date: string | null;
  /** A gift card or membership line whose issued instrument read back. */
  loyalty_readable: boolean;
}

/** One appointment exactly as read: everything the echo sends back. */
interface WireAppointment {
  id: number;
  external_id: string;
  date: string;
  timestamp: number | null;
  staff_id: number;
  client_id: number | null;
  visit_id: number | null;
  length: number;
  technical_break_duration: number | null;
  comment: string;
  custom_color: string;
  attendance_status: number;
  clients_count: number;
  activity_id: number;
  receipt_printed: boolean;
  resource_instance_ids: number[];
  label_ids: number[];
  comer: WireVisitor | null;
  /** Null when the read was refused them. */
  custom_fields: WireCustomField[] | null;
  notification: { sms: number; email: number } | null;
  services: WireService[];
  assistants: WireAssistant[];
  goods: WireGood[];
  client_discount_percent: number | null;
}

function serviceFromWire(
  item: JsonApiResource,
  included: IncludedIndex
): { service: WireService; assistants: WireAssistant[] } {
  const a = attrs(item);
  const serviceId = id(a.service_id) ?? 0;
  const compositeRef = relationshipRefs(
    item,
    'attendance_service_composite'
  )[0];
  const composite = compositeRef
    ? included.get(compositeRef.type, compositeRef.id)
    : undefined;
  const compositeServiceRef = composite
    ? relationshipRefs(composite, 'composite_service')[0]
    : undefined;
  const onComposite =
    id(a.attendance_service_composite_id) !== null ||
    compositeRef !== undefined;
  const compositeServiceId = compositeServiceRef
    ? id(compositeServiceRef.id)
    : null;
  const assistants = relationshipRefs(item, 'assistants')
    .map((ref) => attrs(included.get(ref.type, ref.id)))
    .map((x) => ({
      service_id: serviceId,
      assistant_id: id(x.assistant_id) ?? 0,
      compensation_share_percent: num(x.compensation_share_percent) ?? 0,
    }));
  return {
    service: {
      id: id(item.id) ?? 0,
      service_id: serviceId,
      quantity: num(a.quantity) ?? 0,
      cost_per_unit: num(a.cost_per_unit) ?? 0,
      manual_cost: num(a.manual_cost) ?? 0,
      discount_percent: num(a.discount_percent) ?? 0,
      cost: num(a.cost),
      composite_service_id: compositeServiceId,
      composite_unresolved: onComposite && compositeServiceId === null,
    },
    assistants,
  };
}

function goodFromWire(
  item: JsonApiResource,
  included: IncludedIndex
): WireGood {
  const a = attrs(item);
  const product = relationshipRefs(item, 'good')[0];
  const p = product ? attrs(included.get(product.type, product.id)) : {};
  const issued = (name: string) => relationshipRefs(item, name).length > 0;
  const instrument = (name: string) => {
    const ref = relationshipRefs(item, name)[0];
    return ref ? included.get(ref.type, ref.id) : undefined;
  };
  const membership = instrument('loyalty_abonement');
  const held = membership ?? instrument('loyalty_certificate');
  const loyalty: WireGood['loyalty_kind'] =
    issued('loyalty_abonement') || id(p.loyalty_abonement_type_id) !== null
      ? 'membership'
      : issued('loyalty_certificate') ||
          id(p.loyalty_certificate_type_id) !== null
        ? 'gift_card'
        : null;
  return {
    id: id(item.id) ?? 0,
    good_id: id(a.good_id) ?? 0,
    unit_id: id(a.unit_id) ?? 0,
    storage_id: id(a.storage_id) ?? 0,
    staff_id: id(a.staff_id) ?? id(a.master_id) ?? 0,
    operation_unit_type:
      str(a.operation_type_slug) || str(a.operation_unit_type) || 'sale',
    quantity: num(a.quantity) ?? 0,
    cost_per_unit: num(a.cost_per_unit) ?? 0,
    manual_cost: num(a.manual_cost) ?? 0,
    discount_percent: num(a.discount_percent) ?? 0,
    cost: num(a.cost),
    marks: relationshipRefs(item, 'marks')
      .map((ref) => str(attrs(included.get(ref.type, ref.id)).mark))
      .filter((mark) => mark !== ''),
    loyalty_kind: loyalty,
    number: held ? str(attrs(held).number) || null : null,
    planned_activation_date: membership
      ? str(attrs(membership).planned_activation_date) || null
      : null,
    loyalty_readable: loyalty === null || held !== undefined,
  };
}

/**
 * The appointment's custom field values, or null when the read did not carry
 * them all (the include was refused, or a value did not side-load).
 */
function customFieldsFromWire(
  record: JsonApiResource,
  included: IncludedIndex
): WireCustomField[] | null {
  if (record.relationships?.[CUSTOM_FIELDS_INCLUDE] === undefined) return null;
  const values: WireCustomField[] = [];
  for (const ref of relationshipRefs(record, CUSTOM_FIELDS_INCLUDE)) {
    const f = attrs(included.get(ref.type, ref.id));
    const code = str(f.slug) || str(f.code);
    if (code === '') return null;
    values.push({
      code,
      value:
        typeof f.value === 'number' && Number.isFinite(f.value)
          ? f.value
          : str(f.value),
    });
  }
  return values;
}

function appointmentFromWire(
  record: JsonApiResource,
  included: IncludedIndex
): WireAppointment {
  const a = attrs(record);
  const linked = (name: string) =>
    relationshipRefs(record, name)
      .map((ref) => included.get(ref.type, ref.id))
      .filter((r): r is JsonApiResource => r !== undefined);
  const services = linked('attendance_service_items').map((item) =>
    serviceFromWire(item, included)
  );
  const duration = attrs(linked('duration_details')[0]);
  const notification = linked('client_notification_settings')[0];
  const comer = linked('comer')[0];
  const client = attrs(linked('client')[0]);
  return {
    id: id(record.id) ?? 0,
    external_id: str(a.external_id),
    date: str(a.date),
    timestamp: num(a.timestamp),
    staff_id: id(a.staff_id) ?? id(a.master_id) ?? 0,
    client_id: id(a.client_id),
    visit_id: id(a.visit_id),
    length: num(a.length) ?? num(a.duration) ?? 0,
    technical_break_duration: num(duration.technical_break_duration),
    comment: str(a.comment),
    custom_color: str(a.custom_color),
    attendance_status: num(a.attendance_status) ?? num(a.attendance) ?? 0,
    clients_count: num(a.clients_count) ?? 1,
    activity_id: num(a.activity_id) ?? 0,
    receipt_printed: a.is_sale_bill_printed === true,
    resource_instance_ids: relationshipRefs(record, 'resource_instances')
      .map((ref) => id(ref.id))
      .filter((v): v is number => v !== null),
    label_ids: relationshipRefs(record, 'labels')
      .map((ref) => id(ref.id))
      .filter((v): v is number => v !== null),
    comer: comer
      ? { id: id(comer.id), title: str(attrs(comer).title), slug: null }
      : relationshipRefs(record, 'comer').length > 0
        ? { id: null, title: '', slug: null }
        : null,
    custom_fields: customFieldsFromWire(record, included),
    notification: notification
      ? {
          sms: num(attrs(notification).sms_hours_before_visit) ?? 0,
          email: num(attrs(notification).email_hours_before_visit) ?? 0,
        }
      : null,
    services: services.map((s) => s.service),
    assistants: services.flatMap((s) => s.assistants),
    goods: linked('attendance_good_items').map((item) =>
      goodFromWire(item, included)
    ),
    client_discount_percent: num(client.discount_percent),
  };
}

/** Why the appointment cannot be echoed exactly, or null. */
function unsupportedReason(w: WireAppointment): string | null {
  if (
    w.comer &&
    (w.comer.id === null || w.comer.title === '' || !visitorType(w.comer.slug))
  ) {
    return 'its visitor (the person, pet or vehicle the appointment is for) did not read back with its type';
  }
  if (w.goods.some((g) => !g.loyalty_readable)) {
    return 'a gift card or membership sold on it did not read back with its number';
  }
  if (w.services.some((s) => s.composite_unresolved)) {
    return 'one of its services is part of a combined service whose id does not read back';
  }
  if (w.notification === null || w.technical_break_duration === null) {
    return 'its reminder settings or technical break did not read back';
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(w.date)) {
    return 'its start time did not read back';
  }
  if (
    w.timestamp !== null &&
    wallTime(w.timestamp * 1000, V1_SERVER_TIMEZONE).replace(' ', 'T') !==
      w.date
  ) {
    return 'its start time reads back inconsistently';
  }
  return null;
}

function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 24);
}

/** Everything the save sends back, plus the state it depends on. */
function versionOf(target: WireAppointment, others: WireAppointment[]): string {
  return stableHash({
    target,
    others: others.map((o) => ({ id: o.id, goods: o.goods })),
  });
}

function lineFromWire(g: WireGood): VisitProductLine {
  return {
    id: g.id,
    product_id: g.good_id,
    quantity: g.quantity,
    unit_kind: g.operation_unit_type === 'sale' ? 'sale' : 'consumable',
    unit_id: g.unit_id,
    inventory_id: g.storage_id,
    team_member_id: g.staff_id,
    unit_price: g.cost_per_unit,
    discount_percent: g.discount_percent,
    amount: g.manual_cost,
    amount_after_loyalty: g.cost,
    loyalty_kind: g.loyalty_kind,
    marks: g.marks,
  };
}

function serviceLine(s: WireService): VisitServiceLine {
  return {
    id: s.id,
    service_id: s.service_id,
    quantity: s.quantity,
    unit_price: s.cost_per_unit,
    discount_percent: s.discount_percent,
    amount: s.manual_cost,
    amount_after_loyalty: s.cost,
  };
}

interface Snapshot {
  target: WireAppointment;
  others: WireAppointment[];
  sale: AppointmentSale;
}

/** The appointment and the other appointments of its visit, as read. */
function appointmentsOf(
  doc: JsonApiDocument | null,
  locationId: number,
  appointmentId: number
): { target: WireAppointment; others: WireAppointment[] } {
  const included = new IncludedIndex(doc?.included ?? []);
  const records = primaryList(doc).map((r) => appointmentFromWire(r, included));
  const target = records.find((r) => r.id === appointmentId);
  if (!target) {
    throw new FinanceNotFoundError(
      `Appointment ${appointmentId} was not found at location ${locationId}. Check the id with appointments_list.`
    );
  }
  return { target, others: records.filter((r) => r.id !== appointmentId) };
}

function snapshot(
  target: WireAppointment,
  others: WireAppointment[],
  locationId: number,
  appointmentId: number
): Snapshot {
  return {
    target,
    others,
    sale: {
      location_id: locationId,
      appointment_id: appointmentId,
      visit_id: target.visit_id,
      client_id: target.client_id,
      team_member_id: target.staff_id,
      attendance: ATTENDANCE[target.attendance_status] ?? 'unknown',
      group_event: target.activity_id > 0,
      receipt_printed:
        target.receipt_printed || others.some((other) => other.receipt_printed),
      start_local: target.date,
      duration_seconds: target.length,
      client_discount_percent: target.client_discount_percent,
      custom_fields_readable: target.custom_fields !== null,
      service_lines: target.services.map(serviceLine),
      product_lines: target.goods.map(lineFromWire),
      other_appointments: others.map((o) => ({
        appointment_id: o.id,
        product_lines: o.goods.length,
        loyalty_priced_lines: o.goods.filter(
          (g) => g.cost === null || !sameMajor(g.cost, g.manual_cost)
        ).length,
      })),
      unsupported: unsupportedReason(target),
      version: versionOf(target, others),
    },
  };
}

// ========== the echo ==========

function goodToWire(g: WireGood): Record<string, unknown> {
  return {
    id: g.id,
    good_id: g.good_id,
    unit_id: g.unit_id,
    storage_id: g.storage_id,
    staff_id: g.staff_id,
    operation_unit_type: g.operation_unit_type,
    number: g.number,
    planned_activation_date: g.planned_activation_date,
    marks: g.marks,
    quantity: g.quantity,
    cost_per_unit: g.cost_per_unit,
    manual_cost: g.manual_cost,
    discount_percent: g.discount_percent,
  };
}

/** The save body: the appointment as read, with the one line added or raised. */
export function saveBody(
  w: WireAppointment,
  request: AddProductLineRequest
): Record<string, unknown> {
  const { line } = request;
  const goods = w.goods.map((g) =>
    g.id === line.line_id
      ? {
          ...goodToWire(g),
          quantity: line.quantity,
          manual_cost: line.amount,
          marks: line.marks,
        }
      : goodToWire(g)
  );
  if (line.line_id === null) {
    goods.push({
      id: null,
      good_id: line.product_id,
      unit_id: line.unit_id,
      storage_id: line.inventory_id,
      staff_id: line.team_member_id,
      operation_unit_type: 'sale',
      number: null,
      planned_activation_date: null,
      marks: line.marks,
      quantity: line.quantity,
      cost_per_unit: line.unit_price,
      manual_cost: line.amount,
      discount_percent: line.discount_percent,
    });
  }
  return echoBody(w, goods, request.mark_arrived ? 1 : w.attendance_status);
}

/** The save body: the appointment as read, with one line lowered or left out. */
export function reductionBody(
  w: WireAppointment,
  request: ReduceProductLineRequest
): Record<string, unknown> {
  const goods = w.goods.flatMap((g) =>
    g.id !== request.line_id
      ? [goodToWire(g)]
      : request.quantity > 0
        ? [
            {
              ...goodToWire(g),
              quantity: request.quantity,
              manual_cost: request.amount,
            },
          ]
        : []
  );
  return echoBody(w, goods, w.attendance_status);
}

/**
 * The custom field values to send: those read, when the appointment is or
 * becomes arrived (the only saves checked against the fields the location
 * requires on arrival); otherwise null, which keeps the stored values. A
 * number goes as text: the save takes a value as text or as a fraction.
 */
function customFieldsToWire(
  w: WireAppointment,
  attendanceStatus: number
): Array<{ code: string; value: string }> | null {
  const checked =
    attendanceStatus === ARRIVED || w.attendance_status === ARRIVED;
  if (!checked || w.custom_fields === null) return null;
  const values = w.custom_fields
    .map((f) => ({ code: f.code, value: String(f.value) }))
    .filter((f) => f.value.trim() !== '');
  return values.length > 0 ? values : null;
}

function visitorToWire(w: WireAppointment): Record<string, unknown> | null {
  if (!w.comer) return null;
  return {
    id: w.comer.id,
    title: w.comer.title,
    slug: w.comer.slug,
    type: visitorType(w.comer.slug),
  };
}

/** The appointment as read, key by key, with these product lines and status. */
function echoBody(
  w: WireAppointment,
  goods: Array<Record<string, unknown>>,
  attendanceStatus: number
): Record<string, unknown> {
  return {
    ignore_conflicts: false,
    records: [
      {
        id: w.id,
        external_id: w.external_id,
        date: w.date,
        staff_id: w.staff_id,
        client_id: w.client_id,
        length: w.length,
        technical_break_duration: w.technical_break_duration,
        comment: w.comment,
        custom_color: w.custom_color,
        attendance_status: attendanceStatus,
        label_ids: w.label_ids,
        resource_instance_ids: w.resource_instance_ids,
        custom_field_values: customFieldsToWire(w, attendanceStatus),
        comer: visitorToWire(w),
        client_notification_settings: {
          sms_hours_before_visit: w.notification?.sms ?? 0,
          email_hours_before_visit: w.notification?.email ?? 0,
        },
        is_instant_sms_notification_required: false,
        clients_count: w.clients_count > 0 ? w.clients_count : 1,
        attendance_service_items: w.services.map((s) => ({
          id: s.id,
          service_id: s.service_id,
          quantity: s.quantity,
          cost_per_unit: s.cost_per_unit,
          manual_cost: s.manual_cost,
          discount_percent: s.discount_percent,
          composite_service_id: s.composite_service_id,
        })),
        assistants: w.assistants,
        attendance_good_items: goods,
      },
    ],
  };
}

/** What a product line must keep through a save of the appointment. */
function goodKey(g: WireGood): unknown[] {
  return [
    g.id,
    g.good_id,
    g.quantity,
    g.cost_per_unit,
    g.manual_cost,
    g.discount_percent,
    g.storage_id,
    g.staff_id,
    g.number,
    g.planned_activation_date,
  ];
}

/**
 * The other appointments of the visit whose product lines a save changed:
 * Altegio re-saves them from their amounts after loyalty, which keeps them
 * only where no loyalty discount applies.
 */
function otherAppointmentChanges(
  before: WireAppointment[],
  after: WireAppointment[]
): string[] {
  return before
    .filter((o) => {
      const now = after.find((a) => a.id === o.id);
      return (
        now !== undefined &&
        JSON.stringify(o.goods.map(goodKey)) !==
          JSON.stringify(now.goods.map(goodKey))
      );
    })
    .map((o) => `product visit items of appointment ${o.id} of the visit`);
}

/** What changed besides the product line and the requested status. */
function unexpectedChanges(
  before: WireAppointment,
  after: WireAppointment,
  expectedStatus: number,
  savedLineId: number | null
): string[] {
  const changes: string[] = [];
  const differs = (a: unknown, b: unknown) =>
    JSON.stringify(a) !== JSON.stringify(b);
  const check = (label: string, a: unknown, b: unknown) => {
    if (differs(a, b)) changes.push(label);
  };
  check(`start time (${before.date} → ${after.date})`, before.date, after.date);
  check(
    `team member (${before.staff_id} → ${after.staff_id})`,
    before.staff_id,
    after.staff_id
  );
  check('length', before.length, after.length);
  check(
    'technical break',
    before.technical_break_duration,
    after.technical_break_duration
  );
  check('client', before.client_id, after.client_id);
  check('visit', before.visit_id, after.visit_id);
  check(
    `status (${before.attendance_status} → ${after.attendance_status})`,
    expectedStatus,
    after.attendance_status
  );
  check('comment', before.comment, after.comment);
  check('color', before.custom_color, after.custom_color);
  check('clients count', before.clients_count, after.clients_count);
  const sorted = (ids: number[]) => [...ids].sort((x, y) => x - y);
  check(
    'resources',
    sorted(before.resource_instance_ids),
    sorted(after.resource_instance_ids)
  );
  check('tags', sorted(before.label_ids), sorted(after.label_ids));
  check('visitor', before.comer, after.comer);
  if (before.custom_fields !== null && after.custom_fields !== null) {
    const byCode = (fields: WireCustomField[]) =>
      [...fields].sort((x, y) => x.code.localeCompare(y.code));
    check(
      'custom fields',
      byCode(before.custom_fields),
      byCode(after.custom_fields)
    );
  }
  check('reminder settings', before.notification, after.notification);
  const serviceKey = (s: WireService) => [
    s.id,
    s.service_id,
    s.quantity,
    s.cost_per_unit,
    s.manual_cost,
    s.discount_percent,
  ];
  check(
    'services',
    before.services.map(serviceKey),
    after.services.map(serviceKey)
  );
  check('assistants', before.assistants, after.assistants);
  // The other product lines must keep their values; loyalty may change only
  // what the client pays (`cost`), which is not compared.
  const untouched = (g: WireGood) => g.id !== savedLineId;
  check(
    'other product visit items (a loyalty program may have re-priced them)',
    before.goods.filter(untouched).map(goodKey),
    after.goods
      .filter((g) => untouched(g) && before.goods.some((b) => b.id === g.id))
      .map(goodKey)
  );
  if (
    after.goods.filter(
      (g) => g.id !== savedLineId && !before.goods.some((b) => b.id === g.id)
    ).length > 0
  ) {
    changes.push('extra product visit items');
  }
  return changes;
}

// ========== the adapter ==========

const FORBIDDEN = {
  add: 'Altegio sells products only on an appointment marked arrived or confirmed, and the user needs the rights to create product sales in appointments (to edit them, for a quantity raise), within their day limits, and to edit arrived or fully paid appointments; locations_diagnose_access shows what the user may do.',
  reduce:
    'Altegio changes products only on an appointment marked arrived or confirmed, and the user needs the rights to edit and delete product sales in appointments, within their day limits, and to edit arrived or fully paid appointments; locations_diagnose_access shows what the user may do.',
};

/** The language the save's messages are asked in, so refusals can be recognized. */
const SAVE_LANGUAGE = 'en';

/**
 * Refusals of the save recognized by their English message (or by the message
 * key, which the backend returns when a text is missing). The first match
 * names the cause; the backend's message follows it as data.
 */
const KNOWN_REFUSALS: Array<{
  pattern: RegExp;
  cause: (customFieldsRead: boolean) => string;
}> = [
  {
    pattern: /mandatory.field/i,
    cause: (read) =>
      read
        ? 'the location requires an appointment custom field once the client has arrived, and it is empty on this appointment (the Altegio message quoted at the end names it). Fill it in on the appointment in Altegio, then retry.'
        : 'the location requires an appointment custom field once the client has arrived (the Altegio message quoted at the end names it), and this server could not send it back: the user lacks the right to view appointment custom fields, so their values could not be read. Make the change in Altegio, or ask for that right.',
  },
  {
    pattern: /\bonly one service\b|possible_one_service/i,
    cause: () =>
      'Altegio saves a group event appointment only with exactly one service.',
  },
  {
    pattern: /related.to.events|service.change.forbidden/i,
    cause: () =>
      'Altegio does not let the service of a group event appointment change.',
  },
  {
    pattern: /capacity|participants/i,
    cause: () =>
      'the group event has no room for the clients this appointment holds (its capacity, or its limit of extra participants per booking).',
  },
  {
    pattern: /gift.card|membership/i,
    cause: () =>
      'Altegio refused a gift card or membership sold on the visit: a missing or used number, a missing activation date, or an archived type (the Altegio message quoted at the end says which). Change it in Altegio.',
  },
  {
    pattern: /receipt has been printed|printed.check/i,
    cause: () =>
      'the visit’s receipt is printed, and Altegio refuses product changes until a return receipt is printed in Altegio.',
  },
  {
    pattern: /online.payment|prepayment/i,
    cause: () =>
      'the appointment waits for an online advance payment, and Altegio refuses changes while it does.',
  },
];

const COMMON_CAUSES =
  'Common causes: a printed receipt or a fiscal receipt being prepared, an appointment waiting for an online advance payment, an appointment custom field the location requires on arrival, and the rules of group events, gift cards and memberships.';

/** A 400 or 422 from the save, named by its cause when it is a known one. */
function saveRefusal(
  body: unknown,
  customFieldsRead: boolean
): FinanceInputError {
  const message = apiMessage(body);
  const known = message
    ? KNOWN_REFUSALS.find((r) => r.pattern.test(message))
    : undefined;
  const detail = upstreamDetail(message);
  const lead = known
    ? `Nothing was changed: ${known.cause(customFieldsRead)}`
    : `Nothing was changed: Altegio refused the save; the Altegio message quoted at the end names the cause. ${COMMON_CAUSES}`;
  return new FinanceInputError(detail ? `${lead} ${detail}` : lead);
}

/**
 * Maps a failed save; `kind` says whether a line was added or reduced, and
 * `customFieldsRead` whether the save could carry the custom field values.
 */
function saveErrorFor(kind: 'add' | 'reduce', customFieldsRead: boolean) {
  const elsewhere =
    kind === 'add'
      ? 'add the product in Altegio'
      : 'make the change in Altegio';
  return (status: number, body: unknown, context: string): AltegioApiError => {
    if (status === 406 && kind === 'add') {
      return new FinanceInputError(
        `Nothing was changed: the location forbids negative stock, and the inventory holds less of the product than this sale takes (${context}). Pick another inventory_id (products_search shows stock per inventory) or record a product receipt first.`
      );
    }
    if (status === 409) {
      return mapFinanceHttpError(status, body, context, {
        invalid: `Altegio reports a conflict for the appointment as it stands — a busy time slot, a team member who no longer provides one of its services, a busy resource or a deleted team member. Nothing was changed; ${elsewhere}, where the conflict can be reviewed.`,
      });
    }
    if (status === 400 || status === 422) {
      return saveRefusal(body, customFieldsRead);
    }
    return mapFinanceHttpError(status, body, context, {
      forbidden: FORBIDDEN[kind],
      notFound:
        'Check the appointment id with appointments_list; a deleted appointment cannot be changed.',
    });
  };
}

/** One guarded save: what to send and how to name it. */
interface GuardedSave {
  expected_version: string;
  /** The existing line the save changes, or null for a new line. */
  line_id: number | null;
  body: (target: WireAppointment) => Record<string, unknown>;
  kind: 'add' | 'reduce';
}

export class VisitProductsV2Adapter implements VisitProductsApi {
  constructor(private readonly http: AltegioHttp) {}

  static forClient(client: AltegioClient): VisitProductsV2Adapter {
    return new VisitProductsV2Adapter(httpFromClient(client));
  }

  private async readDocument(
    locationId: number,
    appointmentId: number,
    includes: readonly string[]
  ): Promise<JsonApiDocument | null> {
    return callJsonApi(
      this.http,
      `/locations/${locationId}/attendances/record_${appointmentId}/appointments`,
      {
        context: `read appointment ${appointmentId}`,
        query: { 'include[]': includes },
        mapError: (status, body, context) =>
          mapFinanceHttpError(status, body, context, {
            notFound:
              'Check the appointment id with appointments_list for this location.',
            forbidden:
              'The user needs the right to view appointments at this location; locations_diagnose_access shows what the user may do.',
          }),
      }
    );
  }

  /**
   * The visitor's slug from the V1 appointment read, the only read that
   * carries it; null when it does not read back for this visitor.
   */
  private async visitorSlug(
    locationId: number,
    appointmentId: number,
    visitorId: number
  ): Promise<string | null> {
    try {
      const response = await this.http.request(
        `/locations/${locationId}/appointments/${appointmentId}`,
        { method: 'GET' }
      );
      if (!response.ok) return null;
      const visitor = asRecord(
        asRecord(asRecord(await response.json()).data).comer
      );
      return asPositiveId(visitor.id) === visitorId
        ? asText(visitor.slug)
        : null;
    } catch {
      return null;
    }
  }

  private async read(
    locationId: number,
    appointmentId: number
  ): Promise<Snapshot> {
    let doc: JsonApiDocument | null;
    try {
      doc = await this.readDocument(
        locationId,
        appointmentId,
        APPOINTMENT_INCLUDES
      );
    } catch (error) {
      if (!(error instanceof FinanceAccessError)) throw error;
      // Other reads of the same values require the right to view appointment
      // custom fields; without them the rest still reads, and the save sends
      // none back.
      doc = await this.readDocument(
        locationId,
        appointmentId,
        APPOINTMENT_INCLUDES.filter((i) => i !== CUSTOM_FIELDS_INCLUDE)
      );
    }
    const { target, others } = appointmentsOf(doc, locationId, appointmentId);
    if (target.comer?.id) {
      target.comer.slug = await this.visitorSlug(
        locationId,
        appointmentId,
        target.comer.id
      );
    }
    return snapshot(target, others, locationId, appointmentId);
  }

  async getAppointmentSale(
    locationId: number,
    appointmentId: number
  ): Promise<AppointmentSale> {
    return (await this.read(locationId, appointmentId)).sale;
  }

  async getProductForSale(
    locationId: number,
    productId: number
  ): Promise<ProductForSale> {
    const doc = await callJsonApi(
      this.http,
      `/locations/${locationId}/products/${productId}`,
      {
        context: `read product ${productId}`,
        query: { 'include[]': ['storage_amounts', 'storage_amounts.storage'] },
        mapError: (status, body, context) =>
          mapFinanceHttpError(status, body, context, {
            notFound:
              'Check the product id with products_search; a deleted product cannot be sold.',
          }),
      }
    );
    const product = primaryOne(doc);
    if (!product) {
      throw new FinanceNotFoundError(
        `Product ${productId} was not found at location ${locationId}. Check the id with products_search.`
      );
    }
    const included = new IncludedIndex(doc?.included ?? []);
    const a = attrs(product);
    const stock = relationshipRefs(product, 'storage_amounts')
      .map((ref) => included.get(ref.type, ref.id))
      .filter((r): r is JsonApiResource => r !== undefined)
      .map((row): ProductStockForSale | null => {
        const s = attrs(row);
        const inventoryId = id(s.storage_id);
        if (inventoryId === null) return null;
        const storageRef = relationshipRefs(row, 'storage')[0];
        const storage = attrs(
          storageRef
            ? included.get(storageRef.type, storageRef.id)
            : included.get('good_storage', String(inventoryId))
        );
        return {
          inventory_id: inventoryId,
          for_sale: storage.is_for_sale === true,
          sort_weight: num(storage.weight),
          sale_quantity: num(s.sale_amount),
        };
      })
      .filter((s): s is ProductStockForSale => s !== null);
    return {
      id: id(product.id) ?? productId,
      title: typeof a.title === 'string' ? a.title : null,
      sale_price: num(a.cost),
      sale_unit_id: id(a.sale_unit_id),
      loyalty_kind:
        id(a.loyalty_abonement_type_id) !== null
          ? 'membership'
          : id(a.loyalty_certificate_type_id) !== null
            ? 'gift_card'
            : null,
      stock,
    };
  }

  /**
   * Read again right before the save, refuse if anything changed since the
   * plan's read (the save writes back everything read, so the change would be
   * overwritten), save, and read back.
   */
  private async guardedSave(
    locationId: number,
    appointmentId: number,
    plan: GuardedSave
  ): Promise<{ before: Snapshot; after: Snapshot }> {
    const before = await this.read(locationId, appointmentId);
    const elsewhere =
      plan.kind === 'add'
        ? 'Add the product in Altegio.'
        : 'Make the change in Altegio.';
    if (before.sale.version !== plan.expected_version) {
      throw new FinanceInputError(
        `Nothing was changed: appointment ${appointmentId} changed while the ${plan.kind === 'add' ? 'sale' : 'change'} was being prepared (its schedule, services, products or status). Read it again with visits_get and retry.`
      );
    }
    if (before.sale.unsupported) {
      throw new FinanceInputError(
        `Nothing was changed: appointment ${appointmentId} cannot be saved back exactly: ${before.sale.unsupported}. ${elsewhere}`
      );
    }
    if (
      plan.line_id !== null &&
      !before.target.goods.some((g) => g.id === plan.line_id)
    ) {
      throw new FinanceInputError(
        `Nothing was changed: visit item ${plan.line_id} is no longer on appointment ${appointmentId}.`
      );
    }

    await callJsonApi(
      this.http,
      `/locations/${locationId}/attendance/appointments`,
      {
        context: `save the product sale on appointment ${appointmentId}`,
        method: 'POST',
        headers: { 'Accept-Language': SAVE_LANGUAGE },
        body: plan.body(before.target),
        mapError: saveErrorFor(plan.kind, before.target.custom_fields !== null),
      }
    );

    return { before, after: await this.read(locationId, appointmentId) };
  }

  async addProductLine(
    locationId: number,
    appointmentId: number,
    request: AddProductLineRequest
  ): Promise<ProductLineSaveResult> {
    const status = (target: WireAppointment) =>
      request.mark_arrived ? 1 : target.attendance_status;
    const { before, after } = await this.guardedSave(
      locationId,
      appointmentId,
      {
        expected_version: request.expected_version,
        line_id: request.line.line_id,
        body: (target) => saveBody(target, request),
        kind: 'add',
      }
    );
    const savedLineId =
      request.line.line_id ??
      after.target.goods.find(
        (g) =>
          !before.target.goods.some((b) => b.id === g.id) &&
          g.good_id === request.line.product_id
      )?.id ??
      null;
    return {
      appointment: after.sale,
      unexpected_changes: [
        ...unexpectedChanges(
          before.target,
          after.target,
          status(before.target),
          savedLineId
        ),
        ...otherAppointmentChanges(before.others, after.others),
      ],
    };
  }

  async reduceProductLine(
    locationId: number,
    appointmentId: number,
    request: ReduceProductLineRequest
  ): Promise<ProductLineSaveResult> {
    const { before, after } = await this.guardedSave(
      locationId,
      appointmentId,
      {
        expected_version: request.expected_version,
        line_id: request.line_id,
        body: (target) => reductionBody(target, request),
        kind: 'reduce',
      }
    );
    return {
      appointment: after.sale,
      unexpected_changes: [
        ...unexpectedChanges(
          before.target,
          after.target,
          before.target.attendance_status,
          request.line_id
        ),
        ...otherAppointmentChanges(before.others, after.others),
      ],
    };
  }
}
