import { z } from 'zod';
import { defineTool } from '../factory.js';
import {
  appointmentSettingsOutput,
  onlineSettingsOutput,
  bookingFormsOutput,
  bookingFormEntityOutput,
} from '../output-schemas.js';

// ========== Appointment calendar settings ==========

export const getAppointmentSettingsTool = defineTool({
  name: 'get_appointment_settings',
  category: 'Settings',
  description:
    '[Settings] Get appointment calendar settings for a location. AUTHENTICATION REQUIRED. Returns the default appointment type (record_type: 0 mixed, 1 individual, 2 group event) and the maximum number of seats in a group event.',
  annotations: {
    title: 'Get Appointment Settings',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
  }),
  outputSchema: appointmentSettingsOutput,
  handler: async ({ input, client }) => {
    const s = await client.getAppointmentSettings(input.location_id);
    return {
      text:
        `Appointment calendar settings:\n` +
        `- Default appointment type (record_type): ${s.record_type}\n` +
        `- Max seats per group event: ${s.activity_record_clients_count_max}`,
      structuredContent: s,
    };
  },
});

export const updateAppointmentSettingsTool = defineTool({
  name: 'update_appointment_settings',
  category: 'Settings',
  description:
    '[Settings] Update appointment calendar settings. AUTHENTICATION REQUIRED. Sets the default appointment type and the maximum number of seats per group event.',
  annotations: {
    title: 'Update Appointment Settings',
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    record_type: z
      .number()
      .int()
      .min(0)
      .max(2)
      .describe(
        'Default appointment type: 0 - Mixed, 1 - Individual, 2 - Group event'
      ),
    activity_record_clients_count_max: z
      .number()
      .int()
      .min(1)
      .max(255)
      .describe('Maximum number of seats in one group event (1-255)'),
    is_show_newsletter_agreement: z
      .boolean()
      .optional()
      .describe('Show newsletter subscription agreement checkbox'),
    is_show_personal_data_processing_agreement: z
      .boolean()
      .optional()
      .describe('Show personal data processing agreement checkbox'),
  }),
  outputSchema: appointmentSettingsOutput,
  handler: async ({ input, client }) => {
    const { location_id, ...data } = input;
    const s = await client.updateAppointmentSettings(location_id, data);
    return {
      text:
        `Appointment calendar settings updated:\n` +
        `- Default appointment type (record_type): ${s.record_type}\n` +
        `- Max seats per group event: ${s.activity_record_clients_count_max}`,
      structuredContent: s,
    };
  },
});

// ========== Online booking settings ==========

export const getOnlineBookingSettingsTool = defineTool({
  name: 'get_online_booking_settings',
  category: 'Settings',
  description:
    '[Settings] Get online booking settings for a location. AUTHENTICATION REQUIRED. Returns "any team member" mode, SMS confirmation flag, delay before the next session, and max seats per group event.',
  annotations: {
    title: 'Get Online Booking Settings',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
  }),
  outputSchema: onlineSettingsOutput,
  handler: async ({ input, client }) => {
    const s = await client.getOnlineBookingSettings(input.location_id);
    return {
      text:
        `Online booking settings:\n` +
        `- "Any team member" mode: ${s.any_master}\n` +
        `- Confirm number via SMS: ${s.confirm_number}\n` +
        `- Delay to next session (min): ${s.seance_delay_step}\n` +
        `- Max seats per group event: ${s.activity_online_record_clients_count_max}`,
      structuredContent: s,
    };
  },
});

export const updateOnlineBookingSettingsTool = defineTool({
  name: 'update_online_booking_settings',
  category: 'Settings',
  description:
    '[Settings] Update online booking settings. AUTHENTICATION REQUIRED. Controls "any team member" mode, SMS number confirmation, the delay before the next available session, and group-event capacity.',
  annotations: {
    title: 'Update Online Booking Settings',
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    any_master: z.boolean().describe('"Any team member" mode'),
    confirm_number: z.boolean().describe('Confirm client number via SMS'),
    seance_delay_step: z
      .number()
      .int()
      .min(0)
      .max(1380)
      .describe(
        'Delay to the next session, minutes 0-1380 (up to 23h) in increments of 30'
      ),
    activity_online_record_clients_count_max: z
      .number()
      .int()
      .min(1)
      .max(255)
      .describe('Maximum number of seats in one group event (1-255)'),
  }),
  outputSchema: onlineSettingsOutput,
  handler: async ({ input, client }) => {
    const { location_id, ...data } = input;
    const s = await client.updateOnlineBookingSettings(location_id, data);
    return {
      text:
        `Online booking settings updated:\n` +
        `- "Any team member" mode: ${s.any_master}\n` +
        `- Confirm number via SMS: ${s.confirm_number}\n` +
        `- Delay to next session (min): ${s.seance_delay_step}\n` +
        `- Max seats per group event: ${s.activity_online_record_clients_count_max}`,
      structuredContent: s,
    };
  },
});

// ========== Booking (appointment) forms ==========

export const getBookingFormsTool = defineTool({
  name: 'get_booking_forms',
  category: 'Settings',
  description:
    '[Settings] Get the list of online booking (appointment) forms/widgets for a location. AUTHENTICATION REQUIRED.',
  annotations: {
    title: 'Get Booking Forms',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
  }),
  outputSchema: bookingFormsOutput,
  handler: async ({ input, client }) => {
    const forms = await client.getBookingForms(input.location_id);

    if (!forms || forms.length === 0) {
      return {
        text: 'No booking forms found for this location.',
        structuredContent: { items: [], count: 0 },
      };
    }

    const list = forms
      .map(
        (f, idx) =>
          `${idx + 1}. ${f.title} (ID: ${f.id})${f.is_default ? ' [default]' : ''}`
      )
      .join('\n');

    return {
      text: `Found ${forms.length} booking form(s):\n\n${list}`,
      structuredContent: { items: forms, count: forms.length },
    };
  },
});

export const createBookingFormTool = defineTool({
  name: 'create_booking_form',
  category: 'Settings',
  description:
    '[Settings] Create an online booking (appointment) form/widget for a location. AUTHENTICATION REQUIRED. Only a title is required; other options use platform defaults.',
  annotations: {
    title: 'Create Booking Form',
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    title: z.string().min(1).describe('Name of the booking widget'),
    description: z
      .string()
      .optional()
      .describe('Booking widget description (optional)'),
    is_default: z
      .boolean()
      .optional()
      .describe('Mark this form as the default booking widget'),
    without_menu: z
      .boolean()
      .optional()
      .describe('Step mode flag ("without menu")'),
  }),
  outputSchema: bookingFormEntityOutput,
  handler: async ({ input, client }) => {
    const { location_id, ...data } = input;
    const form = await client.createBookingForm(location_id, data);
    return {
      text: `Successfully created booking form:\nID: ${form.id}\nTitle: ${form.title}`,
      structuredContent: { id: form.id, title: form.title },
    };
  },
});
