/**
 * Exact money at the port boundary (ADR-001 §5, rule 4).
 *
 * Tools take and return money in major units of the location's currency
 * (`550.5` CZK), the way every V1 and V2 route reads and writes it. A port's
 * write takes a `Money` instead: an integer count of minor units, the exponent
 * that count is in and the ISO currency code. The V1 and V2 adapters send
 * `majorOf(money)`; a V3 adapter sends `minor` in the `_minor` field, rescaled
 * to the exponent V3 uses for the currency and refused when that is inexact.
 * Arithmetic on money — sums, quantity × price, a discount — runs on minor
 * units, so JS float drift never reaches a payload or a comparison.
 *
 * Two exponents matter:
 * - Altegio stores every currency with two decimals (its currency table sets
 *   precision 2 for each one, JPY and KWD included), and V1 and V2 report
 *   amounts that way. A value read back or computed from one is kept at
 *   `STORED_DECIMALS`.
 * - A caller writes at most the currency's ISO 4217 minor unit, capped at the
 *   two stored decimals (`currencyExponent`): whole numbers for JPY or ISK,
 *   two decimals for CZK or EUR, and two for KWD, whose third decimal Altegio
 *   cannot store. When the currency is not known, two.
 */
import { AltegioApiError } from '../utils/errors.js';

/** Decimals Altegio stores and reports for every currency. */
export const STORED_DECIMALS = 2;

/** ISO 4217 currencies whose minor unit is not two decimals. */
const ISO_MINOR_UNITS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

/** Decimals a caller may write in this currency; two when it is not known. */
export function currencyExponent(currency: string | null): number {
  const iso =
    currency === null
      ? STORED_DECIMALS
      : (ISO_MINOR_UNITS[currency] ?? STORED_DECIMALS);
  return Math.min(iso, STORED_DECIMALS);
}

/** An exact amount of money. */
export interface Money {
  /** Integer count of 10^-exponent units of the currency. */
  readonly minor: number;
  readonly exponent: number;
  /** ISO 4217 code; null when the location's currency could not be read. */
  readonly currency: string | null;
}

/**
 * Move the decimal point of a number by `places` through its decimal text.
 * JS prints the shortest text that reads back as the same number, which for
 * an amount from JSON is the decimal that was sent; shifting that text is
 * exact where `value * 100` is not (`1.005 * 100` is `100.49999999999999`).
 */
function shift(value: number, places: number): number {
  const [mantissa, exp = '0'] = String(value).split('e');
  return Number(`${mantissa}e${Number(exp) + places}`);
}

/** Decimals in the shortest text of a number: `550.5` → 1, `1e-7` → 7. */
export function decimalsOf(value: number): number {
  const [mantissa, exp = '0'] = String(Math.abs(value)).split('e');
  const fraction = mantissa!.split('.')[1]?.length ?? 0;
  return Math.max(0, fraction - Number(exp));
}

/** Round half away from zero to an integer. */
function roundHalfAway(value: number): number {
  const rounded = Math.sign(value) * Math.round(Math.abs(value));
  return rounded === 0 ? 0 : rounded;
}

/**
 * Money from a major amount read back or computed: rounded half away from zero
 * at `exponent` decimals.
 */
export function moneyOf(
  major: number,
  currency: string | null,
  exponent: number = STORED_DECIMALS
): Money {
  return { minor: roundHalfAway(shift(major, exponent)), exponent, currency };
}

/**
 * The amount in major units: the number nearest the decimal, which JSON and
 * `String()` print exactly (`55050` minor at exponent 2 → `550.5`).
 */
export function majorOf(money: Money): number {
  return shift(money.minor, -money.exponent);
}

/** A major amount rounded half away from zero at `exponent` decimals. */
export function roundMajor(
  value: number,
  exponent: number = STORED_DECIMALS
): number {
  return majorOf(moneyOf(value, null, exponent));
}

/** Two major amounts that are equal at the stored precision. */
export function sameMajor(a: number, b: number): boolean {
  return moneyOf(a, null).minor === moneyOf(b, null).minor;
}

/** The sum of major amounts, exact at the stored precision. */
export function sumMajor(values: readonly number[]): number {
  return majorOf({
    minor: values.reduce((sum, v) => sum + moneyOf(v, null).minor, 0),
    exponent: STORED_DECIMALS,
    currency: null,
  });
}

/**
 * quantity × unit price, less a percent discount, rounded half away from zero
 * at the price's exponent. The quantity counts to three decimals and the
 * discount to two; the product runs in integers, so 3 × 0.35 less 50 % is
 * 0.53, where float arithmetic gives `0.5249999999999999` and rounds to 0.52.
 */
export function lineTotal(
  quantity: number,
  unitPrice: Money,
  discountPercent = 0
): Money {
  const thousandths = BigInt(roundHalfAway(shift(quantity, 3)));
  const kept = BigInt(10_000 - roundHalfAway(shift(discountPercent, 2)));
  const numerator = BigInt(unitPrice.minor) * thousandths * kept;
  const denominator = 10_000_000n;
  const sign = numerator < 0n ? -1n : 1n;
  const magnitude = numerator * sign;
  const minor = (2n * magnitude + denominator) / (2n * denominator);
  return { ...unitPrice, minor: Number(minor * sign) };
}

/** A money input that the location's currency cannot carry. */
export class MoneyInputError extends AltegioApiError {
  constructor(message: string) {
    super(message, 422);
    this.name = 'MoneyInputError';
  }
}

/** `whole numbers` or `at most 2 decimals`. */
function allowed(exponent: number): string {
  return exponent === 0
    ? 'whole numbers'
    : `at most ${exponent} decimal${exponent === 1 ? '' : 's'}`;
}

/**
 * Money a caller wrote, in the location's currency. It is refused when it has
 * more decimals than the currency takes (`currencyExponent`), unless it equals
 * an amount Altegio itself reported — an amount due, a payable amount — which
 * may carry the two stored decimals in any currency.
 */
export function moneyInput(
  major: number,
  currency: string | null,
  field: string,
  reported: readonly (number | null | undefined)[] = []
): Money {
  const exponent = currencyExponent(currency);
  const decimals = decimalsOf(major);
  if (decimals <= exponent) return moneyOf(major, currency, exponent);
  if (
    decimals <= STORED_DECIMALS &&
    reported.some((r) => typeof r === 'number' && sameMajor(r, major))
  ) {
    return moneyOf(major, currency, STORED_DECIMALS);
  }
  throw new MoneyInputError(
    `${field} ${major} has ${decimals} decimal${decimals === 1 ? '' : 's'}, but ${currency ? `${currency} amounts are` : 'amounts at this location are'} written in ${allowed(exponent)}; round it.`
  );
}
