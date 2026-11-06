/**
 * V1 adapter for the `GiftCardsApi` port.
 *
 * V2 has no gift card operation, so every call runs on V1, on the spec's
 * `gift_card*` URLs, which the backend serves as aliases of its legacy
 * `certificate*` routes (RND-4905, live since 2026-11-05): the chain's types
 * under `/chains/{id}/loyalty/gift_card_types`, the types a location sells
 * under `/locations/{id}/loyalty/gift_card_types/search`, and a client's gift
 * cards through the phone lookup `/loyalty/gift_cards`. Responses keep the
 * legacy keys. The model never learns the wire vocabulary: `certificate`,
 * `salon_ids`, `company_group_id`, `is_multi`, `item_type_id`,
 * `expiration_type_id`, `balance_edit_type_id`, `is_allow_empty_code`,
 * `released_total` and `category_id` stop here.
 *
 * Contract details (spec, and the backend source checked 2026-11-06):
 *
 * - `PUT` on a type takes every field of a create; the update reads the type
 *   first and sends every field back.
 * - `category_id` is the chain's gift card type group (the backend's
 *   `CertificateTypeCategory`), not a service category as the spec words it.
 * - `GET …/gift_card_types/fetch` reads types by an undocumented `ids[]`
 *   query; the port does not use it.
 *
 * Checked live on the test chain (2026-11-06): a create → update → delete
 * cycle cleans up after itself, and a deleted type answers 404. The fixed
 * expiry `date` takes a plain `YYYY-MM-DD` (a datetime is refused, though the
 * spec says date-time) and is stored as midnight server time. The online-sale
 * title, description and price are validated even with online sale off.
 */
import { majorOf } from '../money.js';
import { httpFromClient, type AltegioHttp } from '../altegio-http.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import {
  asRow,
  flag,
  id,
  num,
  rows,
  text,
  v1Read,
  type Row,
  type V1CallOptions,
  type V1Envelope,
} from './envelope.js';
import {
  GiftCardsNotFoundError,
  mapGiftCardsHttpError,
  type GiftCardsErrorHints,
} from '../../capabilities/gift-cards/errors.js';
import type {
  GiftCard,
  GiftCardExpiry,
  GiftCardStatus,
  GiftCardType,
  GiftCardTypeFields,
  GiftCardTypePage,
  GiftCardUsage,
  GiftCardsApi,
  PeriodUnit,
} from '../gift-cards-api.js';

// ========== wire vocabulary ==========

const USAGE_FROM_WIRE: Record<number, GiftCardUsage> = {
  0: 'services_and_products',
  1: 'services',
  2: 'products',
  3: 'listed_services',
  4: 'listed_services_and_products',
};
const USAGE_TO_WIRE: Record<GiftCardUsage, number> = {
  services_and_products: 0,
  services: 1,
  products: 2,
  listed_services: 3,
  listed_services_and_products: 4,
};

const EXPIRY_FROM_WIRE: Record<number, GiftCardExpiry['type']> = {
  0: 'never',
  1: 'fixed_date',
  2: 'after_sale',
};
const EXPIRY_TO_WIRE: Record<GiftCardTypeFields['expiry']['type'], number> = {
  never: 0,
  fixed_date: 1,
  after_sale: 2,
};

const UNIT_FROM_WIRE: Record<number, PeriodUnit> = {
  1: 'day',
  2: 'week',
  3: 'month',
  4: 'year',
};
const UNIT_TO_WIRE: Record<PeriodUnit, number> = {
  day: 1,
  week: 2,
  month: 3,
  year: 4,
};

/** `balance_edit_type_id`: 1 editable, 2 not; older types store 0. */
function balanceEditableFromWire(value: unknown): boolean | null {
  const n = num(value);
  return n === 1 ? true : n === 2 ? false : null;
}

const STATUS_FROM_WIRE: Record<number, GiftCardStatus> = {
  1: 'issued',
  2: 'active',
  3: 'used_up',
  4: 'expired',
};

// ========== mapping ==========

function ids(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((v) => id(v)).filter((v): v is number => v !== null);
}

