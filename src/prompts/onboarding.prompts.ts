/**
 * The first-time setup walkthrough.
 *
 * Turns the onboarding wizard's twelve tools into one conversation a location
 * owner can follow: the phase order that makes the digital schedule work,
 * where bulk import beats typing, and what to do when a phase fails halfway.
 */
import { ONBOARDING_GUIDE_URI } from '../resources/docs.resources.js';
import { userText, type PromptModule } from './registry.js';

export const ONBOARDING_WALKTHROUGH_PROMPT = 'onboarding_walkthrough';

function walkthrough(locationId?: string): string {
  const target = locationId
    ? `Set up location ${locationId}.`
    : 'Ask which location to set up: call list_locations and let me pick one, then use that location_id everywhere below.';

  return [
    'Walk me through setting up my location in Altegio for the first time.',
    'Act as the person doing the setup with me: one phase at a time, confirm',
    'what you are about to create before you create it, and show me the result',
    'of each phase before moving on.',
    '',
    target,
    '',
    'Use the host-provided Altegio identity if present; otherwise, in local stdio mode, call altegio_login if I am not authenticated yet. Then',
    'onboarding_start for the location (onboarding_resume instead if a session',
    'already exists — onboarding_status tells you which).',
    '',
    'Then follow this order, because each phase depends on the one before it:',
    '',
    '1. Positions — onboarding_add_positions. Job titles first, so every team',
    '   member can reference one.',
    '2. Team members — onboarding_add_staff_batch. Ask me for names and',
    '   positions, or take a CSV or JSON list if I have one.',
    '3. Service categories — onboarding_add_categories.',
    '4. Services — onboarding_add_services_batch, each in a category, with',
    '   price and duration.',
    '5. Work schedules — onboarding_set_schedules. Without these the digital',
    '   schedule stays empty and clients cannot be booked, so do not skip it.',
    '6. Clients — onboarding_import_clients, if I have an existing client list.',
    '7. Test appointments — onboarding_create_test_appointments, so I can see',
    '   the digital schedule with something in it.',
    '',
    'Rules for the whole walkthrough:',
    '',
    '- Before any bulk import, call onboarding_preview_data and show me what',
    '  will be created. Do not import until I confirm.',
    '- If a phase fails partway, say exactly what was created and what was not,',
    '  then offer onboarding_rollback_phase for that phase or a retry of the',
    '  remaining items. Never start the next phase on a half-finished one.',
    '- Use the canonical vocabulary with me: location, team member,',
    '  professional, receptionist, service, service category, appointment,',
    '  work schedule, digital schedule.',
    `- The full guide, including the CSV shapes each import accepts, is the`,
    `  resource ${ONBOARDING_GUIDE_URI}. Read it if a shape is unclear.`,
    '',
    'Finish with onboarding_status and a short summary of what my location now',
    'has, plus what I still need to do myself (location settings, online',
    'booking, notifications).',
  ].join('\n');
}

export const onboardingPrompts: PromptModule = {
  prompts: [
    {
      name: ONBOARDING_WALKTHROUGH_PROMPT,
      title: 'Set up a location for the first time',
      description:
        'Guided first-time setup of a location: positions, team members, service categories, services, work schedules, clients and test appointments, in the order that leaves the digital schedule working. Previews every bulk import and offers a rollback when a phase fails.',
      arguments: [
        {
          name: 'location_id',
          description:
            'The location to set up. Omit it to have the walkthrough list the locations and ask.',
          required: false,
        },
      ],
      build: (args) => ({
        messages: [userText(walkthrough(args.location_id))],
      }),
    },
  ],
};
