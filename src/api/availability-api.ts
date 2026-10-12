/**
 * Availability port: when a team member can take a new appointment.
 *
 * The capability (`src/capabilities/availability`) is written against this
 * port in the product glossary. Today's adapter (`./v1/availability-adapter.ts`)
 * reads the appointment calendar's session grid, the documented V1 read the
 * digital schedule itself uses. V2 has no availability read; the V3 contract
 * (`getAvailability`, `GET /locations/{location_id}/availability`, preview)
 * computes bookable start times server-side and will replace the adapter
 * without changing the tool.
 */

/** One cell of the appointment calendar: a start time and whether it is free. */
export interface CalendarCell {
  /** Local wall-clock time, `HH:MM`. */
  time: string;
  free: boolean;
}

export interface AvailabilityApi {
  /**
   * The calendar cells of one team member on one day, in the location's
   * local time. Only working time has cells; an empty list is a day off.
   */
  calendarCells(
    locationId: number,
    teamMemberId: number,
    date: string
  ): Promise<CalendarCell[]>;
}
