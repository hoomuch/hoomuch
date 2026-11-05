import { describe, expect, it } from 'vitest';
import {
  decryptJson,
  encryptJson,
  hashPassword,
  keyHint,
  timingSafeEqual,
  verifyPassword,
} from '../../src/lib/crypto';
import {
  convertMinor,
  currencyExponent,
  formatMoney,
  formatPercent,
  normalizeToMonthly,
  parseMoneyMap,
  sumMoneyIn,
  toMajor,
  toMinor,
  type FxTable,
} from '../../src/lib/money';
import { addDays, dayRange, lastNDays } from '../../src/lib/time';
import { safeNext } from '../../src/lib/auth';
import { splitInput, getProviderMeta } from '../../src/providers/registry';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));

describe('crypto', () => {
  it('round-trips encrypted JSON and uses a fresh IV each time', async () => {
    const a = await encryptJson(KEY, { apiKey: 'rk_live_secret' });
    const b = await encryptJson(KEY, { apiKey: 'rk_live_secret' });
    expect(a).not.toEqual(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(a).not.toContain('rk_live');
    expect(await decryptJson(KEY, a)).toEqual({ apiKey: 'rk_live_secret' });
  });

  it('rejects tampered ciphertext', async () => {
    const blob = await encryptJson(KEY, { x: 1 });
    const tampered = blob.slice(0, -2) + (blob.endsWith('A') ? 'BB' : 'AA');
    await expect(decryptJson(KEY, tampered)).rejects.toThrow();
  });

  it('rejects a key of the wrong length', async () => {
    await expect(encryptJson(btoa('short'), {})).rejects.toThrow(/32 bytes/);
  });

  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('pbkdf2$100000$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong horse battery', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('compares strings in constant time semantics', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('shows only the last 4 characters of a key', () => {
    expect(keyHint('rk_live_51Habcdefghij1234')).toBe('…1234');
    expect(keyHint('short')).toBe('…');
  });
});

describe('money', () => {
  const fx: FxTable = { base: 'USD', day: '2026-11-05', rates: { EUR: 0.9, JPY: 150, TRY: 34 } };

  it('knows currency exponents', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('jpy')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });

  it('uses ISO 4217 minor units where CLDR display digits differ', () => {
    // Intl (CLDR) shows these with 0 decimals; ISO 4217 and payment APIs count them in hundredths.
    for (const c of ['HUF', 'IDR', 'COP', 'PKR', 'AFN', 'ALL', 'IRR', 'KPW', 'LAK', 'LBP', 'MGA', 'MMK', 'SOS', 'SYP', 'YER']) {
      expect(currencyExponent(c), c).toBe(2);
    }
    expect(currencyExponent('IQD')).toBe(3); // CLDR 0
    expect(currencyExponent('ISK')).toBe(0);
    expect(currencyExponent('UGX')).toBe(0);
    expect(currencyExponent('CLF')).toBe(4);
    expect(currencyExponent('UYW')).toBe(4);
    // Older CLDR releases gave these 0 digits; the table doesn't depend on the runtime's CLDR.
    expect(currencyExponent('RSD')).toBe(2);
    expect(currencyExponent('AMD')).toBe(2);
    // Withdrawn codes still found in old provider records.
    expect(currencyExponent('SLL')).toBe(2);
    expect(currencyExponent('MRO')).toBe(2);
    expect(currencyExponent('HRK')).toBe(2);
    expect(currencyExponent('BYR')).toBe(0);
    expect(currencyExponent(' huf ')).toBe(2);
    // Outside ISO 4217 (or without a minor unit): Intl's digits, then 2.
    expect(currencyExponent('XAU')).toBe(2);
    expect(currencyExponent('ABC')).toBe(2);
  });

  it('matches every code in ISO 4217 list one (SIX, published 2026-09-17)', () => {
    // Generated from list-one.xml (CcyMnrUnts), entries with "N.A." left out. A second, independent
    // copy of the table in src/lib/money.ts, so a typo there fails here.
    const iso: Record<string, number> = {"AED":2,"AFN":2,"ALL":2,"AMD":2,"AOA":2,"ARS":2,"AUD":2,"AWG":2,"AZN":2,"BAM":2,"BBD":2,"BDT":2,"BHD":3,"BIF":0,"BMD":2,"BND":2,"BOB":2,"BOV":2,"BRL":2,"BSD":2,"BTN":2,"BWP":2,"BYN":2,"BZD":2,"CAD":2,"CDF":2,"CHE":2,"CHF":2,"CHW":2,"CLF":4,"CLP":0,"CNY":2,"COP":2,"COU":2,"CRC":2,"CUP":2,"CVE":2,"CZK":2,"DJF":0,"DKK":2,"DOP":2,"DZD":2,"EGP":2,"ERN":2,"ETB":2,"EUR":2,"FJD":2,"FKP":2,"GBP":2,"GEL":2,"GHS":2,"GIP":2,"GMD":2,"GNF":0,"GTQ":2,"GYD":2,"HKD":2,"HNL":2,"HTG":2,"HUF":2,"IDR":2,"ILS":2,"INR":2,"IQD":3,"IRR":2,"ISK":0,"JMD":2,"JOD":3,"JPY":0,"KES":2,"KGS":2,"KHR":2,"KMF":0,"KPW":2,"KRW":0,"KWD":3,"KYD":2,"KZT":2,"LAK":2,"LBP":2,"LKR":2,"LRD":2,"LSL":2,"LYD":3,"MAD":2,"MDL":2,"MGA":2,"MKD":2,"MMK":2,"MNT":2,"MOP":2,"MRU":2,"MUR":2,"MVR":2,"MWK":2,"MXN":2,"MXV":2,"MYR":2,"MZN":2,"NAD":2,"NGN":2,"NIO":2,"NOK":2,"NPR":2,"NZD":2,"OMR":3,"PAB":2,"PEN":2,"PGK":2,"PHP":2,"PKR":2,"PLN":2,"PYG":0,"QAR":2,"RON":2,"RSD":2,"RUB":2,"RWF":0,"SAR":2,"SBD":2,"SCR":2,"SDG":2,"SEK":2,"SGD":2,"SHP":2,"SLE":2,"SOS":2,"SRD":2,"SSP":2,"STN":2,"SVC":2,"SYP":2,"SZL":2,"THB":2,"TJS":2,"TMT":2,"TND":3,"TOP":2,"TRY":2,"TTD":2,"TWD":2,"TZS":2,"UAH":2,"UGX":0,"USD":2,"USN":2,"UYI":0,"UYU":2,"UYW":4,"UZS":2,"VED":2,"VES":2,"VND":0,"VUV":0,"WST":2,"XAD":2,"XAF":0,"XCD":2,"XCG":2,"XOF":0,"XPF":0,"YER":2,"ZAR":2,"ZMW":2,"ZWG":2};
    expect(Object.keys(iso)).toHaveLength(165);
    const wrong = Object.entries(iso).filter(([c, d]) => currencyExponent(c) !== d);
    expect(wrong).toEqual([]);
  });

  it('round-trips HUF, IDR, COP and PKR through toMinor / toMajor / formatMoney', () => {
    // A Stripe price of HUF 4,990.00 arrives as 499000 (fillér).
    expect(toMinor(4990, 'HUF')).toBe(499000);
    expect(toMajor(499000, 'HUF')).toBe(4990);
    expect(formatMoney(499000, 'HUF')).toBe('HUF\u00a04,990');
    expect(formatMoney(499000, 'HUF', { whole: true })).toBe('HUF\u00a04,990');
    expect(formatMoney(499000, 'HUF', { compact: true })).toBe('HUF\u00a05K');
    // Display keeps CLDR's rounding: fillér aren't shown.
    expect(toMinor(4990.5, 'HUF')).toBe(499050);
    expect(formatMoney(499050, 'HUF')).toBe('HUF\u00a04,991');

    expect(toMinor(150000, 'IDR')).toBe(15000000);
    expect(formatMoney(15000000, 'IDR')).toBe('IDR\u00a0150,000');
    expect(toMajor(4990000, 'COP')).toBe(49900);
    expect(formatMoney(4990000, 'COP')).toBe('COP\u00a049,900');
    expect(toMinor(999, 'PKR')).toBe(99900);
    expect(formatMoney(99900, 'PKR')).toBe('PKR\u00a0999');
  });

  it('round-trips zero-, three- and four-digit currencies', () => {
    expect(toMinor(5000, 'ISK')).toBe(5000);
    expect(formatMoney(5000, 'ISK')).toBe('ISK\u00a05,000');
    expect(toMinor(1.234, 'KWD')).toBe(1234);
    expect(formatMoney(1234, 'KWD')).toBe('KWD\u00a01.234');
    expect(toMinor(1.2345, 'CLF')).toBe(12345);
    expect(formatMoney(12345, 'CLF')).toBe('CLF\u00a01.2345');
    // IQD: 3 minor digits, shown whole (CLDR).
    expect(toMajor(123456, 'IQD')).toBe(123.456);
    expect(formatMoney(123456, 'IQD')).toBe('IQD\u00a0123');
  });

  it('converts HUF at its real size', () => {
    const huf: FxTable = { base: 'USD', day: '2026-11-05', rates: { EUR: 0.9, HUF: 400, ISK: 125 } };
    expect(convertMinor(499000, 'HUF', 'USD', huf)).toBe(1248); // HUF 4,990 → $12.475
    expect(convertMinor(499000, 'HUF', 'EUR', huf)).toBe(1123); // → €11.2275
    expect(convertMinor(1000, 'USD', 'HUF', huf)).toBe(400000); // $10 → HUF 4,000
    expect(convertMinor(5000, 'ISK', 'HUF', huf)).toBe(1600000); // ISK 5,000 → HUF 16,000
    expect(sumMoneyIn({ HUF: 499000, USD: 1000 }, 'USD', huf)).toEqual({ amount: 2248, missing: [] });
  });

  it('normalizes billing intervals to monthly', () => {
    expect(normalizeToMonthly(12000, 'year')).toBe(1000);
    expect(normalizeToMonthly(1000, 'month')).toBe(1000);
    expect(normalizeToMonthly(3000, 'month', 3)).toBe(1000);
    expect(normalizeToMonthly(100, 'week')).toBe(433);
    expect(normalizeToMonthly(100, 'day')).toBe(3042);
  });

  it('converts between currencies with different exponents', () => {
    expect(convertMinor(9000, 'EUR', 'USD', fx)).toBe(10000); // €90 → $100
    expect(convertMinor(10000, 'USD', 'JPY', fx)).toBe(15000); // $100 → ¥15,000
    expect(convertMinor(15000, 'JPY', 'EUR', fx)).toBe(9000); // ¥15,000 → €90
    expect(convertMinor(100, 'XYZ', 'USD', fx)).toBeNull();
  });

  it('sums a MoneyMap and reports unconvertible currencies', () => {
    expect(sumMoneyIn({ USD: 1000, EUR: 900, XYZ: 5 }, 'USD', fx)).toEqual({ amount: 2000, missing: ['XYZ'] });
    expect(sumMoneyIn({ USD: 1000, EUR: 900 }, 'USD', null)).toEqual({ amount: 1000, missing: ['EUR'] });
  });

  it('formats money and percentages', () => {
    expect(formatMoney(123456, 'USD')).toBe('$1,234.56');
    expect(formatMoney(123456, 'USD', { whole: true })).toBe('$1,235');
    expect(formatMoney(1500, 'JPY')).toBe('¥1,500');
    expect(formatMoney(1234500, 'USD', { compact: true })).toBe('$12.3K');
    expect(formatPercent(12.345)).toBe('+12.3%');
    expect(formatPercent(-3)).toBe('−3.0%');
  });

  it('parses MoneyMap JSON defensively', () => {
    expect(parseMoneyMap('{"usd":100,"EUR":2.6,"bad":"x"}')).toEqual({ USD: 100, EUR: 3 });
    expect(parseMoneyMap('nope')).toEqual({});
    expect(parseMoneyMap(null)).toEqual({});
  });
});

describe('time', () => {
  it('builds inclusive day ranges', () => {
    expect(dayRange('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    const days = lastNDays(7, Date.parse('2026-11-05T12:00:00Z'));
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-10-30');
    expect(days[6]).toBe('2026-11-05');
  });
});

describe('auth helpers', () => {
  it('only allows same-site relative redirects', () => {
    expect(safeNext('/connections?x=1')).toBe('/connections?x=1');
    expect(safeNext('//evil.com')).toBe('/dashboard');
    expect(safeNext('/\\evil.com')).toBe('/dashboard');
    expect(safeNext('https://evil.com')).toBe('/dashboard');
    expect(safeNext(undefined)).toBe('/dashboard');
  });
});

describe('registry', () => {
  it('splits secret vs config fields and flags missing required ones', () => {
    const rc = getProviderMeta('revenuecat');
    expect(splitInput(rc, { apiKey: ' sk_abc ', projectId: 'proj1', extra: 'ignored' })).toEqual({
      credentials: { apiKey: 'sk_abc' },
      config: { projectId: 'proj1' },
      errors: {},
    });
    expect(Object.keys(splitInput(rc, { apiKey: '' }).errors)).toEqual(['apiKey', 'projectId']);
  });
});
