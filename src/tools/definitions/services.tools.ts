import {
  paginationInput,
  paginateCollection,
  renderPage,
} from '../pagination.js';
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { withUntrustedBlock, type UntrustedField } from '../tool-result.js';
import { servicesOutput, serviceEntityOutput } from '../output-schemas.js';
import type { AltegioService } from '../../types/altegio.types.js';

const seanceLengthSchema = z
  .number()
  .int()
  .min(300)
  .max(86100)
  .describe('Session length for this team member, seconds (300–86100).');

const durationSecondsArg = z
  .number()
  .int()
  .positive()
  .optional()
  .describe('Default duration, seconds.');

const prepaidArg = z
  .enum(['forbidden', 'allowed', 'required'])
  .optional()
  .describe('Online advance payment.');

/**
 * The service's price as a range. Altegio stores a fixed price as
 * `price_min` with `price_max` 0 (or equal), and only a larger `price_max`
 * makes it a range — so "1700–0" is a fixed price of 1700, not a range.
 */
function servicePrice(service: AltegioService): {
  min: number | null;
  max: number | null;
} {
  const min = service.price_min ?? service.cost ?? null;
  const upper = service.price_max;
  const max =
    min !== null && typeof upper === 'number' && upper > min ? upper : min;
  return { min, max };
}

function servicePriceText(service: AltegioService): string {
  const { min, max } = servicePrice(service);
  if (min === null) return 'price not set';
  return max !== null && max !== min ? `price ${min}–${max}` : `price ${min}`;
}

/**
 * How long the service takes. The documented list leaves `duration` out of
 * every row, so the per-team-member session lengths of its links stand in:
 * one length when they agree, the shortest and longest when they do not.
 */
function serviceDuration(service: AltegioService): {
  seconds: number | null;
  min: number | null;
  max: number | null;
} {
  if (typeof service.duration === 'number' && service.duration > 0) {
    return {
      seconds: service.duration,
      min: service.duration,
      max: service.duration,
    };
  }
  const lengths = (service.staff ?? [])
    .map((link) => link.seance_length)
    .filter((length) => typeof length === 'number' && length > 0);
  if (lengths.length === 0) return { seconds: null, min: null, max: null };
  const min = Math.min(...lengths);
  const max = Math.max(...lengths);
  return { seconds: min === max ? min : null, min, max };
}

function minutes(seconds: number): string {
  return `${Math.round(seconds / 60)} min`;
}

function serviceDurationText(service: AltegioService): string | null {
  const { min, max } = serviceDuration(service);
  if (min === null || max === null) return null;
  return min === max
    ? minutes(min)
    : `${minutes(min)}–${minutes(max)} by team member`;
}

/** At most this many linked team member ids on one text line. */
const LINKED_IDS_SHOWN = 10;

function serviceLine(service: AltegioService): string {
  const links = (service.staff ?? []).map((link) => link.id);
  const active =
    service.active === undefined
      ? null
      : Boolean(Number(service.active))
        ? 'active'
        : 'inactive';
  const team =
    links.length === 0
      ? 'no team members linked'
      : `team members ${links.slice(0, LINKED_IDS_SHOWN).join(', ')}` +
        (links.length > LINKED_IDS_SHOWN
          ? ` +${links.length - LINKED_IDS_SHOWN} more`
          : '');
  return [
    `- ${service.id}`,
    service.category_id ? `category ${service.category_id}` : null,
    servicePriceText(service),
    serviceDurationText(service),
    active,
    team,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

function projectService(service: AltegioService) {
  const { min, max } = servicePrice(service);
  return {
    id: service.id,
    title: service.title,
    category_id: service.category_id ?? null,
    price_min: min,
    price_max: max,
    duration_seconds: serviceDuration(service).seconds,
    active:
      service.active === undefined ? null : Boolean(Number(service.active)),
    discount: service.discount ?? null,
    comment: service.comment ?? null,
    team_members: (service.staff ?? []).map((link) => ({
      team_member_id: link.id,
      session_length_seconds: link.seance_length,
      technological_card_id: link.technological_card_id ?? null,
    })),
  };
}

export const getServicesTool = defineTool({
  name: 'services_list',
  category: 'Services',
  description:
    'Services of a location: price, duration, category, active flag, linked team members. Paged by id with exact total.',
  annotations: {
    title: 'Get Services',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z
      .number()
      .int()
      .positive()
      .describe('ID of the location to get services for'),
    ...paginationInput,
  }),
  outputSchema: servicesOutput,
  handler: async ({ input, client }) => {
    const { location_id } = input;
    const all = await client.getServices(location_id);
    const { items: page } = paginateCollection(all, input);

    return renderPage({
      input,
      items: page,
      total: all.length,
      render: ({ items: services, pagination }) => {
        const lines = [
          `${services.length} of ${all.length} ${all.length === 1 ? 'service' : 'services'} at location ${location_id}, page ${pagination.page}` +
            (pagination.next_page === null
              ? ' (last page).'
              : `; next: page=${pagination.next_page}, page_size=${pagination.page_size}.`),
        ];
        lines.push(...services.map(serviceLine));
        // A service title and its comment are typed by the location's staff,
        // so they stay out of our rows and go in the untrusted block, by id.
        const untrusted: UntrustedField[] = services.flatMap((service) => [
          { label: `service ${service.id}`, value: service.title },
          { label: `service ${service.id} comment`, value: service.comment },
        ]);
        return {
          text: withUntrustedBlock(lines.join('\n'), untrusted, {
            maxChars: 200,
          }),
          structuredContent: {
            items: services.map(projectService),
            pagination,
          },
        };
      },
    });
  },
});

export const createServiceTool = defineTool({
  name: 'services_create',
  category: 'Services',
  description:
    'Create a service (title, category_id), active unless active=false. Link a team member (services_link_team_member) before booking.',
  annotations: {
    title: 'Create Service',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    title: z.string().min(1).describe('Service title'),
    category_id: z.number().int().positive().describe('Service category ID'),
    price_min: z.number().nonnegative().optional().describe('Minimum price'),
    price_max: z.number().nonnegative().optional().describe('Maximum price'),
    discount: z
      .number()
      .nonnegative()
      .optional()
      .describe('Discount percentage'),
    comment: z.string().optional().describe('Service description'),
    duration_seconds: durationSecondsArg,
    prepaid: prepaidArg,
    active: z.boolean().default(true).describe('false creates a hidden draft.'),
  }),
  outputSchema: serviceEntityOutput,
  handler: async ({ input, client }) => {
    const { location_id, duration_seconds, active, ...serviceData } = input;
    const service = await client.createService(location_id, {
      ...serviceData,
      ...(duration_seconds !== undefined ? { duration: duration_seconds } : {}),
      active: active ? 1 : 0,
    });
    return {
      text: withUntrustedBlock(
        `Created service ${service.id} in category ${service.category_id ?? 'not reported'}; active: ${service.active === undefined ? 'not reported by the create response' : Boolean(Number(service.active))}.`,
        [{ label: 'title', value: service.title }]
      ),
      structuredContent: projectService(service),
    };
  },
});

