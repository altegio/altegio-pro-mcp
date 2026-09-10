import { z } from 'zod';
import { defineTool } from '../factory.js';
import { servicesOutput, serviceEntityOutput } from '../output-schemas.js';
import type { AltegioService } from '../../types/altegio.types.js';

const seanceLengthSchema = z
  .number()
  .int()
  .min(300)
  .max(86100)
  .describe(
    'Duration this team member needs for the service, in seconds (min 300, max 86100)'
  );

function servicePrice(service: AltegioService): {
  min: number | null;
  max: number | null;
} {
  const min = service.price_min ?? service.cost ?? null;
  const max = service.price_max ?? min;
  return { min, max };
}

function servicePriceText(service: AltegioService): string {
  const { min, max } = servicePrice(service);
  if (min === null) return 'not reported';
  return max !== null && max !== min ? `${min}–${max}` : String(min);
}

function projectService(service: AltegioService) {
  const { min, max } = servicePrice(service);
  return {
    id: service.id,
    title: service.title,
    category_id: service.category_id ?? null,
    price_min: min,
    price_max: max,
    duration_seconds: service.duration ?? null,
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
  name: 'get_services',
  category: 'Services',
  description:
    '[Services] Get list of services available at a location. AUTHENTICATION REQUIRED - administrative access to view all services with full pricing, settings, and configuration (not just public online-booking info). User must be logged in and have access to the location. PAGINATION STRATEGY: May return many services (50+). RECOMMENDED: Start with count=30-50 to show main services. User can request more or use categories for better organization.',
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
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        '1-based page number for pagination (default 1). Use 2 for the next page.'
      ),
    count: z
      .number()
      .int()
      .positive()
      .max(300)
      .optional()
      .describe(
        'Results per page. Default may be large. RECOMMENDED: Use 30-50 for initial display. Max 300.'
      ),
  }),
  outputSchema: servicesOutput,
  handler: async ({ input, client }) => {
    const { location_id, ...listParams } = input;
    const services = await client.getServices(
      location_id,
      Object.keys(listParams).length > 0 ? listParams : undefined
    );

    const summary = `Found ${services.length} ${services.length === 1 ? 'service' : 'services'} for location ${location_id}:\n\n`;
    const servicesList = services
      .map(
        (s, idx) =>
          `${idx + 1}. ID: ${s.id} - "${s.title}"\n` +
          `   Price: ${servicePriceText(s)}\n` +
          `   Active: ${s.active === undefined ? 'not reported' : Boolean(Number(s.active))}\n` +
          `   Duration: ${s.duration === undefined ? 'not reported' : `${s.duration} seconds`}` +
          `${s.category_id ? `\n   Category ID: ${s.category_id}` : ''}\n` +
          `   Team members: ${s.staff?.length ?? 0}`
      )
      .join('\n\n');

    return {
      text: summary + servicesList,
      structuredContent: {
        items: services.map(projectService),
        count: services.length,
      },
    };
  },
});

export const createServiceTool = defineTool({
  name: 'create_service',
  category: 'Services',
  description:
    '[Services] Create a new service. AUTHENTICATION REQUIRED. Required fields: title, category_id. Services are active and usable by default; pass active=0 only to create a hidden draft. Link at least one team member before booking it.',
  annotations: {
    title: 'Create Service',
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
    duration: z.number().positive().optional().describe('Duration in seconds'),
    prepaid: z.string().optional().describe('Prepaid option'),
    active: z
      .number()
      .int()
      .min(0)
      .max(1)
      .optional()
      .default(1)
      .describe('1 (default) creates an active service; 0 creates a draft'),
  }),
  outputSchema: serviceEntityOutput,
  handler: async ({ input, client }) => {
    const { location_id, ...serviceData } = input;
    const service = await client.createService(location_id, serviceData);
    return {
      text:
        `Successfully created service:\nID: ${service.id}\nTitle: ${service.title}\n` +
        `Category: ${service.category_id ?? 'not reported'}\n` +
        `Active: ${service.active === undefined ? 'not reported by create response' : Boolean(Number(service.active))}`,
      structuredContent: projectService(service),
    };
  },
});

export const updateServiceTool = defineTool({
  name: 'update_service',
  category: 'Services',
  description:
    '[Services] Safely update an existing service. AUTHENTICATION REQUIRED. Provide only fields to change; the tool reads the current service and preserves all unchanged writable fields and team-member links before sending the documented V1 PUT.',
  annotations: {
    title: 'Update Service',
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
    duration: z.number().positive().optional().describe('Duration in seconds'),
    active: z.number().int().min(0).max(1).optional().describe('0 or 1'),
  }),
  outputSchema: serviceEntityOutput,
  handler: async ({ input, client }) => {
    const { location_id, service_id, ...updateData } = input;
    const service = await client.updateService(
      location_id,
      service_id,
      updateData
    );
    return {
      text:
        `Successfully updated service ${service_id}:\nTitle: ${service.title}\n` +
        `Active: ${service.active === undefined ? 'not reported' : Boolean(Number(service.active))}\n` +
        `Team-member links preserved: ${service.staff?.length ?? 'not reported by update response'}`,
      structuredContent: projectService(service),
    };
  },
});

export const deleteServiceTool = defineTool({
  name: 'delete_service',
  category: 'Services',
  description:
    '[Services] Permanently delete a service. AUTHENTICATION REQUIRED. This removes the service entirely; to merely hide it from booking, use update_service with active=0 instead.',
  annotations: {
    title: 'Delete Service',
    destructiveHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    service_id: z.number().int().positive().describe('Service ID to delete'),
  }),
  handler: async ({ input, client }) => {
    await client.deleteService(input.location_id, input.service_id);
    return {
      text: `Successfully deleted service ${input.service_id} from location ${input.location_id}`,
    };
  },
});

// ========== Service ↔ Team Member Links ==========

export const linkServiceTeamMemberTool = defineTool({
  name: 'link_service_team_member',
  category: 'Services',
  description:
    '[Services] Link a team member to a service so they can perform it. AUTHENTICATION REQUIRED. Required to create appointments: without the link, create_appointment fails with HTTP 400 "team member does not provide the selected services". If the link already exists, use update_service_team_member to change its duration.',
  annotations: {
    title: 'Link Team Member to Service',
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
      .describe('Bill-of-materials (tech card) ID, or null'),
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
  name: 'update_service_team_member',
  category: 'Services',
  description:
    '[Services] Update an existing team member ↔ service link (session duration or tech card). AUTHENTICATION REQUIRED. Use link_service_team_member to create the link first.',
  annotations: {
    title: 'Update Team Member Service Link',
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
  name: 'unlink_service_team_member',
  category: 'Services',
  description:
    '[Services] Remove the link between a team member and a service (they stop offering it). AUTHENTICATION REQUIRED.',
  annotations: {
    title: 'Unlink Team Member from Service',
    destructiveHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    service_id: z.number().int().positive().describe('Service ID'),
    team_member_id: z.number().int().positive().describe('Team member ID'),
  }),
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
  name: 'link_team_member_services',
  category: 'Services',
  description:
    '[Services] Bulk-link ONE team member to MANY services in a single call. AUTHENTICATION REQUIRED. Applies the same session_length to every service. Reports per-service success/failure (already-linked services fail individually without stopping the rest).',
  annotations: {
    title: 'Link Team Member to Multiple Services',
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
