/** Bounded, exact scan of the documented V1 appointment list for analytics. */
import type { AltegioClient } from '../../providers/altegio-client.js';
import type { AltegioBooking } from '../../types/altegio.types.js';
import {
  httpFromClient,
  queryString,
  requireUserToken,
} from '../altegio-http.js';
import { AnalyticsInputError } from '../../capabilities/analytics/errors.js';

const PAGE_SIZE = 1000; // Backend PageApiRecordsController maximum.
const MAX_RECORDS = 30000;

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Only the facts needed by analytics; client contacts and comments are dropped. */
export interface ServiceRecord {
  id: number;
  staff_id: number;
  staff?: { name?: string };
  client?: { id: number };
  date: string;
  datetime: string;
  attendance?: number;
  visit_attendance?: number;
  deleted?: boolean;
  services: Array<
    Pick<
      AltegioBooking['services'][number],
      'id' | 'title' | 'manual_cost' | 'cost' | 'amount'
    >
  >;
  resource_instance_ids: number[];
}

export interface RecordScan {
  records: ServiceRecord[];
  source_count: number;
  pages: number;
  scanned_at: string;
}

/**
 * Refuses oversized or shifting result sets. The source sorts by date, not an
 * immutable cursor, so this does not claim a transactional snapshot.
 */
export async function scanRecords(
  client: AltegioClient,
  locationId: number,
  dateFrom: string,
  dateTo: string,
  teamMemberId?: number
): Promise<RecordScan> {
  const http = httpFromClient(client);
  requireUserToken(http, 'read service analytics');
  const records: ServiceRecord[] = [];
  const ids = new Set<number>();
  let expected: number | undefined;
  let pages = 0;
  const scannedAt = new Date().toISOString();
  for (let page = 1; ; page += 1) {
    const path = `/records/${locationId}${queryString({
      start_date: dateFrom,
      // The backend ends at 23:59:00. Include the following day and discard
      // it locally, so the last minute of the requested day is covered.
      end_date: nextDay(dateTo),
      staff_id: teamMemberId,
      page,
      count: PAGE_SIZE,
    })}`;
    const response = await http.request(path);
    if (!response.ok)
      throw new Error(`Appointment source returned HTTP ${response.status}.`);
    const envelope = (await response.json()) as {
      success?: boolean;
      data?: unknown;
      meta?: { total_count?: unknown };
    };
    const total = envelope.meta?.total_count;
    if (
      envelope.success !== true ||
      !Array.isArray(envelope.data) ||
      !Number.isSafeInteger(total) ||
      (total as number) < 0
    )
      throw new Error(
        'Appointment source did not provide an exact paged total.'
      );
    if ((total as number) > MAX_RECORDS) {
      throw new AnalyticsInputError(
        `The selected period has ${total} appointments, above the ${MAX_RECORDS}-record safe scan limit. Narrow the dates.`
      );
    }
    if (expected === undefined) expected = total as number;
    if (expected !== total)
      throw new Error(
        'Appointment count changed during the scan; retry the report.'
      );
    for (const row of envelope.data) {
      if (
        !row ||
        typeof row !== 'object' ||
        !Number.isSafeInteger((row as AltegioBooking).id) ||
        ids.has((row as AltegioBooking).id)
      ) {
        throw new Error(
          'Appointment pages contain an invalid or duplicate id; retry the report.'
        );
      }
      const raw = row as AltegioBooking;
      if (
        !Array.isArray(raw.services) ||
        typeof (raw.datetime ?? raw.date) !== 'string' ||
        !Number.isInteger(raw.attendance ?? raw.visit_attendance)
      )
        throw new Error(
          'Appointment page is missing required service, date or attendance fields.'
        );
      ids.add(raw.id);
      records.push({
        id: raw.id,
        staff_id: raw.staff_id,
        staff: raw.staff ? { name: raw.staff.name } : undefined,
        client: raw.client ? { id: raw.client.id } : undefined,
        date: raw.date,
        datetime: raw.datetime,
        attendance: raw.attendance,
        visit_attendance: raw.visit_attendance,
        deleted: raw.deleted,
        services: raw.services.map((line) => ({
          id: line.id,
          title: line.title,
          manual_cost: line.manual_cost,
          cost: line.cost,
          amount: line.amount,
        })),
        resource_instance_ids: Array.isArray(raw.resource_instance_ids)
          ? raw.resource_instance_ids.filter((value): value is number =>
              Number.isSafeInteger(value)
            )
          : [],
      });
    }
    pages = page;
    if (records.length >= expected) break;
    if (envelope.data.length !== PAGE_SIZE || records.length > MAX_RECORDS) {
      throw new Error(
        'Appointment pages ended before their reported total; retry the report.'
      );
    }
  }
  if (records.length !== expected)
    throw new Error(
      'Appointment total changed during the scan; retry the report.'
    );
  return { records, source_count: expected, pages, scanned_at: scannedAt };
}