export const updateServiceTool = defineTool({
  name: 'services_update',
  category: 'Services',
  description:
    'Update a service: pass only changes; the rest and its team-member links are kept.',
  annotations: {
    title: 'Update Service',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    service_id: z.number().int().positive().describe('Service ID'),
    title: z.string().min(1).optional().describe('Service title'),
    category_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Service category ID'),
    price_min: z.number().nonnegative().optional().describe('Minimum price'),
    price_max: z.number().nonnegative().optional().describe('Maximum price'),
    discount: z
      .number()
      .nonnegative()
      .optional()
      .describe('Discount percentage'),
    comment: z.string().optional().describe('Service description'),
    duration_seconds: durationSecondsArg,
    prepaid: prepaidArg,
    active: z.boolean().optional().describe('false hides it from booking.'),
  }),
  outputSchema: serviceEntityOutput,
  handler: async ({ input, client }) => {
    const { location_id, service_id, duration_seconds, active, ...rest } =
      input;
    const updateData = {
      ...rest,
      ...(duration_seconds !== undefined ? { duration: duration_seconds } : {}),
      ...(active !== undefined ? { active: active ? 1 : 0 } : {}),
    };
    const service = await client.updateService(
      location_id,
      service_id,
      updateData
    );
    return {
      // A partial update reads back a title this call never sent.
      text: withUntrustedBlock(
        `Successfully updated service ${service_id}.\n` +
          `Active: ${service.active === undefined ? 'not reported' : Boolean(Number(service.active))}\n` +
          `Team-member links preserved: ${service.staff?.length ?? 'not reported by update response'}`,
        [{ label: 'title as stored', value: service.title }],
        { maxChars: 200 }
      ),
      structuredContent: projectService(service),
    };
  },
});

export const deleteServiceTool = defineTool({
  name: 'services_delete',
  category: 'Services',
  description:
    'Delete a service; to hide it use services_update with active=false.',
  annotations: {
    title: 'Delete Service',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    service_id: z.number().int().positive().describe('Service ID to delete'),
  }),
  confirm: {
    action: 'Delete service',
    target: (input) =>
      `service ${input.service_id} at location ${input.location_id}`,
    resolve: async (input, client) => {
      const service = await client.getService(
        input.location_id,
        input.service_id
      );
      const links = service.staff?.length;
      const linked =
        links === undefined ? '' : `, linked to ${links} team member(s)`;
      return `service "${service.title}", id ${service.id}${linked}, at location ${input.location_id}`;
    },
    consequence:
      'The service is removed from the location together with every team-member link and its place in the online-booking menu. Appointments already booked keep the service name they were booked with. To merely take it off sale instead, cancel here and call services_update with active=0.',
  },
  handler: async ({ input, client }) => {
    await client.deleteService(input.location_id, input.service_id);
    return {
      text: `Successfully deleted service ${input.service_id} from location ${input.location_id}`,
    };
  },
});

// ========== Service ↔ Team Member Links ==========

