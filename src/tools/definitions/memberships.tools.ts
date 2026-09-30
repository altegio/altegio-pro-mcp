/**
 * `[Memberships]` tool pack — prepaid passes for a number of visits or a
 * period, and the membership types they are sold from.
 *
 * Membership types and the memberships sold from them belong to a chain, so
 * most tools take a `chain_id` (from `memberships_list_chains`); one client's
 * memberships are looked up through a location. Types: list, read, create,
 * update, archive, delete. Sold memberships: list, one client's, freeze,
 * unfreeze, change the balance or the validity.
 *
 * Names, parameters and results use the product glossary; the wire vocabulary
 * (`abonement`, `salon_group`, `cost`, `is_united_balance`,
 * `is_allow_empty_code`, `balance_container`) stops in
 * `src/api/v1/memberships-adapter.ts`.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { pageArg, pageSizeArg, paginationOutput } from '../pagination.js';
import * as memberships from '../../capabilities/memberships/use-cases.js';

// ========== shared input pieces ==========

const chainId = z
  .number()
  .int()
  .positive()
  .describe(
    'Chain the membership types and memberships belong to. Call memberships_list_chains when the id is unknown; a membership read also reports its chain_id.'
  );

const typeId = z
  .number()
  .int()
  .positive()
  .describe('Membership type id, from memberships_list_types.');

const membershipId = z
  .number()
  .int()
  .positive()
  .describe(
    'Membership id (not its number), from memberships_list_for_client or memberships_list.'
  );

const unit = z
  .enum(['day', 'week', 'month', 'year'])
  .describe('day, week, month or year.');

const duration = (what: string) =>
  z
    .object({
      length: z.number().int().min(1).max(3650).describe('How many units.'),
      unit,
    })
    .strict()
    .describe(what);

const date = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .describe(`${what} As YYYY-MM-DD.`);

const allowance = z
  .object({
    service_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('A service the membership covers.'),
    service_category_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Or a whole service category it covers.'),
    visits: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe(
        'Visits included for this service under a per_service balance. Leave out under a shared balance.'
      ),
    unlimited: z
      .boolean()
      .optional()
      .describe(
        'Unlimited visits for this service under a per_service balance (needs a validity). Not every chain has unlimited memberships enabled.'
      ),
  })
  .strict();

const typeFieldInputs = {
  price: z.number().min(0).describe('Price of the membership.'),
  location_ids: z
    .array(z.number().int().positive())
    .min(1)
    .describe('Locations of the chain that sell the type.'),
  services: z
    .array(allowance)
    .min(1)
    .max(200)
    .describe(
      'Services and service categories the membership covers, each with service_id or service_category_id. Ids are the chain’s: see services_list and service_categories_list.'
    ),
  balance_type: z
    .enum(['per_service', 'shared'])
    .describe(
      'per_service: a separate number of visits for each covered service (set visits on each). shared: one pool of visits for any covered service (set shared_visits). Default per_service.'
    ),
  shared_visits: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .describe('Visits in the shared pool, under a shared balance.'),
  shared_unlimited: z
    .boolean()
    .describe(
      'Unlimited visits in the shared pool, instead of shared_visits (needs a validity). Not every chain has unlimited memberships enabled.'
    ),
  validity: duration(
    'How long a membership stays valid once activated, e.g. { length: 3, unit: "month" }. Omitted: it never expires.'
  ).nullable(),
  activation: z
    .enum(['first_visit', 'sale'])
    .describe('When validity starts: first_visit (default) or sale.'),
  auto_activation_after: duration(
    'With activation first_visit: an unused membership activates by itself this long after the sale. Omitted: never by itself.'
  ).nullable(),
  personal: z
    .boolean()
    .describe(
      'true: only the client who bought it (or the one it was given to) uses it, without entering its number. false (default): paying with it needs its number, and whoever has the number can use it.'
    ),
  freeze_allowed: z
    .boolean()
    .describe(
      'Whether a membership can be frozen (needs a validity). Default false.'
    ),
  freeze_limit: duration(
    'Longest total freeze per membership. Omitted: no limit.'
  ).nullable(),
  online_booking_while_frozen: z
    .boolean()
    .describe(
      'Whether clients can still book online with a frozen membership. Default false.'
    ),
  recalculate_service_price: z
    .boolean()
    .describe(
      'Recalculate the service price when a visit is paid with the membership. Default false; not allowed for unlimited memberships.'
    ),
  balance_edit: z
    .enum(['not_allowed', 'sale_location', 'any_location'])
    .describe(
      'Where team members may correct the balance of a sold membership by hand: not_allowed (default), sale_location or any_location of the chain.'
    ),
  online_sale_enabled: z
    .boolean()
    .describe('Sell the type online. Default false; needs online_sale_price.'),
  online_sale_title: z
    .string()
    .max(255)
    .describe('Title shown in the online sale.'),
  online_sale_price: z.number().min(0).describe('Price in the online sale.'),
  online_sale_description: z
    .string()
    .max(5000)
    .describe('Description shown in the online sale.'),
  type_category_id: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe(
      'The chain’s grouping of membership types (not a service category); null removes it.'
    ),
};

// ========== output schema pieces ==========

const int = { type: ['integer', 'null'] as const };
const num = { type: ['number', 'null'] as const };
const str = { type: ['string', 'null'] as const };
const bool = { type: 'boolean' as const };
const boolOrNull = { type: ['boolean', 'null'] as const };
const intList = { type: 'array' as const, items: { type: 'integer' as const } };

const durationSchema = {
  type: ['object', 'null'] as const,
  properties: {
    length: { type: 'integer' as const },
    unit: { type: 'string' as const, enum: ['day', 'week', 'month', 'year'] },
  },
};

const allowanceSchema = {
  type: 'object' as const,
  properties: {
    service_id: int,
    service_category_id: int,
    title: str,
    visits: int,
    unlimited: bool,
  },
  required: ['service_id', 'service_category_id', 'visits', 'unlimited'],
};

const typeSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'integer' as const },
    chain_id: int,
    title: str,
    price: num,
    archived: bool,
    archived_at: str,
    validity: durationSchema,
    activation: {
      type: ['string', 'null'] as const,
      enum: ['first_visit', 'sale', null],
    },
    auto_activation_after: durationSchema,
    personal: boolOrNull,
    balance_type: { type: 'string' as const, enum: ['shared', 'per_service'] },
    shared_visits: int,
    shared_unlimited: bool,
    services: { type: 'array' as const, items: allowanceSchema },
    freeze_allowed: bool,
    freeze_limit: durationSchema,
    online_booking_while_frozen: bool,
    recalculate_service_price: bool,
    balance_edit: {
      type: ['string', 'null'] as const,
      enum: ['not_allowed', 'sale_location', 'any_location', null],
    },
    time_restricted: bool,
    online_sale_enabled: bool,
    online_sale_title: str,
    online_sale_price: num,
    online_sale_description: str,
    location_ids: {
      type: ['array', 'null'] as const,
      items: { type: 'integer' as const },
    },
    sold_count: int,
    type_category_id: int,
  },
  required: ['id', 'title', 'price', 'archived', 'balance_type', 'services'],
};

const membershipSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'integer' as const },
    number: str,
    chain_id: int,
    type_id: int,
    type_title: str,
    status: {
      type: 'string' as const,
      enum: ['issued', 'active', 'expired', 'used_up', 'unknown'],
    },
    created_at: str,
    activated_at: str,
    expires_at: str,
    frozen: bool,
    frozen_days: int,
    validity: durationSchema,
    balance_type: { type: 'string' as const, enum: ['shared', 'per_service'] },
    shared_visits_left: int,
    shared_unlimited: bool,
    services: { type: 'array' as const, items: allowanceSchema },
    sale_transaction_id: int,
  },
  required: [
    'id',
    'chain_id',
    'type_id',
    'status',
    'frozen',
    'balance_type',
    'services',
  ],
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

// ========== chains ==========

export const membershipsListChainsTool = defineTool({
  name: 'memberships_list_chains',
  category: 'Memberships',
  description:
    'The chains the signed-in user belongs to — each with its locations and the user’s membership rights there: loyalty, managing membership types, changing sold memberships (freeze, validity, balance) and editing balances. Membership types and sold memberships belong to a chain, so start here for the chain_id the other memberships_* tools take, and when one of them is refused for lack of rights. A location can belong to several chains; the user’s rights are per chain.',
  annotations: { title: 'Memberships: chains and rights', ...READ_ONLY },
  input: z.object({}),
  outputSchema: {
    type: 'object' as const,
    properties: {
      items: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            id: { type: 'integer' as const },
            title: str,
            location_ids: intList,
            location_titles: {
              type: 'array' as const,
              items: { type: 'string' as const },
            },
            rights: {
              type: 'object' as const,
              properties: {
                loyalty: boolOrNull,
                manage_membership_types: boolOrNull,
                change_memberships: boolOrNull,
                edit_membership_balance: boolOrNull,
                read_membership_history: boolOrNull,
              },
            },
          },
          required: ['id', 'location_ids', 'rights'],
        },
      },
      pagination: paginationOutput,
    },
    required: ['items', 'pagination'],
  },
  handler: async ({ client }) => memberships.listChains(client),
});

// ========== membership types: reads ==========

export const membershipsListTypesTool = defineTool({
  name: 'memberships_list_types',
  category: 'Memberships',
  description:
    'List the membership types of a chain — the templates memberships are sold from — with price, the services and service categories each covers, balance (a shared pool of visits or visits per service), validity and activation, freezing rules and how many were sold. Active types by default; archived: true lists the archived ones instead. Filter by part of the title. Paged: follow pagination.next_page until it is null. Locations that sell a type are in memberships_get_type.',
  annotations: { title: 'Memberships: list membership types', ...READ_ONLY },
  input: z.object({
    chain_id: chainId,
    query: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('Part of the membership type title.'),
    archived: z
      .boolean()
      .optional()
      .describe('List archived types instead of active ones. Default false.'),
    page: pageArg,
    page_size: pageSizeArg(100),
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      chain_id: { type: 'integer' as const },
      archived: bool,
      items: { type: 'array' as const, items: typeSchema },
      pagination: paginationOutput,
    },
    required: ['items', 'pagination'],
  },
  handler: async ({ input, client }) => memberships.listTypes(client, input),
});

export const membershipsGetTypeTool = defineTool({
  name: 'memberships_get_type',
  category: 'Memberships',
  description:
    'One membership type with every setting: price, covered services and service categories with their visits, balance, validity and activation, auto-activation, whether it is personal, freezing rules, price recalculation, who may correct balances, online sale, and the locations that sell it.',
  annotations: { title: 'Memberships: get a membership type', ...READ_ONLY },
  input: z.object({ chain_id: chainId, type_id: typeId }),
  outputSchema: typeSchema,
  handler: async ({ input, client }) => memberships.getType(client, input),
});

// ========== membership types: writes ==========

export const membershipsCreateTypeTool = defineTool({
  name: 'memberships_create_type',
  category: 'Memberships',
  description:
    'Create a membership type in a chain — "10 haircuts for 3 months", "a month of unlimited yoga". Required: title, price, the locations that sell it and the covered services or service categories. Balance per_service (visits per service, the default) or shared (one pool of visits, shared_visits); validity and when it starts (first visit or sale); optional freezing, auto-activation, personal use, price recalculation, balance corrections and online sale. Once the first membership is sold, the price, validity, activation, personal flag, balance and covered services are fixed. Needs the right to manage membership types in the chain (memberships_list_chains).',
  annotations: {
    title: 'Memberships: create a membership type',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    chain_id: chainId,
    title: z.string().min(1).max(255).describe('Name of the membership type.'),
    price: typeFieldInputs.price,
    location_ids: typeFieldInputs.location_ids,
    services: typeFieldInputs.services,
    balance_type: typeFieldInputs.balance_type.optional(),
    shared_visits: typeFieldInputs.shared_visits.optional(),
    shared_unlimited: typeFieldInputs.shared_unlimited.optional(),
    validity: typeFieldInputs.validity.optional(),
    activation: typeFieldInputs.activation.optional(),
    auto_activation_after: typeFieldInputs.auto_activation_after.optional(),
    personal: typeFieldInputs.personal.optional(),
    freeze_allowed: typeFieldInputs.freeze_allowed.optional(),
    freeze_limit: typeFieldInputs.freeze_limit.optional(),
    online_booking_while_frozen:
      typeFieldInputs.online_booking_while_frozen.optional(),
    recalculate_service_price:
      typeFieldInputs.recalculate_service_price.optional(),
    balance_edit: typeFieldInputs.balance_edit.optional(),
    online_sale_enabled: typeFieldInputs.online_sale_enabled.optional(),
    online_sale_title: typeFieldInputs.online_sale_title.optional(),
    online_sale_price: typeFieldInputs.online_sale_price.optional(),
    online_sale_description: typeFieldInputs.online_sale_description.optional(),
    type_category_id: typeFieldInputs.type_category_id.optional(),
  }),
  outputSchema: typeSchema,
  handler: async ({ input, client }) => memberships.createType(client, input),
});

export const membershipsUpdateTypeTool = defineTool({
  name: 'memberships_update_type',
  category: 'Memberships',
  description:
    'Change a membership type: read its current settings with memberships_get_type, then pass only what changes; everything else is kept. services replaces the whole list of covered services. After the first membership of the type is sold, only the title, locations, freezing, price recalculation, balance corrections, online sale and type category can change (a shared balance can still gain services); a request for the fixed fields saves the rest and reports what was kept. For new terms create a new type and archive this one. An archived type must be unarchived first. Memberships already sold keep their own balance and validity.',
  annotations: {
    title: 'Memberships: update a membership type',
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    chain_id: chainId,
    type_id: typeId,
    title: z.string().min(1).max(255).optional(),
    price: typeFieldInputs.price.optional(),
    location_ids: typeFieldInputs.location_ids.optional(),
    services: typeFieldInputs.services.optional(),
    balance_type: typeFieldInputs.balance_type.optional(),
    shared_visits: typeFieldInputs.shared_visits.optional(),
    shared_unlimited: typeFieldInputs.shared_unlimited.optional(),
    validity: typeFieldInputs.validity.optional(),
    activation: typeFieldInputs.activation.optional(),
    auto_activation_after: typeFieldInputs.auto_activation_after.optional(),
    personal: typeFieldInputs.personal.optional(),
    freeze_allowed: typeFieldInputs.freeze_allowed.optional(),
    freeze_limit: typeFieldInputs.freeze_limit.optional(),
    online_booking_while_frozen:
      typeFieldInputs.online_booking_while_frozen.optional(),
    recalculate_service_price:
      typeFieldInputs.recalculate_service_price.optional(),
    balance_edit: typeFieldInputs.balance_edit.optional(),
    online_sale_enabled: typeFieldInputs.online_sale_enabled.optional(),
    online_sale_title: typeFieldInputs.online_sale_title.optional(),
    online_sale_price: typeFieldInputs.online_sale_price.optional(),
    online_sale_description: typeFieldInputs.online_sale_description.optional(),
    type_category_id: typeFieldInputs.type_category_id.optional(),
  }),
  outputSchema: typeSchema,
  handler: async ({ input, client }) => memberships.updateType(client, input),
});

export const membershipsArchiveTypeTool = defineTool({
  name: 'memberships_archive_type',
  category: 'Memberships',
  description:
    'Archive a membership type so it is no longer sold, or unarchive it (archived: false) to sell it again. Memberships already sold keep working either way. Use it instead of memberships_delete_type for a type with sold memberships.',
  annotations: {
    title: 'Memberships: archive or unarchive a type',
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    chain_id: chainId,
    type_id: typeId,
    archived: z
      .boolean()
      .default(true)
      .describe('true (default) archives the type; false unarchives it.'),
  }),
  outputSchema: typeSchema,
  handler: async ({ input, client }) => memberships.archiveType(client, input),
});

export const membershipsDeleteTypeTool = defineTool({
  name: 'memberships_delete_type',
  category: 'Memberships',
  description:
    'Delete a membership type that has never been sold. A type with sold memberships cannot be deleted — archive it with memberships_archive_type instead. Asks for confirmation first.',
  annotations: {
    title: 'Memberships: delete a membership type',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({ chain_id: chainId, type_id: typeId }),
  confirm: {
    action: 'Delete membership type',
    target: (input) =>
      `membership type ${input.type_id} in chain ${input.chain_id}`,
    resolve: (input, client) => memberships.describeType(client, input),
    consequence:
      'The membership type is removed from the whole chain: no location can sell it any more. The API refuses when memberships of the type were already sold. A deleted type cannot be restored from here; to only stop selling it, archive it instead.',
  },
  handler: async ({ input, client }) => memberships.deleteType(client, input),
});

// ========== sold memberships: reads ==========

export const membershipsListTool = defineTool({
  name: 'memberships_list',
  category: 'Memberships',
  description:
    'Sold memberships of a chain, by id or by the period they were created in (created_from and created_to, YYYY-MM-DD) — with number, type, status (issued, active, expired, used_up), frozen flag, visits left per service or in the shared pool, activation and expiration dates. The creation date is not a sale date and the list does not name clients: for one client’s memberships use memberships_list_for_client. Paged: follow pagination.next_page until it is null.',
  annotations: { title: 'Memberships: list sold memberships', ...READ_ONLY },
  input: z.object({
    chain_id: chainId,
    membership_ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(100)
      .optional()
      .describe('Read these memberships.'),
    created_from: date('Or: first day of the creation period.').optional(),
    created_to: date('Last day of the creation period, inclusive.').optional(),
    page: pageArg,
    page_size: pageSizeArg(100),
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      chain_id: { type: 'integer' as const },
      period: {
        type: 'object' as const,
        properties: { from: str, to: str },
      },
      items: { type: 'array' as const, items: membershipSchema },
      pagination: paginationOutput,
    },
    required: ['items', 'pagination'],
  },
  handler: async ({ input, client }) =>
    memberships.listMemberships(client, input),
});

export const membershipsListForClientTool = defineTool({
  name: 'memberships_list_for_client',
  category: 'Memberships',
  description:
    'A client’s current memberships — issued, active or frozen — with number, type, visits left per service or in the shared pool, activation and expiration dates, and the chain_id each belongs to (the id the freeze, balance and validity tools take). Found by the phone on the client card in the given location; expired and used-up memberships are not listed, and one sold under an earlier phone is missed. For how and when each was paid use clients_get_membership_purchases.',
  annotations: {
    title: 'Memberships: a client’s current memberships',
    ...READ_ONLY,
  },
  input: z.object({
    location_id: z
      .number()
      .int()
      .positive()
      .describe(
        'Location whose client card to use. Call locations_list when the id is unknown.'
      ),
    client_id: z
      .number()
      .int()
      .positive()
      .describe('Client id, from clients_lookup or clients_search.'),
    chain_id: chainId
      .optional()
      .describe('Only memberships of this chain. Default: every chain.'),
    page: pageArg,
    page_size: pageSizeArg(100),
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      client_id: { type: 'integer' as const },
      chain_id: { type: 'integer' as const },
      items: { type: 'array' as const, items: membershipSchema },
      pagination: paginationOutput,
    },
    required: ['items', 'pagination'],
  },
  handler: async ({ input, client }) =>
    memberships.listClientMemberships(client, input),
});

// ========== sold memberships: writes ==========

export const membershipsFreezeTool = defineTool({
  name: 'memberships_freeze',
  category: 'Memberships',
  description:
    'Freeze a sold membership — the client is away or ill. Until a date (until, YYYY-MM-DD, unfreezes by itself) or until memberships_unfreeze. The days it stays frozen are added to its expiration date. The membership type must allow freezing, and the date must fit the freeze limit left.',
  annotations: {
    title: 'Memberships: freeze a membership',
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    chain_id: chainId,
    membership_id: membershipId,
    until: date('Unfreeze by itself on this date, in the future.').optional(),
  }),
  outputSchema: membershipSchema,
  handler: async ({ input, client }) =>
    memberships.freezeMembership(client, input),
});

export const membershipsUnfreezeTool = defineTool({
  name: 'memberships_unfreeze',
  category: 'Memberships',
  description:
    'Unfreeze a frozen membership now; its expiration date keeps the days it spent frozen.',
  annotations: {
    title: 'Memberships: unfreeze a membership',
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({ chain_id: chainId, membership_id: membershipId }),
  outputSchema: membershipSchema,
  handler: async ({ input, client }) =>
    memberships.unfreezeMembership(client, input),
});

export const membershipsSetBalanceTool = defineTool({
  name: 'memberships_set_balance',
  category: 'Memberships',
  description:
    'Correct the visits left on a sold membership: shared_visits for a shared balance, or services (each with service_id or service_category_id and visits) for a per-service balance — the numbers replace what is left. 0 everywhere marks it used up; a number above 0 reactivates a used-up one. Unlimited balances cannot be changed. Read the membership first with memberships_list_for_client or memberships_list. Asks for confirmation first.',
  annotations: {
    title: 'Memberships: correct the balance',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    chain_id: chainId,
    membership_id: membershipId,
    shared_visits: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe('New visits left in the shared pool.'),
    services: z
      .array(
        z
          .object({
            service_id: z.number().int().positive().optional(),
            service_category_id: z.number().int().positive().optional(),
            visits: z
              .number()
              .int()
              .min(0)
              .max(10000)
              .describe('New visits left for it.'),
          })
          .strict()
      )
      .min(1)
      .max(200)
      .optional()
      .describe(
        'New visits left per covered service or service category; the ones not listed keep theirs.'
      ),
  }),
  confirm: {
    action: 'Change membership balance',
    target: (input) =>
      `membership ${input.membership_id} in chain ${input.chain_id}`,
    resolve: (input, client) => memberships.describeMembership(client, input),
    consequence: (input) =>
      `The visits left on the membership are overwritten with ${input.shared_visits !== undefined ? `${input.shared_visits} in the shared pool` : 'the new numbers per service'}; the previous balance is not kept except in the membership history. With nothing left the membership becomes used up and can no longer pay for visits.`,
  },
  handler: async ({ input, client }) => memberships.setBalance(client, input),
});

export const membershipsSetValidityTool = defineTool({
  name: 'memberships_set_validity',
  category: 'Memberships',
  description:
    'Change how long a sold membership is valid — to extend it or correct it. The expiration date is recalculated from its activation; a membership not activated yet has none until it activates. The new expiration date cannot fall before its last use, and a validity that ends in the past expires it. Asks for confirmation first.',
  annotations: {
    title: 'Memberships: change the validity',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    chain_id: chainId,
    membership_id: membershipId,
    validity: duration(
      'New validity counted from activation, e.g. { length: 2, unit: "month" }.'
    ),
  }),
  confirm: {
    action: 'Change membership validity',
    target: (input) =>
      `membership ${input.membership_id} in chain ${input.chain_id}`,
    resolve: (input, client) => memberships.describeMembership(client, input),
    consequence: (input) =>
      `The membership's validity becomes ${input.validity?.length ?? '?'} ${input.validity?.unit ?? ''}(s) from its activation and its expiration date is recalculated; a shorter validity can expire it at once, after which it no longer pays for visits.`,
  },
  handler: async ({ input, client }) => memberships.setValidity(client, input),
});