function expiryFromWire(row: Row): GiftCardExpiry {
  const type = EXPIRY_FROM_WIRE[num(row.expiration_type_id) ?? -1] ?? null;
  return {
    type,
    date: type === 'fixed_date' ? text(row.expiration_date) : null,
    length: type === 'after_sale' ? num(row.expiration_timeout) : null,
    unit:
      type === 'after_sale'
        ? (UNIT_FROM_WIRE[num(row.expiration_timeout_unit_id) ?? -1] ?? null)
        : null,
  };
}

function typeFromWire(row: Row): GiftCardType {
  return {
    id: id(row.id) ?? 0,
    chain_id: id(row.company_group_id),
    title: text(row.title),
    value: num(row.balance),
    multiple_use: flag(row.is_multi),
    usage: USAGE_FROM_WIRE[num(row.item_type_id) ?? -1] ?? null,
    service_ids: ids(row.service_ids),
    type_category_id: id(row.category_id),
    location_ids: ids(row.salon_ids),
    expiry: expiryFromWire(row),
    balance_editable: balanceEditableFromWire(row.balance_edit_type_id),
    sold_without_number: flag(row.is_allow_empty_code),
    archived: flag(row.is_archived) === true,
    archived_at: text(row.date_archived),
    online_sale_enabled: flag(row.online_sale_is_enabled),
    online_sale_title: text(row.online_sale_title),
    online_sale_price: num(row.online_sale_price),
    online_sale_description: text(row.online_sale_description),
    sold_count: num(row.released_total),
  };
}

function giftCardFromWire(row: Row): GiftCard {
  const type = asRow(row.type);
  const statusId = num(row.status_id) ?? num(asRow(row.status).id);
  return {
    id: id(row.id) ?? 0,
    number: text(row.number),
    chain_id: id(type.company_group_id),
    type_id: id(row.type_id) ?? id(type.id),
    type_title: text(type.title),
    status: STATUS_FROM_WIRE[statusId ?? -1] ?? 'unknown',
    balance: num(row.balance),
    initial_balance: num(row.default_balance),
    multiple_use: flag(type.is_multi),
    created_at: text(row.created_date),
    expires_at: text(row.expiration_date),
  };
}

function toWire(fields: GiftCardTypeFields): Row {
  const expiry = fields.expiry;
  return {
    title: fields.title,
    balance: majorOf(fields.value),
    is_multi: fields.multiple_use,
    item_type_id: USAGE_TO_WIRE[fields.usage],
    is_allow_empty_code: fields.sold_without_number,
    category_id: fields.type_category_id,
    balance_edit_type_id: fields.balance_editable ? 1 : 2,
    service_ids: fields.service_ids,
    location_ids: fields.location_ids,
    expiration: {
      type_id: EXPIRY_TO_WIRE[expiry.type],
      ...(expiry.type === 'fixed_date' ? { date: expiry.date } : {}),
      ...(expiry.type === 'after_sale'
        ? {
            timeout: expiry.length,
            timeout_unit_id: expiry.unit
              ? UNIT_TO_WIRE[expiry.unit]
              : undefined,
          }
        : {}),
    },
    online_sale: {
      is_enabled: fields.online_sale_enabled,
      title: fields.online_sale_title,
      description: fields.online_sale_description,
      price: majorOf(fields.online_sale_price),
    },
  };
}

// ========== the adapter ==========

export class GiftCardsAdapter implements GiftCardsApi {
  constructor(private readonly http: AltegioHttp) {}

  static forClient(client: AltegioClient): GiftCardsAdapter {
    return new GiftCardsAdapter(httpFromClient(client));
  }

  private async call(
    path: string,
    context: string,
    options: V1CallOptions<GiftCardsErrorHints> = {}
  ): Promise<V1Envelope> {
    return v1Read(this.http, path, context, mapGiftCardsHttpError, options);
  }

  private typesPath(chainId: number, typeId?: number): string {
    return `/chains/${chainId}/loyalty/gift_card_types${typeId === undefined ? '' : `/${typeId}`}`;
  }

  async listChainTypes(
    chainId: number,
    query: { title?: string; page: number; page_size: number }
  ): Promise<GiftCardTypePage> {
    const { data, meta } = await this.call(
      this.typesPath(chainId),
      `list the gift card types of chain ${chainId}`,
      {
        query: {
          title: query.title,
          page: query.page,
          page_size: query.page_size,
        },
      }
    );
    return {
      items: rows(data).map(typeFromWire),
      total: num(meta.total_count) ?? num(meta.count),
    };
  }

