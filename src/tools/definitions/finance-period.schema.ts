/** Shared input of the finance-ledger reports: a location and whole local months. */
import { z } from 'zod';

export const completeMonthsInput = {
  location_id: z
    .number()
    .int()
    .positive()
    .describe(
      'Location to report on. Call list_locations when the id is unknown.'
    ),
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('First day of the first local calendar month, YYYY-MM-DD.'),
  date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe(
      'Last day of the final local calendar month, YYYY-MM-DD. At most 12 complete months after date_from.'
    ),
};
