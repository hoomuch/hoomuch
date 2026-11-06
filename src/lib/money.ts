/**
 * Money helpers. All amounts are integer MINOR units of an ISO 4217 currency
 * (cents, kuruş, fillér; yen has no minor unit). Owner: Lead. See SPEC.md §6.
 *
 * "Minor unit" means the ISO 4217 minor unit (`currencyExponent`), which is what payment APIs use.
 * It is NOT `Intl.NumberFormat`'s fraction digits: those are CLDR display precision, which shows
 * HUF, IDR, COP and PKR with 0 decimals although ISO 4217 (and Stripe) count them in hundredths.
 * Display rounding still follows CLDR (`formatMoney`).
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

/**
 * ISO 4217 minor units from SIX's list one, published 2026-09-17, grouped by digit count:
 * https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
 * Funds and metals without a minor unit (XAU, XDR, …) are left out and fall back to Intl.
 *
 * Every active code is listed, not only the ones where CLDR disagrees: CLDR's digits change between ICU
 * releases and differ between Node and workerd (older CLDR also gave RSD and AMD 0 digits), so nothing
 * that decides how an integer is read may depend on them. Codes withdrawn since 2017 that old provider
 * records can still carry are appended with their last ISO minor unit (list three has no digits column).
 *
 * Where CLDR 48 (Node 24) differs: AFN ALL COP HUF IDR IRR KPW LAK LBP MGA MMK PKR SOS SYP YER have 2
 * (CLDR 0), IQD has 3 (CLDR 0); withdrawn MRO SLL STD have 2 (CLDR 0).
 */
const ISO_4217_BY_DIGITS: Readonly<Record<number, readonly string[]>> = {
  0: [
    'BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF',
    'BYR', // withdrawn 2017
  ],
  2: [
    'AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF',
    'CHE CHF CHW CNY COP COU CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD',
    'GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL',
    'MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR',
    'PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TOP',
    'TRY TTD TWD TZS UAH USD USN UYU UZS VED VES WST XAD XCD XCG YER ZAR ZMW ZWG',
    'ANG BGN CUC HRK MRO SLL STD VEF ZWL', // withdrawn 2017–2026
  ],
  3: ['BHD IQD JOD KWD LYD OMR TND'],
  4: ['CLF UYW'],
};

const ISO_4217_MINOR_UNITS: ReadonlyMap<string, number> = new Map(
  Object.entries(ISO_4217_BY_DIGITS).flatMap(([digits, rows]) =>
    rows.flatMap((row) => row.split(' ').map((code) => [code, Number(digits)] as const)),
  ),
);

const cldrDigitsCache = new Map<string, number>();

/** CLDR display precision (what `Intl` rounds to by default): HUF 0, USD 2. Falls back to 2. */
function cldrDigits(cur: string): number {
  let d = cldrDigitsCache.get(cur);
  if (d === undefined) {
    try {
      d = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    } catch {
      d = 2;
    }
    cldrDigitsCache.set(cur, d);
  }
  return d;
}

/**
 * ISO 4217 minor-unit digits: USD 2, HUF 2, JPY 0, ISK 0, KWD 3, CLF 4. Codes outside ISO 4217 fall back
 * to Intl's digits, then 2. Adapters whose provider counts differently convert at the boundary
 * (Stripe: MGA, ISK, UGX).
 */
export function currencyExponent(currency: string): number {
  const cur = normalizeCurrency(currency);
  return ISO_4217_MINOR_UNITS.get(cur) ?? cldrDigits(cur);
}

/**
 * Decimals shown for an amount: CLDR's display precision, capped at the minor unit (HUF 4,990.00 → "HUF 4,990").
 * Rounds away minor units that CLDR doesn't display, e.g. 4,990.50 HUF shows as 4,991.
 */
function displayDigits(currency: string): number {
  const cur = normalizeCurrency(currency);
  return Math.min(cldrDigits(cur), currencyExponent(cur));
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

/** Reads `amountMinor` with the ISO minor unit; shows CLDR's decimals (`displayDigits`). */
export function formatMoney(amountMinor: number, currency: string, opts: FormatMoneyOptions = {}): string {
  const cur = normalizeCurrency(currency);
  const digits = displayDigits(cur);
  const fmt = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: cur,
    notation: opts.compact ? 'compact' : 'standard',
    maximumFractionDigits: opts.compact ? 1 : opts.whole ? 0 : digits,
    minimumFractionDigits: opts.compact || opts.whole ? 0 : digits,
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
