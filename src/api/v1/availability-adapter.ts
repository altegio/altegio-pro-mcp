/**
 * V1 adapter for the availability port: the appointment calendar's sessions,
 * `GET /timetable/seances/{location_id}/{team_member_id}/{date}` (operation
 * `get_appointment_calendar_sessions`). The answer is the day's working time
 * as a grid of cells (`{ time: "11:40", is_free: true }`), one per calendar
 * step; cells outside working hours are absent.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { AltegioApiError, AuthenticationError } from '../../utils/errors.js';
import { upstreamDetail } from '../../tools/tool-result.js';
import {
  httpFromClient,
  requireUserToken,
  type AltegioHttp,
} from '../altegio-http.js';
import type { AvailabilityApi, CalendarCell } from '../availability-api.js';

const TIME = /^\d{2}:\d{2}$/;

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function upstreamMessage(payload: unknown): string | null {
  const meta = (payload as { meta?: { message?: unknown } } | undefined)?.meta;
  return upstreamDetail(meta?.message);
}

export class AvailabilityAdapter implements AvailabilityApi {
  constructor(private readonly http: AltegioHttp) {}

  static forClient(client: AltegioClient): AvailabilityAdapter {
    return new AvailabilityAdapter(httpFromClient(client));
  }

  async calendarCells(
    locationId: number,
    teamMemberId: number,
    date: string
  ): Promise<CalendarCell[]> {
    const context = `read the appointment calendar of team member ${teamMemberId} on ${date}`;
    requireUserToken(this.http, context);
    const response = await this.http.request(
      `/timetable/seances/${locationId}/${teamMemberId}/${date}`
    );
    const payload = await safeJson(response);
    if (response.status === 401) {
      throw new AuthenticationError(
        `Session expired while trying to ${context}.`
      );
    }
    if (!response.ok) {
      const detail = upstreamMessage(payload);
      throw new AltegioApiError(
        `Failed to ${context} (HTTP ${response.status}).${detail ? ` ${detail}` : ''}`,
        response.status,
        payload
      );
    }
    const data = (payload as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(data)) return [];
    const cells: CalendarCell[] = [];
    for (const cell of data) {
      if (!cell || typeof cell !== 'object') continue;
      const { time, is_free } = cell as { time?: unknown; is_free?: unknown };
      if (typeof time !== 'string' || !TIME.test(time)) continue;
      cells.push({ time, free: is_free === true });
    }
    return cells;
  }
}