export const linkServiceTeamMemberTool = defineTool({
  name: 'services_link_team_member',
  category: 'Services',
  description:
    'Link a team member to a service, which booking requires (otherwise HTTP 400). To change a link use services_update_team_member_link.',
  annotations: {
    title: 'Link Team Member to Service',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    service_id: z.number().int().positive().describe('Service ID'),
    team_member_id: z.number().int().positive().describe('Team member ID'),
    session_length: seanceLengthSchema,
    technological_card_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe('Tech card id or null.'),
  }),
  handler: async ({ input, client }) => {
    await client.assignServiceToStaff(input.location_id, input.service_id, {
      master_id: input.team_member_id,
      seance_length: input.session_length,
      technological_card_id: input.technological_card_id ?? null,
    });
    return {
      text: `Linked team member ${input.team_member_id} to service ${input.service_id} (${input.session_length}s per session)`,
      structuredContent: {
        service_id: input.service_id,
        team_member_id: input.team_member_id,
        session_length: input.session_length,
      },
    };
  },
});

export const updateServiceTeamMemberTool = defineTool({
  name: 'services_update_team_member_link',
  category: 'Services',
  description:
    'Change a team member ↔ service link (session length, tech card); create it with services_link_team_member.',
  annotations: {
    title: 'Update Team Member Service Link',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    service_id: z.number().int().positive().describe('Service ID'),
    team_member_id: z.number().int().positive().describe('Team member ID'),
    session_length: seanceLengthSchema,
    technological_card_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe('Bill-of-materials (tech card) ID, or null'),
  }),
  handler: async ({ input, client }) => {
    await client.updateServiceStaffAssignment(
      input.location_id,
      input.service_id,
      input.team_member_id,
      {
        seance_length: input.session_length,
        technological_card_id: input.technological_card_id ?? null,
      }
    );
    return {
      text: `Updated link of team member ${input.team_member_id} to service ${input.service_id} (${input.session_length}s per session)`,
      structuredContent: {
        service_id: input.service_id,
        team_member_id: input.team_member_id,
        session_length: input.session_length,
      },
    };
  },
});

export const unlinkServiceTeamMemberTool = defineTool({
  name: 'services_unlink_team_member',
  category: 'Services',
  description:
    'Remove the link between a team member and a service (they stop offering it).',
  annotations: {
    title: 'Unlink Team Member from Service',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    service_id: z.number().int().positive().describe('Service ID'),
    team_member_id: z.number().int().positive().describe('Team member ID'),
  }),
  confirm: {
    action: 'Unlink team member from service',
    target: (input) =>
      `team member ${input.team_member_id} from service ${input.service_id} at location ${input.location_id}`,
    resolve: async (input, client) => {
      const [service, staff] = await Promise.all([
        client.getService(input.location_id, input.service_id),
        client.getStaff(input.location_id),
      ]);
      const member = staff.find(
        (candidate) => candidate.id === input.team_member_id
      );
      if (!member) return undefined;
      return `${member.name} (id ${member.id}) from service "${service.title}" (id ${service.id}) at location ${input.location_id}`;
    },
    consequence:
      'They stop offering this service: the pair disappears from online booking and appointments_create rejects it with HTTP 400 "team member does not provide the selected services". Appointments already booked for the pair are kept.',
  },
  handler: async ({ input, client }) => {
    await client.removeServiceFromStaff(
      input.location_id,
      input.service_id,
      input.team_member_id
    );
    return {
      text: `Unlinked team member ${input.team_member_id} from service ${input.service_id}`,
    };
  },
});

export const linkTeamMemberServicesTool = defineTool({
  name: 'team_members_link_services',
  category: 'Services',
  description:
    'Link one team member to many services with one session_length; reports each service (already linked fails alone).',
  annotations: {
    title: 'Link Team Member to Multiple Services',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    team_member_id: z.number().int().positive().describe('Team member ID'),
    service_ids: z
      .array(z.number().int().positive())
      .min(1)
      .describe('Service IDs to link this team member to'),
    session_length: seanceLengthSchema,
    technological_card_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe('Bill-of-materials (tech card) ID, or null'),
  }),
  handler: async ({ input, client }) => {
    const linked: number[] = [];
    const errors: string[] = [];
    for (const serviceId of input.service_ids) {
      try {
        await client.assignServiceToStaff(input.location_id, serviceId, {
          master_id: input.team_member_id,
          seance_length: input.session_length,
          technological_card_id: input.technological_card_id ?? null,
        });
        linked.push(serviceId);
      } catch (error) {
        errors.push(
          `service ${serviceId}: ${error instanceof Error ? error.message : 'unknown error'}`
        );
      }
    }
    const summary = `Linked team member ${input.team_member_id} to ${linked.length}/${input.service_ids.length} service(s).`;
    return {
      text:
        summary +
        (linked.length > 0 ? `\nLinked: ${linked.join(', ')}` : '') +
        (errors.length > 0 ? `\nFailed:\n  ${errors.join('\n  ')}` : ''),
      structuredContent: {
        team_member_id: input.team_member_id,
        linked,
        failed: errors.length,
        errors,
      },
    };
  },
});
