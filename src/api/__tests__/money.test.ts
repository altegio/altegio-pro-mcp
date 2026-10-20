import {
  currencyExponent,
  decimalsOf,
  lineTotal,
  majorOf,
  moneyInput,
  MoneyInputError,
  moneyOf,
  roundMajor,
  sameMajor,
  sumMajor,
} from '../money.js';

describe('currencyExponent', () => {
  it.each([
    ['CZK', 2],
    ['EUR', 2],
    ['UAH', 2],
    ['JPY', 0],
    ['ISK', 0],
    ['KRW', 0],
    // Three ISO decimals, but Altegio stores two.
    ['KWD', 2],
    ['BHD', 2],
    [null, 2],
  ])('%s takes %i decimals', (currency, exponent) => {
    expect(currencyExponent(currency)).toBe(exponent);
  });
});

describe('exact conversions', () => {
  it('counts decimals from the shortest text', () => {
    expect(decimalsOf(550)).toBe(0);
    expect(decimalsOf(550.5)).toBe(1);
    expect(decimalsOf(0.29)).toBe(2);
    expect(decimalsOf(1e-7)).toBe(7);
    expect(decimalsOf(-12.345)).toBe(3);
  });

  it('rounds half away from zero on the decimal, not the float', () => {
    // 1.005 * 100 is 100.49999999999999 in floats.
    expect(roundMajor(1.005)).toBe(1.01);
    expect(roundMajor(-1.005)).toBe(-1.01);
    expect(roundMajor(2.675)).toBe(2.68);
    expect(roundMajor(1111.5, 0)).toBe(1112);
    expect(Object.is(roundMajor(-0.001), 0)).toBe(true);
  });

  it('turns minor units back into the exact decimal', () => {
    const money = moneyOf(550.5, 'CZK');
    expect(money).toEqual({ minor: 55050, exponent: 2, currency: 'CZK' });
    expect(majorOf(money)).toBe(550.5);
    expect(String(majorOf(moneyOf(0.29, null)))).toBe('0.29');
    expect(majorOf(moneyOf(999_999_999.99, null))).toBe(999_999_999.99);
  });

  it('sums and compares without drift', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumMajor([0.1, 0.2])).toBe(0.3);
    expect(sameMajor(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameMajor(0.3, 0.31)).toBe(false);
  });

  it('computes a line total in integers', () => {
    const price = moneyOf(0.35, 'CZK');
    expect(3 * 0.35 * 0.5).toBe(0.5249999999999999);
    expect(majorOf(lineTotal(3, price, 50))).toBe(0.53);
    expect(majorOf(lineTotal(2.5, moneyOf(19.99, 'CZK')))).toBe(49.98);
    expect(majorOf(lineTotal(1, moneyOf(100, 'CZK'), 100))).toBe(0);
    expect(lineTotal(0.333, moneyOf(1000, 'JPY', 0), 10)).toEqual({
      minor: 300,
      exponent: 0,
      currency: 'JPY',
    });
  });
});

describe('moneyInput', () => {
  it('accepts what the currency carries', () => {
    expect(moneyInput(550.5, 'CZK', 'amount')).toEqual({
      minor: 55050,
      exponent: 2,
      currency: 'CZK',
    });
    expect(moneyInput(1200, 'JPY', 'amount')).toEqual({
      minor: 1200,
      exponent: 0,
      currency: 'JPY',
    });
    expect(moneyInput(12.5, null, 'amount').minor).toBe(1250);
  });

  it.each([
    [
      10.5,
      'JPY',
      /amount 10\.5 has 1 decimal, but JPY amounts are written in whole numbers/,
    ],
    [
      10.505,
      'CZK',
      /has 3 decimals, but CZK amounts are written in at most 2 decimals/,
    ],
    [1.234, 'KWD', /KWD amounts are written in at most 2 decimals/],
    [1e-7, null, /amounts at this location are written in at most 2 decimals/],
  ])('refuses %s %s', (major, currency, message) => {
    const run = () => moneyInput(major, currency, 'amount');
    expect(run).toThrow(MoneyInputError);
    expect(run).toThrow(message);
  });

  it('accepts an amount Altegio reported at the stored precision', () => {
    expect(moneyInput(1111.5, 'JPY', 'amount', [null, 1111.5])).toEqual({
      minor: 111150,
      exponent: 2,
      currency: 'JPY',
    });
    expect(() => moneyInput(1111.25, 'JPY', 'amount', [1111.5])).toThrow(
      MoneyInputError
    );
    expect(() => moneyInput(1.234, 'CZK', 'amount', [1.234])).toThrow(
      MoneyInputError
    );
  });
});
