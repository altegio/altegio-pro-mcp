/** Shared canonical client-base filter schema used by client and analytics tools. */
import { z } from 'zod';

const moneyRange = z
  .object({
    from: z
      .number()
      .optional()
      .describe('Lower bound, inclusive, major units.'),
    to: z.number().optional().describe('Upper bound, inclusive, major units.'),
  })
  .describe('A money range in major units; give from, to, or both.');

const numberRange = z
  .object({
    from: z.number().int().optional(),
    to: z.number().int().optional(),
  })
  .describe('A whole-number range; give from, to, or both.');

const dateRange = z
  .object({
    from: z
      .string()
      .optional()
      .describe('Start, `YYYY-MM-DD` (or `MM-DD` for a birthday).'),
    to: z
      .string()
      .optional()
      .describe('End, `YYYY-MM-DD` (or `MM-DD` for a birthday).'),
  })
  .describe('A date range; give from, to, or both.');

const appointmentHistory = z
  .object({
    team_member_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe(
        'Only appointments with these team members (get_staff for ids).'
      ),
    service_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe(
        'Only appointments that include these services (get_services for ids).'
      ),
    service_category_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe('Only appointments in these service categories.'),
    outcome: z
      .array(z.enum(['waiting', 'confirmed', 'arrived', 'no_show']))
      .optional()
      .describe(
        'Only appointments that ended in these outcomes (arrived = the client came).'
      ),
    created: dateRange
      .optional()
      .describe('Only appointments created in this window.'),
    count: numberRange
      .optional()
      .describe('How many matching appointments the client has.'),
    amount: moneyRange
      .optional()
      .describe('Money sold across the matching appointments.'),
    exclude: z
      .boolean()
      .optional()
      .describe(
        'Invert the match: return clients who did NOT have such an appointment — this is how you build a lapsed / win-back segment (e.g. "no visit in the last 90 days").'
      ),
  })
  .describe(
    'Filter clients by their appointment history. Combine with a date window on `created` plus `exclude: true` to find clients who have gone quiet.'
  );

export const clientFiltersSchema = z
  .object({
    query: z
      .string()
      .optional()
      .describe('Free text over name, phone and email.'),
    client_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe('Restrict to these client ids.'),
    total_spent: moneyRange
      .optional()
      .describe(
        'Lifetime money sold to the client — use a high `from` for top spenders / VIPs.'
      ),
    importance: z
      .array(z.enum(['none', 'bronze', 'silver', 'gold']))
      .optional()
      .describe('Loyalty importance class.'),
    gender: z.array(z.enum(['unknown', 'male', 'female'])).optional(),
    tag_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe(
        'Client tag (label) ids — the coloured labels on a client card, not service categories.'
      ),
    birthday: dateRange
      .optional()
      .describe(
        'Birthday window; `MM-DD` for a day-of-year band (e.g. birthdays this month for a campaign).'
      ),
    age: numberRange.optional(),
    has_mobile_app: z
      .boolean()
      .optional()
      .describe('Whether the client installed the location’s mobile app.'),
    client_account_balance: moneyRange
      .optional()
      .describe('Prepaid client-account balance.'),
    membership_balance: moneyRange
      .optional()
      .describe('Remaining balance on the client’s memberships.'),
    membership_type_ids: z.array(z.number().int().positive()).optional(),
    membership_is_frozen: z.boolean().optional(),
    membership_is_used: z.boolean().optional(),
    gift_card_balance: moneyRange
      .optional()
      .describe('Remaining balance on the client’s gift cards.'),
    gift_card_type_ids: z.array(z.number().int().positive()).optional(),
    gift_card_is_used: z.boolean().optional(),
    newsletter_allowed: z
      .boolean()
      .optional()
      .describe('Client agreed to receive newsletters.'),
    mass_notification_allowed: z
      .boolean()
      .optional()
      .describe(
        'Client is included in mass notifications — filter on true before a campaign.'
      ),
    push_enabled: z.boolean().optional(),
    personal_data_processing_allowed: z.boolean().optional(),
    appointments: appointmentHistory.optional(),
  })
  .describe(
    'Segmentation filters. Every field is optional; the ones given are combined by `match`. See altegio://docs/clients-segmentation for the full reference and worked segments.'
  );
