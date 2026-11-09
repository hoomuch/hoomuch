/**
 * What an owner tells visitors about a product (SPEC F-21): countries, the founded date and the
 * About section's rules, shared by the form, the page and the server.
 */
import { describe, expect, it } from 'vitest';
import { COUNTRIES, countryFlag, countryName, isCountryCode } from '../../src/lib/countries';
import {
  CHANNELS,
  contactIn,
  describePlan,
  groupPlans,
  parsePlanPrice,
  planMonthly,
  yearlySaving,
  type PricePlan,
  formatFounded,
  hasDetails,
  isFounded,
  MARKETS,
  MARKETS_MAX,
  NO_DETAILS,
  normalizeDetails,
  parseFounded,
  parseProductDetails,
  serializeProductDetails,
  TECH,
  TECH_GROUPS,
  TECH_MAX,
  DESCRIPTION_MAX,
} from '../../src/lib/product-details';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');

describe('countries', () => {
  it('has every code once, two capitals each, sorted by name', () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
    expect(COUNTRIES.length).toBeGreaterThanOrEqual(249);
    const names = COUNTRIES.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('names and flags a code, and knows a code that isn’t one', () => {
    expect(countryName('FR')).toBe('France');
    expect(countryName('TR')).toBe('Türkiye');
    expect(countryName('ZZ')).toBeNull();
    expect(countryName(null)).toBeNull();
    expect(isCountryCode('US')).toBe(true);
    expect(isCountryCode('us')).toBe(false);
    expect(countryFlag('FR')).toBe('🇫🇷');
    expect(countryFlag('tr')).toBe('🇹🇷');
  });
});

describe('founded', () => {
  it('takes a year, or a year and a month, up to this month', () => {
    expect(parseFounded('', '', NOW)).toEqual({ value: null });
    expect(parseFounded('2024', '', NOW)).toEqual({ value: '2024' });
    expect(parseFounded('2026', '11', NOW)).toEqual({ value: '2026-11' });
    expect(parseFounded('1970', '01', NOW)).toEqual({ value: '1970-01' });
  });

  it('turns back a month without a year, a year out of range and a month to come', () => {
    expect(parseFounded('', '05', NOW)).toEqual({ error: 'Pick the year too.' });
    expect(parseFounded('1969', '', NOW)).toEqual({ error: 'Pick a year from 1970 to 2026.' });
    expect(parseFounded('2027', '', NOW)).toEqual({ error: 'Pick a year from 1970 to 2026.' });
    expect(parseFounded('20x6', '', NOW)).toEqual({ error: 'Pick a year from 1970 to 2026.' });
    expect(parseFounded('2026', '12', NOW)).toEqual({ error: 'That month hasn’t come yet.' });
    expect(parseFounded('2025', '13', NOW)).toEqual({ error: 'Pick a month from the list.' });
  });

  it('reads and says a stored value the same way everywhere', () => {
    expect(isFounded('2026-11')).toBe(true);
    expect(isFounded('2026')).toBe(true);
    expect(isFounded('1969')).toBe(false);
    expect(isFounded('2026-13')).toBe(false);
    expect(isFounded(null)).toBe(false);
    expect(formatFounded('2026-11')).toBe('November 2026');
    expect(formatFounded('2019')).toBe('2019');
  });
});

describe('the About section', () => {
  it('has each list’s ids once, and every tech entry in a group', () => {
    for (const list of [MARKETS, CHANNELS, TECH]) {
      const ids = list.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const groups = new Set(TECH_GROUPS.map((g) => g.id));
    expect(TECH.every((t) => groups.has(t.group))).toBe(true);
  });

  it('keeps what fits and drops the rest, without throwing', () => {
    const d = normalizeDetails({
      description: `  ${'x'.repeat(DESCRIPTION_MAX + 20)}  `,
      problem: 'Line one\r\n\r\n\r\n\r\nLine two\u0007',
      model: 'b2b',
      teamSize: 0,
      funding: 'unicorn',
      markets: ['ai', 'nope', 'ai', 'saas'],
      tech: Array.from({ length: 40 }, (_, i) => TECH[i]!.id),
      channels: 'seo',
    });
    expect(d.description).toHaveLength(DESCRIPTION_MAX);
    expect(d.problem).toBe('Line one\n\nLine two');
    expect(d.model).toBe('b2b');
    expect(d.teamSize).toBeNull();
    expect(d.funding).toBeNull();
    // Each once, in the list's order.
    expect(d.markets).toEqual(['ai', 'saas']);
    expect(d.tech).toHaveLength(TECH_MAX);
    expect(d.channels).toEqual([]);
    expect(normalizeDetails(null)).toEqual(NO_DETAILS);
  });

  it('stores only what’s filled in, and reads back what it stored', () => {
    expect(serializeProductDetails(NO_DETAILS)).toBeNull();
    expect(hasDetails(NO_DETAILS)).toBe(false);
    const d = normalizeDetails({ description: 'Notes for teams', teamSize: 3, markets: ['productivity'] });
    const json = serializeProductDetails(d)!;
    expect(JSON.parse(json)).toEqual({ description: 'Notes for teams', teamSize: 3, markets: ['productivity'] });
    expect(parseProductDetails(json)).toEqual(d);
  });

  it('reads a broken or outdated row as nothing, or as what it still has', () => {
    expect(parseProductDetails('{nope')).toEqual(NO_DETAILS);
    expect(parseProductDetails(null)).toEqual(NO_DETAILS);
    // A tag a later build no longer lists is dropped, never shown.
    expect(parseProductDetails(JSON.stringify({ markets: ['retired-tag', 'ai'] })).markets).toEqual(['ai']);
    expect(parseProductDetails(JSON.stringify({ markets: Array(MARKETS_MAX + 3).fill('ai') })).markets).toEqual(['ai']);
  });
});

describe('pricing plans', () => {
  const plan = (name: string, period: PricePlan['period'], price: number, currency = 'USD', note: string | null = null): PricePlan => ({
    name,
    period,
    price,
    currency,
    note,
  });

  it('reads a price as typed, in the currency’s minor units', () => {
    expect(parsePlanPrice('29', 'USD')).toEqual({ value: 2900 });
    expect(parsePlanPrice(' 29.99 ', 'USD')).toEqual({ value: 2999 });
    expect(parsePlanPrice('29,9', 'EUR')).toEqual({ value: 2990 });
    expect(parsePlanPrice('$29', 'USD')).toEqual({ value: 2900 });
    expect(parsePlanPrice('1200', 'JPY')).toEqual({ value: 1200 });
    expect(parsePlanPrice('1200.5', 'JPY')).toEqual({ error: 'JPY prices have no decimals.' });
    expect(parsePlanPrice('9.999', 'USD')).toEqual({ error: 'Use at most 2 decimals.' });
    expect(parsePlanPrice('1,290.00', 'USD')).toEqual({ error: 'Enter the price as a number, like 29 or 29.99.' });
    expect(parsePlanPrice('0', 'USD')).toEqual({ error: 'A paid plan needs a price above zero. For one without, pick Free.' });
    expect(parsePlanPrice('free', 'USD')).toEqual({ error: 'Enter the price as a number, like 29 or 29.99.' });
  });

  it('says each plan so it compares with the others', () => {
    expect(describePlan(plan('Pro', 'month', 2900))).toEqual({ price: '$29', unit: '/ month', compare: null });
    expect(describePlan(plan('Pro', 'year', 29000))).toEqual({ price: '$290', unit: '/ year', compare: '$24.17 a month, billed yearly' });
    expect(describePlan(plan('Weekly', 'week', 499))).toEqual({ price: '$4.99', unit: '/ week', compare: 'About $21.62 a month' });
    expect(describePlan(plan('Lifetime', 'once', 9900, 'EUR'))).toEqual({ price: '€99', unit: 'once', compare: 'One payment, no subscription' });
    expect(describePlan(plan('Starter', 'free', 0))).toEqual({ price: 'Free', unit: null, compare: null });
    expect(describePlan(plan('Pro', 'month', 1500, 'JPY')).price).toBe('¥1,500');
    expect(planMonthly(plan('Lifetime', 'once', 9900))).toBeNull();
  });

  it('shows what a yearly plan saves against the monthly one of the same name and currency', () => {
    const plans = [plan('Pro', 'month', 2900), plan('pro ', 'year', 29000), plan('Team', 'year', 99000), plan('Pro', 'year', 30000, 'EUR')];
    expect(yearlySaving(plans[1]!, plans)).toBe(17);
    // No monthly Team plan, and none in euros.
    expect(yearlySaving(plans[2]!, plans)).toBeNull();
    expect(yearlySaving(plans[3]!, plans)).toBeNull();
    expect(yearlySaving(plans[0]!, plans)).toBeNull();
    // A yearly plan dearer than twelve months saves nothing.
    expect(yearlySaving(plan('Pro', 'year', 40000), [plan('Pro', 'month', 2900)])).toBeNull();
  });

  it('keeps the owner’s order, with plans of the same name side by side', () => {
    const plans = [plan('Free', 'free', 0), plan('Pro', 'month', 2900), plan('Team', 'month', 9900), plan('Pro', 'year', 29000)];
    expect(groupPlans(plans).map((p) => `${p.name} ${p.period}`)).toEqual(['Free free', 'Pro month', 'Pro year', 'Team month']);
  });

  it('keeps a stored plan only when it holds together', () => {
    const d = normalizeDetails({
      plans: [
        { name: 'Pro', period: 'month', price: 2900, currency: 'USD', note: 'Unlimited notes\nand more' },
        { name: 'Free', period: 'free', price: 500, currency: 'XXX' },
        { name: '', period: 'month', price: 100, currency: 'USD' },
        { name: 'Bad', period: 'daily', price: 100, currency: 'USD' },
        { name: 'Bad', period: 'month', price: -5, currency: 'USD' },
        'nope',
      ],
    });
    expect(d.plans).toEqual([
      { name: 'Pro', period: 'month', price: 2900, currency: 'USD', note: 'Unlimited notes and more' },
      { name: 'Free', period: 'free', price: 0, currency: 'USD', note: null },
    ]);
  });
});

describe('owner text', () => {
  it('turns back links, email addresses and phone numbers, and nothing else', () => {
    expect(contactIn('Write to me at hi@objekto.io')).toBe('email');
    expect(contactIn('More at https://scam.example/offer')).toBe('link');
    expect(contactIn('Go to www.scam.example')).toBe('link');
    expect(contactIn('Call +33 6 12 34 56 78')).toBe('phone');
    expect(contactIn('WhatsApp 0532 123 45 67')).toBe('phone');
    expect(contactIn('(555) 123-4567 any time')).toBe('phone');
    for (const fine of [
      'Creator $29/mo, 25,000 credits a month',
      'Built on Fly.io and Next.js',
      'From 2025-2026 on',
      '$1,290 a year, 12 months',
      'Order #1234567',
      'Version 2.10.3',
      'Email us from the app',
    ]) {
      expect(contactIn(fine), fine).toBeNull();
    }
  });

  it('drops the characters that make text pass for something else, and keeps emoji whole', () => {
    const d = normalizeDetails({
      // A right-to-left override that would show "exe.txt" as "txt.exe", zero-width spaces, a BOM.
      description: 'Invoice\u202Etxt.exe\u202C and\u200B\uFEFF more',
      // Zalgo: a letter under a dozen marks.
      problem: `Z${'\u0301\u0302\u0303\u0304'.repeat(3)}algo`,
      // A family emoji is joined with zero-width joiners; Vietnamese keeps its marks.
      audience: 'Families 👨‍👩‍👧 and Tiếng Việt readers',
    });
    expect(d.description).toBe('Invoicetxt.exe and more');
    // NFC makes "Z" and its first mark one letter (Ź); three marks stay on it.
    expect(d.problem).toBe('\u0179\u0302\u0303\u0304algo');
    expect(d.audience).toBe('Families 👨‍👩‍👧 and Tiếng Việt readers');
  });
});