  async listLocationTypes(
    locationId: number,
    query: { title?: string; page: number; page_size: number }
  ): Promise<GiftCardTypePage> {
    const { data, meta } = await this.call(
      `/locations/${locationId}/loyalty/gift_card_types/search`,
      `list the gift card types of location ${locationId}`,
      {
        query: {
          title: query.title,
          page: query.page,
          page_size: query.page_size,
        },
        hints: {
          forbidden:
            'Ask a location owner for access to loyalty in this location, or call locations_list to pick another location.',
          notFound: 'Check the location id with locations_list.',
        },
      }
    );
    return {
      items: rows(data).map(typeFromWire),
      total: num(meta.count) ?? num(meta.total_count),
    };
  }

  async getType(chainId: number, typeId: number): Promise<GiftCardType> {
    const { data } = await this.call(
      this.typesPath(chainId, typeId),
      `read gift card type ${typeId} of chain ${chainId}`,
      {
        hints: {
          notFound:
            'Check the gift card type id with gift_cards_list_types; a deleted type cannot be read.',
        },
      }
    );
    const type = typeFromWire(asRow(data));
    if (type.id === 0) {
      throw new GiftCardsNotFoundError(
        `Gift card type ${typeId} was not found in chain ${chainId}. Check the id with gift_cards_list_types.`
      );
    }
    return type;
  }

  private async writeType(
    chainId: number,
    typeId: number | undefined,
    fields: GiftCardTypeFields
  ): Promise<GiftCardType> {
    const { data } = await this.call(
      this.typesPath(chainId, typeId),
      typeId === undefined
        ? `create a gift card type in chain ${chainId}`
        : `update gift card type ${typeId} in chain ${chainId}`,
      {
        method: typeId === undefined ? 'POST' : 'PUT',
        body: toWire(fields),
        hints: {
          invalid:
            typeId === undefined
              ? 'Check the value, the locations (they must belong to the chain), the services and the expiry settings.'
              : 'A gift card type cannot be changed once gift cards of it were sold; create a new type instead. Otherwise check the value, locations, services and expiry.',
        },
      }
    );
    const saved = typeFromWire(asRow(data));
    // Some answers carry only the id: read the stored type back.
    return saved.id > 0 && saved.title !== null
      ? saved
      : this.getType(chainId, saved.id > 0 ? saved.id : (typeId ?? 0));
  }

  async createType(
    chainId: number,
    fields: GiftCardTypeFields
  ): Promise<GiftCardType> {
    return this.writeType(chainId, undefined, fields);
  }

  async updateType(
    chainId: number,
    typeId: number,
    fields: GiftCardTypeFields
  ): Promise<GiftCardType> {
    return this.writeType(chainId, typeId, fields);
  }

  async deleteType(chainId: number, typeId: number): Promise<void> {
    await this.call(
      this.typesPath(chainId, typeId),
      `delete gift card type ${typeId} in chain ${chainId}`,
      {
        method: 'DELETE',
        hints: {
          invalid: 'A gift card type with sold gift cards cannot be deleted.',
        },
      }
    );
  }

  async listClientGiftCards(
    locationId: number,
    clientId: number
  ): Promise<GiftCard[]> {
    const card = await this.call(
      `/client/${locationId}/${clientId}`,
      `read client ${clientId} in location ${locationId}`,
      {
        hints: {
          forbidden:
            'Ask a location owner for access to the client base and loyalty, or call locations_list to pick a location the user can work with.',
          notFound:
            'Check the location id with locations_list and the client id with clients_lookup.',
        },
      }
    );
    const phone = text(asRow(card.data).phone);
    if (!phone) return [];
    const { data } = await this.call(
      '/loyalty/gift_cards',
      `list the gift cards of client ${clientId} in location ${locationId}`,
      {
        query: { location_id: locationId, phone },
        scopedCompany: locationId,
        hints: {
          forbidden:
            'Ask a location owner for access to loyalty in this location, or call locations_list to pick another location.',
        },
      }
    );
    return rows(data)
      .map(giftCardFromWire)
      .filter((giftCard) => giftCard.id > 0);
  }
}
