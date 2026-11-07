/**
 * `GiftCardsApi` — the port the gift card capability layer talks to (ADR-001 D5).
 *
 * Gift card types are templates of a chain: a face value, what the card pays
 * for, its validity and the locations that sell it. Gift cards are sold from
 * them and carry their own balance. Method names and DTOs use the product
 * glossary; the wire vocabulary (`certificate`, `salon`, `company_group`,
 * `is_multi`, `item_type_id`, `expiration_type_id`, `balance_edit_type_id`,
 * `is_allow_empty_code`, `released_total`) stops in
 * `./v1/gift-cards-adapter.ts`.
 *
 * Money read back is in major units, as the API reports it. Money written is a
 * `Money` (`./money.ts`).
 */
import type { Money } from './money.js';

export type PeriodUnit = 'day' | 'week' | 'month' | 'year';

/** What a gift card of the type pays for. */
export type GiftCardUsage =
  | 'services_and_products'
  | 'services'
  | 'products'
  | 'listed_services'
  | 'listed_services_and_products';

/** When gift cards of the type expire. */
export interface GiftCardExpiry {
  /** `never`; `fixed_date` — every card on one date; `after_sale` — a period after its sale. */
  type: 'never' | 'fixed_date' | 'after_sale' | null;
  /** With `fixed_date`: RFC 3339. */
  date: string | null;
  /** With `after_sale`: the period. */
  length: number | null;
  unit: PeriodUnit | null;
}

export interface GiftCardType {
  id: number;
  chain_id: number | null;
  title: string | null;
  /** Face value: the balance a sold card starts with. */
  value: number | null;
  /** true: spent over several visits; false: spent at once. */
  multiple_use: boolean | null;
  usage: GiftCardUsage | null;
  /** With `listed_*` usage: the services it pays for. */
  service_ids: number[] | null;
  /** The chain's gift card type group, not a service category. */
  type_category_id: number | null;
  /** Locations that sell it; not reported by the location search. */
  location_ids: number[] | null;
  expiry: GiftCardExpiry;
  /** Staff may correct a sold card's balance by hand. */
  balance_editable: boolean | null;
  /** May be sold without a gift card number. */
  sold_without_number: boolean | null;
  archived: boolean;
  archived_at: string | null;
  online_sale_enabled: boolean | null;
  online_sale_title: string | null;
  online_sale_price: number | null;
  online_sale_description: string | null;
  /** Gift cards sold from it; not reported by the location search. */
  sold_count: number | null;
}

export interface GiftCardTypePage {
  items: GiftCardType[];
  total: number | null;
}

/** The fields of a type a create or an update sends, in full. */
export interface GiftCardTypeFields {
  title: string;
  value: Money;
  multiple_use: boolean;
  usage: GiftCardUsage;
  service_ids: number[];
  type_category_id: number | null;
  location_ids: number[];
  expiry: {
    type: 'never' | 'fixed_date' | 'after_sale';
    date?: string;
    length?: number;
    unit?: PeriodUnit;
  };
  balance_editable: boolean;
  sold_without_number: boolean;
  online_sale_enabled: boolean;
  online_sale_title: string;
  online_sale_price: Money;
  online_sale_description: string;
}

export type GiftCardStatus =
  'issued' | 'active' | 'used_up' | 'expired' | 'unknown';

/** A sold gift card. */
export interface GiftCard {
  id: number;
  /** The code printed on the card; null when sold without one. */
  number: string | null;
  chain_id: number | null;
  type_id: number | null;
  type_title: string | null;
  status: GiftCardStatus;
  balance: number | null;
  /** The balance it was sold with. */
  initial_balance: number | null;
  multiple_use: boolean | null;
  created_at: string | null;
  expires_at: string | null;
}

export interface GiftCardsApi {
  listChainTypes(
    chainId: number,
    query: { title?: string; page: number; page_size: number }
  ): Promise<GiftCardTypePage>;
  listLocationTypes(
    locationId: number,
    query: { title?: string; page: number; page_size: number }
  ): Promise<GiftCardTypePage>;
  getType(chainId: number, typeId: number): Promise<GiftCardType>;
  createType(
    chainId: number,
    fields: GiftCardTypeFields
  ): Promise<GiftCardType>;
  updateType(
    chainId: number,
    typeId: number,
    fields: GiftCardTypeFields
  ): Promise<GiftCardType>;
  deleteType(chainId: number, typeId: number): Promise<void>;
  /** A client's gift cards, found by the phone on their location card. */
  listClientGiftCards(
    locationId: number,
    clientId: number
  ): Promise<GiftCard[]>;
}
