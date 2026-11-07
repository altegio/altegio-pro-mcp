/**
 * `[Gift cards]` tool pack — prepaid cards with a money balance, and the gift
 * card types they are sold from.
 *
 * Gift card types belong to a chain (`chain_id` from memberships_list_chains);
 * a location sells some of them, and one client's gift cards are looked up
 * through a location. Types: list (chain or location), read, create, update,
 * delete. Sold gift cards: one client's.
 *
 * Names, parameters and results use the product glossary; the wire vocabulary
 * (`certificate`, `salon`, `company_group`, `is_multi`, `item_type_id`,
 * `expiration_type_id`, `is_allow_empty_code`, `released_total`) stops in
 * `src/api/v1/gift-cards-adapter.ts`.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { pageArg, pageSizeArg, paginationOutput } from '../pagination.js';
import * as giftCards from '../../capabilities/gift-cards/use-cases.js';

// ========== shared input pieces ==========

const chainId = z
  .number()
  .int()
  .positive()
  .describe(
    'Chain id (memberships_list_chains; gift card type reads report it).'
  );

const typeId = z
  .number()
  .int()
  .positive()
  .describe('Gift card type id (gift_cards_list_types).');

const usage = z
  .enum([
    'services_and_products',
    'services',
    'products',
    'listed_services',
    'listed_services_and_products',
  ])
  .describe(
    'What the card pays for: services_and_products (default), services, products, listed_services (service_ids only), listed_services_and_products (service_ids and any product).'
  );

const expiry = z
  .object({
    type: z
      .enum(['never', 'fixed_date', 'after_sale'])
      .describe(
        'never (default); fixed_date: every card expires on date; after_sale: length × unit after its sale.'
      ),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
      .optional()
      .describe('With fixed_date: the expiry date, YYYY-MM-DD.'),
    length: z.number().int().min(1).max(3650).optional(),
    unit: z.enum(['day', 'week', 'month', 'year']).optional(),
  })
  .strict()
  .describe('When sold cards expire.');

const typeFieldInputs = {
  value: z
    .number()
    .positive()
    .describe('Face value: the balance a sold card starts with.'),
  location_ids: z
    .array(z.number().int().positive())
    .min(1)
    .describe('Locations of the chain that sell the type.'),
  multiple_use: z
    .boolean()
    .describe(
      'true (default): the balance is spent over several visits; false: spent at once.'
    ),
  usage,
  service_ids: z
    .array(z.number().int().positive())
    .max(500)
    .describe(
      'With a listed_* usage: the services it pays for (services_list).'
    ),
  expiry,
  balance_editable: z
    .boolean()
    .describe(
      'Staff may correct a sold card’s balance by hand. Default false.'
    ),
  sold_without_number: z
    .boolean()
    .describe('May be sold without a gift card number. Default false.'),
  online_sale_enabled: z
    .boolean()
    .describe('Sell it online. Default false; needs online_sale_price.'),
  online_sale_title: z.string().max(255).describe('Title in the online sale.'),
  online_sale_price: z
    .number()
    .positive()
    .describe('Price in the online sale; defaults to the face value.'),
  online_sale_description: z
    .string()
    .max(5000)
    .describe('Description in the online sale.'),
  type_category_id: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe(
      'The chain’s gift card type group (not a service category); null removes it.'
    ),
};

// ========== output schema pieces ==========

const int = { type: ['integer', 'null'] as const };
const num = { type: ['number', 'null'] as const };
const str = { type: ['string', 'null'] as const };
const bool = { type: 'boolean' as const };
const boolOrNull = { type: ['boolean', 'null'] as const };
const intListOrNull = {
  type: ['array', 'null'] as const,
  items: { type: 'integer' as const },
};

const typeSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'integer' as const },
    chain_id: int,
    title: str,
    value: num,
    multiple_use: boolOrNull,
    usage: {
      type: ['string', 'null'] as const,
      enum: [
        'services_and_products',
        'services',
        'products',
        'listed_services',
        'listed_services_and_products',
        null,
      ],
    },
    service_ids: intListOrNull,
    type_category_id: int,
    location_ids: intListOrNull,
    expiry: {
      type: 'object' as const,
      properties: {
        type: {
          type: ['string', 'null'] as const,
          enum: ['never', 'fixed_date', 'after_sale', null],
        },
        date: str,
        length: int,
        unit: {
          type: ['string', 'null'] as const,
          enum: ['day', 'week', 'month', 'year', null],
        },
      },
      required: ['type'],
    },
    balance_editable: boolOrNull,
    sold_without_number: boolOrNull,
    archived: bool,
    archived_at: str,
    online_sale_enabled: boolOrNull,
    online_sale_title: str,
    online_sale_price: num,
    online_sale_description: str,
    sold_count: int,
  },
  required: ['id', 'title', 'value', 'archived', 'expiry'],
};

const giftCardSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'integer' as const },
    number: str,
    chain_id: int,
    type_id: int,
    type_title: str,
    status: {
      type: 'string' as const,
      enum: ['issued', 'active', 'used_up', 'expired', 'unknown'],
    },
    balance: num,
    initial_balance: num,
    multiple_use: boolOrNull,
    created_at: str,
    expires_at: str,
  },
  required: ['id', 'status', 'balance'],
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const typePageSchema = (scope: 'chain_id' | 'location_id') => ({
  type: 'object' as const,
  properties: {
    [scope]: { type: 'integer' as const },
    items: { type: 'array' as const, items: typeSchema },
    pagination: paginationOutput,
  },
  required: ['items', 'pagination'],
});

// ========== gift card types: reads ==========

export const giftCardsListTypesTool = defineTool({
  name: 'gift_cards_list_types',
  category: 'Gift cards',
  description:
    'Gift card types of a chain (the templates gift cards are sold from): face value, what it pays for, single or multiple use, expiry, sold count, archived flag; filter by title. Paged: follow pagination.next_page. Locations and online sale of one: gift_cards_get_type. Without chain rights: gift_cards_list_location_types.',
  annotations: { title: 'Gift cards: list gift card types', ...READ_ONLY },
  input: z.object({
    chain_id: chainId,
    query: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('Part of the gift card type title.'),
    page: pageArg,
    page_size: pageSizeArg(100),
  }),
  outputSchema: typePageSchema('chain_id'),
  handler: async ({ input, client }) => giftCards.listChainTypes(client, input),
});

export const giftCardsListLocationTypesTool = defineTool({
  name: 'gift_cards_list_location_types',
  category: 'Gift cards',
  description:
    'Gift card types a location sells — what can be sold here: face value, what it pays for, single or multiple use, expiry; filter by title. Needs only loyalty access in the location. Paged: follow pagination.next_page. Full settings of one: gift_cards_get_type with its chain_id.',
  annotations: {
    title: 'Gift cards: types sold at a location',
    ...READ_ONLY,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('From locations_list.'),
    query: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('Part of the gift card type title.'),
    page: pageArg,
    page_size: pageSizeArg(100),
  }),
  outputSchema: typePageSchema('location_id'),
  handler: async ({ input, client }) =>
    giftCards.listLocationTypes(client, input),
});

export const giftCardsGetTypeTool = defineTool({
  name: 'gift_cards_get_type',
  category: 'Gift cards',
  description:
    'One gift card type with every setting: face value, what it pays for and the listed services, single or multiple use, expiry, whether staff may correct a balance, sale without a number, online sale, type group, selling locations and sold count.',
  annotations: { title: 'Gift cards: get a gift card type', ...READ_ONLY },
  input: z.object({ chain_id: chainId, type_id: typeId }),
  outputSchema: typeSchema,
  handler: async ({ input, client }) => giftCards.getType(client, input),
});

// ========== gift card types: writes ==========

export const giftCardsCreateTypeTool = defineTool({
  name: 'gift_cards_create_type',
  category: 'Gift cards',
  description:
    'Create a gift card type in a chain ("gift card for 1000"): title, face value, selling locations; optional usage (what it pays for, listed services), single or multiple use, expiry, balance corrections, sale without a number, online sale, type group. Once a card of it is sold, the type cannot be changed or deleted.',
  annotations: {
    title: 'Gift cards: create a gift card type',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    chain_id: chainId,
    title: z.string().min(1).max(255).describe('Name of the gift card type.'),
    value: typeFieldInputs.value,
    location_ids: typeFieldInputs.location_ids,
    multiple_use: typeFieldInputs.multiple_use.optional(),
    usage: typeFieldInputs.usage.optional(),
    service_ids: typeFieldInputs.service_ids.optional(),
    expiry: typeFieldInputs.expiry.optional(),
    balance_editable: typeFieldInputs.balance_editable.optional(),
    sold_without_number: typeFieldInputs.sold_without_number.optional(),
    online_sale_enabled: typeFieldInputs.online_sale_enabled.optional(),
    online_sale_title: typeFieldInputs.online_sale_title.optional(),
    online_sale_price: typeFieldInputs.online_sale_price.optional(),
    online_sale_description: typeFieldInputs.online_sale_description.optional(),
    type_category_id: typeFieldInputs.type_category_id.optional(),
  }),
  outputSchema: typeSchema,
  handler: async ({ input, client }) => giftCards.createType(client, input),
});

export const giftCardsUpdateTypeTool = defineTool({
  name: 'gift_cards_update_type',
  category: 'Gift cards',
  description:
    'Change a gift card type that has no sold cards (read it with gift_cards_get_type; pass only changes; service_ids and location_ids replace the lists). A type with sold cards cannot be changed: create a new one. Sold cards keep their terms.',
  annotations: {
    title: 'Gift cards: update a gift card type',
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    chain_id: chainId,
    type_id: typeId,
    title: z.string().min(1).max(255).optional(),
    value: typeFieldInputs.value.optional(),
    location_ids: typeFieldInputs.location_ids.optional(),
    multiple_use: typeFieldInputs.multiple_use.optional(),
    usage: typeFieldInputs.usage.optional(),
    service_ids: typeFieldInputs.service_ids.optional(),
    expiry: typeFieldInputs.expiry.optional(),
    balance_editable: typeFieldInputs.balance_editable.optional(),
    sold_without_number: typeFieldInputs.sold_without_number.optional(),
    online_sale_enabled: typeFieldInputs.online_sale_enabled.optional(),
    online_sale_title: typeFieldInputs.online_sale_title.optional(),
    online_sale_price: typeFieldInputs.online_sale_price.optional(),
    online_sale_description: typeFieldInputs.online_sale_description.optional(),
    type_category_id: typeFieldInputs.type_category_id.optional(),
  }),
  outputSchema: typeSchema,
  handler: async ({ input, client }) => giftCards.updateType(client, input),
});

export const giftCardsDeleteTypeTool = defineTool({
  name: 'gift_cards_delete_type',
  category: 'Gift cards',
  description:
    'Delete a gift card type that has never been sold. A type with sold gift cards cannot be deleted. Asks for confirmation first.',
  annotations: {
    title: 'Gift cards: delete a gift card type',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({ chain_id: chainId, type_id: typeId }),
  confirm: {
    action: 'Delete gift card type',
    target: (input) =>
      `gift card type ${input.type_id} in chain ${input.chain_id}`,
    resolve: (input, client) => giftCards.describeType(client, input),
    consequence:
      'The gift card type is removed from the whole chain: no location can sell it any more. The API refuses when gift cards of the type were already sold. A deleted type cannot be restored from here.',
  },
  handler: async ({ input, client }) => giftCards.deleteType(client, input),
});

// ========== sold gift cards ==========

export const giftCardsListForClientTool = defineTool({
  name: 'gift_cards_list_for_client',
  category: 'Gift cards',
  description:
    'A client’s gift cards: number, status (issued, active, used up, expired), balance left of the initial one, type and chain, expiry. Found by the client card phone; one sold under an earlier phone is missed.',
  annotations: {
    title: 'Gift cards: a client’s gift cards',
    ...READ_ONLY,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('From locations_list.'),
    client_id: z
      .number()
      .int()
      .positive()
      .describe('Client id, from clients_lookup or clients_search.'),
    page: pageArg,
    page_size: pageSizeArg(100),
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      client_id: { type: 'integer' as const },
      currency: str,
      items: { type: 'array' as const, items: giftCardSchema },
      pagination: paginationOutput,
    },
    required: ['location_id', 'client_id', 'items', 'pagination'],
  },
  handler: async ({ input, client }) =>
    giftCards.listClientGiftCards(client, input),
});
