/** Shared canonical client-base filter schema used by client and analytics tools. */
import { z } from 'zod';

/** Ranges are inclusive; give from, to or both. Money is in major units. */
const moneyRange = z
  .object({ from: z.number().optional(), to: z.number().optional() })
  .describe('Money range, major units, inclusive.');

const numberRange = z
  .object({
    from: z.number().int().optional(),
    to: z.number().int().optional(),
  })
  .describe('Whole-number range, inclusive.');

const dateRange = z
  .object({ from: z.string().optional(), to: z.string().optional() })
  .describe('Date range YYYY-MM-DD, inclusive.');

const appointmentHistory = z
  .object({
    team_member_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe('With these team members.'),
    service_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe('Including these services.'),
    service_category_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe('In these service categories.'),
    outcome: z
      .array(z.enum(['waiting', 'confirmed', 'arrived', 'no_show']))
      .optional()
      .describe('Ended in these outcomes (arrived = came).'),
    created: dateRange.optional().describe('Created in this date range.'),
    count: numberRange.optional().describe('Number of matching appointments.'),
    amount: moneyRange
      .optional()
      .describe('Money sold across them, major units.'),
    exclude: z
      .boolean()
      .optional()
      .describe(
        'Clients WITHOUT such an appointment — lapsed / win-back segments.'
      ),
  })
  .describe(
    'Match on appointment history; `created` window + exclude=true finds clients gone quiet.'
  );

export const clientFiltersSchema = z
  .object({
    query: z.string().optional().describe('Text in name, phone or email.'),
    client_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe('Only these clients.'),
    total_spent: moneyRange
      .optional()
      .describe('Lifetime sales, major units (high `from` = VIPs).'),
    importance: z
      .array(z.enum(['none', 'bronze', 'silver', 'gold']))
      .optional()
      .describe('Loyalty importance class.'),
    gender: z.array(z.enum(['unknown', 'male', 'female'])).optional(),
    tag_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe('Client card labels, not service categories.'),
    birthday: dateRange
      .optional()
      .describe(
        'Birthday window under a year; MM-DD bounds for a yearly band, may cross New Year.'
      ),
    age: numberRange.optional(),
    has_mobile_app: z
      .boolean()
      .optional()
      .describe('Installed the location’s app.'),
    client_account_balance: moneyRange
      .optional()
      .describe('Client-account balance.'),
    membership_balance: numberRange
      .optional()
      .describe(
        'Visits left on a membership. Membership filters match clients with one membership sold here meeting all of them.'
      ),
    membership_type_ids: z.array(z.number().int().positive()).optional(),
    membership_is_frozen: z.boolean().optional(),
    membership_is_used: z
      .boolean()
      .optional()
      .describe('Membership used at least once (false = never used).'),
    gift_card_balance: moneyRange
      .optional()
      .describe(
        'Gift card balance left. Gift card filters match one gift card sold here meeting all of them.'
      ),
    gift_card_type_ids: z.array(z.number().int().positive()).optional(),
    gift_card_is_used: z.boolean().optional(),
    newsletter_allowed: z
      .boolean()
      .optional()
      .describe('Agreed to newsletters.'),
    mass_notification_allowed: z
      .boolean()
      .optional()
      .describe('In mass notifications (true before a campaign).'),
    push_enabled: z.boolean().optional(),
    personal_data_processing_allowed: z.boolean().optional(),
    appointments: appointmentHistory.optional(),
  })
  .describe(
    'Segment filters, combined by `match`. Reference: altegio://docs/clients-segmentation.'
  );
