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
