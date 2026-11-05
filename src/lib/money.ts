/**
 * Money helpers. All amounts are integer MINOR units of an ISO 4217 currency
 * (cents, kuruş; yen has no minor unit). Owner: Lead. See SPEC.md §6.
 */

/** Amounts per currency, e.g. { USD: 12300, EUR: 4500 }. */
export type MoneyMap = Record<string, number>;

/** Display currencies offered in settings (all are covered by ECB / frankfurter.dev). */
export const SUPPORTED_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'TRY', 'CAD', 'AUD', 'CHF', 'JPY', 'SEK', 'NOK', 'DKK',
  'PLN', 'CZK', 'BRL', 'MXN', 'INR', 'SGD', 'HKD', 'NZD', 'ZAR', 'KRW',
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(c: string): c is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(c);
}

export function normalizeCurrency(c: string): string {
  return c.trim().toUpperCase();
}

const exponentCache = new Map<string, number>();

/** Number of minor-unit digits (USD 2, JPY 0, KWD 3). Falls back to 2. */
export function currencyExponent(currency: string): number {
  const cur = normalizeCurrency(currency);
  let e = exponentCache.get(cur);
  if (e === undefined) {
    try {
      e = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    } catch {
      e = 2;
    }
    exponentCache.set(cur, e);
  }
  return e;
}

export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** currencyExponent(currency);
}

export function toMinor(major: number, currency: string): number {
  return Math.round(major * 10 ** currencyExponent(currency));
}

export type BillingInterval = 'day' | 'week' | 'month' | 'year';

/** Monthly equivalent of an amount billed every `count` `interval`s (SPEC §6), rounded. */
export function normalizeToMonthly(amountMinor: number, interval: BillingInterval, count = 1): number {
  const perMonth: Record<BillingInterval, number> = {
    day: 365 / 12,
    week: 52 / 12,
    month: 1,
    year: 1 / 12,
  };
  const n = count > 0 ? count : 1;
  return Math.round((amountMinor * perMonth[interval]) / n);
}

export function addMoney(a: MoneyMap, b: MoneyMap): MoneyMap {
  const out: MoneyMap = { ...a };
  for (const [cur, amt] of Object.entries(b)) out[cur] = (out[cur] ?? 0) + amt;
  return out;
}

export function addToMoney(map: MoneyMap, currency: string, amount: number): MoneyMap {
  const cur = normalizeCurrency(currency);
  map[cur] = (map[cur] ?? 0) + amount;
  return map;
}

/**
 * FX rates: units of currency X per 1 unit of `base` (frankfurter.dev format).
 * The base itself may be absent from `rates`; it is treated as 1.
 */
export interface FxTable {
  base: string;
  day: string;
  rates: Record<string, number>;
}

function rateOf(fx: FxTable, currency: string): number | null {
  const cur = normalizeCurrency(currency);
  if (cur === fx.base) return 1;
  const r = fx.rates[cur];
  return typeof r === 'number' && r > 0 ? r : null;
}

/** Converts minor units between currencies, respecting each currency's exponent. Null if a rate is missing. */
export function convertMinor(amountMinor: number, from: string, to: string, fx: FxTable): number | null {
  const f = normalizeCurrency(from);
  const t = normalizeCurrency(to);
  if (f === t) return amountMinor;
  const rf = rateOf(fx, f);
  const rt = rateOf(fx, t);
  if (rf === null || rt === null) return null;
  return toMinor((toMajor(amountMinor, f) / rf) * rt, t);
}

/** Sums a MoneyMap into one currency. Unconvertible currencies are reported in `missing`. */
export function sumMoneyIn(
  map: MoneyMap,
  to: string,
  fx: FxTable | null,
): { amount: number; missing: string[] } {
  let amount = 0;
  const missing: string[] = [];
  for (const [cur, amt] of Object.entries(map)) {
    if (amt === 0) continue;
    const v = fx ? convertMinor(amt, cur, to, fx) : normalizeCurrency(cur) === normalizeCurrency(to) ? amt : null;
    if (v === null) missing.push(cur);
    else amount += v;
  }
  return { amount, missing };
}

export interface FormatMoneyOptions {
  /** "$12.3K" style for big headline numbers. */
  compact?: boolean;
  /** Show "+" for positive values (deltas). */
  signed?: boolean;
  /** Drop the minor digits ("$1,234" instead of "$1,234.56"). */
  whole?: boolean;
}

export function formatMoney(amountMinor: number, currency: string, opts: FormatMoneyOptions = {}): string {
  const cur = normalizeCurrency(currency);
  const exp = currencyExponent(cur);
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: cur,
    notation: opts.compact ? 'compact' : 'standard',
    maximumFractionDigits: opts.compact ? 1 : opts.whole ? 0 : exp,
    minimumFractionDigits: opts.compact || opts.whole ? 0 : exp,
    signDisplay: opts.signed ? 'exceptZero' : 'auto',
  });
  return fmt.format(toMajor(amountMinor, cur));
}

export function formatNumber(n: number, opts: { compact?: boolean } = {}): string {
  return new Intl.NumberFormat('en-US', {
    notation: opts.compact ? 'compact' : 'standard',
    maximumFractionDigits: opts.compact ? 1 : 0,
  }).format(n);
}

/** "+12.4%" / "−3.0%" / "0.0%". */
export function formatPercent(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

export function parseMoneyMap(json: string | null | undefined): MoneyMap {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== 'object') return {};
    const out: MoneyMap = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n)) out[normalizeCurrency(k)] = Math.round(n);
    }
    return out;
  } catch {
    return {};
  }
}
