/**
 * What an owner tells visitors about a product (SPEC F-21): when it was founded, and the details
 * its public page shows under "About" (a message from the founder, what it does, who it's for, its
 * pricing plans, team, funding, and tags).
 * Owner: Lead. Pure, so the Share page's form and the public page use the same rules as the server.
 *
 * Everything here is the owner's own words; the page says so and keeps it apart from the verified
 * figures. Tags come from fixed lists, so they read the same on every page and Explore can filter on
 * them later; a stored id a later build no longer lists is dropped when read, never shown.
 */

import { currencyExponent, formatMoney, isSupportedCurrency, normalizeToMonthly } from './money';

// ---------- founded ----------

/** The earliest year a product can say it was founded. */
export const FOUNDED_MIN_YEAR = 1970;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** The month picker's choices: "01" to "12" with their English names. */
export const FOUNDED_MONTHS: ReadonlyArray<{ value: string; label: string }> = MONTHS.map((label, i) => ({
  value: String(i + 1).padStart(2, '0'),
  label,
}));

const FOUNDED_RE = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$/;

/** A stored founded value: 'YYYY' or 'YYYY-MM'. */
export function isFounded(v: string | null | undefined): v is string {
  return typeof v === 'string' && FOUNDED_RE.test(v) && Number(v.slice(0, 4)) >= FOUNDED_MIN_YEAR;
}

/** "November 2026" for '2026-11', "2026" for '2026'. Month names are written out, the same everywhere. */
export function formatFounded(v: string): string {
  const m = FOUNDED_RE.exec(v);
  if (!m) return v;
  return m[2] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : m[1]!;
}

/**
 * The founded date from the form's year and month (either may be empty), checked against today
 * (UTC): null when neither is given; an error for a month without a year, a year out of range, or
 * a month still to come.
 */
export function parseFounded(year: string, month: string, now: number): { value: string | null } | { error: string } {
  const y = year.trim();
  const mo = month.trim();
  if (!y && !mo) return { value: null };
  if (!y) return { error: 'Pick the year too.' };
  const today = new Date(now);
  const thisYear = today.getUTCFullYear();
  if (!/^\d{4}$/.test(y) || Number(y) < FOUNDED_MIN_YEAR || Number(y) > thisYear) {
    return { error: `Pick a year from ${FOUNDED_MIN_YEAR} to ${thisYear}.` };
  }
  if (!mo) return { value: y };
  if (!/^(0[1-9]|1[0-2])$/.test(mo)) return { error: 'Pick a month from the list.' };
  if (Number(y) === thisYear && Number(mo) > today.getUTCMonth() + 1) return { error: 'That month hasn’t come yet.' };
  return { value: `${y}-${mo}` };
}

// ---------- the fixed lists ----------

interface Choice<Id extends string> {
  id: Id;
  label: string;
}

export const MODELS = [
  { id: 'b2c', label: 'B2C' },
  { id: 'b2b', label: 'B2B' },
  { id: 'both', label: 'B2B and B2C' },
] as const satisfies readonly Choice<string>[];
type ModelId = (typeof MODELS)[number]['id'];

export const FUNDING = [
  { id: 'bootstrapped', label: 'Bootstrapped' },
  { id: 'angel', label: 'Angel' },
  { id: 'pre-seed', label: 'Pre-seed' },
  { id: 'seed', label: 'Seed' },
  { id: 'series-a', label: 'Series A' },
  { id: 'series-b', label: 'Series B or later' },
  { id: 'grants', label: 'Grants' },
] as const satisfies readonly Choice<string>[];
type FundingId = (typeof FUNDING)[number]['id'];

export const MARKETS = [
  { id: 'ai', label: 'AI' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'community', label: 'Community' },
  { id: 'content', label: 'Content creation' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'design', label: 'Design tools' },
  { id: 'devtools', label: 'Developer tools' },
  { id: 'ecommerce', label: 'E-commerce' },
  { id: 'education', label: 'Education' },
  { id: 'finance', label: 'Finance' },
  { id: 'food', label: 'Food & drink' },
  { id: 'games', label: 'Games' },
  { id: 'health', label: 'Health & fitness' },
  { id: 'hr', label: 'HR & recruiting' },
  { id: 'legal', label: 'Legal' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'mobile', label: 'Mobile apps' },
  { id: 'music', label: 'Music & audio' },
  { id: 'nocode', label: 'No-code' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'real-estate', label: 'Real estate' },
  { id: 'saas', label: 'SaaS' },
  { id: 'sales', label: 'Sales' },
  { id: 'security', label: 'Security' },
  { id: 'social', label: 'Social' },
  { id: 'support', label: 'Customer support' },
  { id: 'travel', label: 'Travel' },
] as const satisfies readonly Choice<string>[];
export type MarketId = (typeof MARKETS)[number]['id'];

export const CHANNELS = [
  { id: 'seo', label: 'SEO' },
  { id: 'content', label: 'Content & blog' },
  { id: 'product-hunt', label: 'Product Hunt' },
  { id: 'x', label: 'X' },
  { id: 'reddit', label: 'Reddit' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'hacker-news', label: 'Hacker News' },
  { id: 'press', label: 'Press & PR' },
  { id: 'ads', label: 'Paid ads' },
  { id: 'outreach', label: 'Cold outreach' },
  { id: 'newsletter', label: 'Newsletter' },
  { id: 'affiliates', label: 'Affiliates' },
  { id: 'communities', label: 'Communities' },
  { id: 'aso', label: 'App Store search' },
  { id: 'directories', label: 'Directories' },
  { id: 'partnerships', label: 'Partnerships' },
  { id: 'word-of-mouth', label: 'Word of mouth' },
] as const satisfies readonly Choice<string>[];
export type ChannelId = (typeof CHANNELS)[number]['id'];

export const TECH_GROUPS = [
  { id: 'frontend', label: 'Frontend' },
  { id: 'mobile', label: 'Mobile' },
  { id: 'backend', label: 'Backend' },
  { id: 'data', label: 'Data' },
  { id: 'hosting', label: 'Hosting' },
  { id: 'services', label: 'Payments, email and auth' },
  { id: 'ai', label: 'AI' },
] as const satisfies readonly Choice<string>[];
export type TechGroupId = (typeof TECH_GROUPS)[number]['id'];

export const TECH = [
  { id: 'react', label: 'React', group: 'frontend' },
  { id: 'nextjs', label: 'Next.js', group: 'frontend' },
  { id: 'vue', label: 'Vue', group: 'frontend' },
  { id: 'nuxt', label: 'Nuxt', group: 'frontend' },
  { id: 'svelte', label: 'Svelte', group: 'frontend' },
  { id: 'angular', label: 'Angular', group: 'frontend' },
  { id: 'astro', label: 'Astro', group: 'frontend' },
  { id: 'remix', label: 'Remix', group: 'frontend' },
  { id: 'solid', label: 'Solid', group: 'frontend' },
  { id: 'htmx', label: 'htmx', group: 'frontend' },
  { id: 'tailwind', label: 'Tailwind CSS', group: 'frontend' },
  { id: 'typescript', label: 'TypeScript', group: 'frontend' },
  { id: 'javascript', label: 'JavaScript', group: 'frontend' },
  { id: 'swift', label: 'Swift', group: 'mobile' },
  { id: 'kotlin', label: 'Kotlin', group: 'mobile' },
  { id: 'flutter', label: 'Flutter', group: 'mobile' },
  { id: 'react-native', label: 'React Native', group: 'mobile' },
  { id: 'expo', label: 'Expo', group: 'mobile' },
  { id: 'node', label: 'Node.js', group: 'backend' },
  { id: 'bun', label: 'Bun', group: 'backend' },
  { id: 'deno', label: 'Deno', group: 'backend' },
  { id: 'hono', label: 'Hono', group: 'backend' },
  { id: 'python', label: 'Python', group: 'backend' },
  { id: 'django', label: 'Django', group: 'backend' },
  { id: 'fastapi', label: 'FastAPI', group: 'backend' },
  { id: 'rails', label: 'Ruby on Rails', group: 'backend' },
  { id: 'laravel', label: 'Laravel', group: 'backend' },
  { id: 'php', label: 'PHP', group: 'backend' },
  { id: 'go', label: 'Go', group: 'backend' },
  { id: 'rust', label: 'Rust', group: 'backend' },
  { id: 'elixir', label: 'Elixir', group: 'backend' },
  { id: 'java', label: 'Java', group: 'backend' },
  { id: 'dotnet', label: '.NET', group: 'backend' },
  { id: 'postgres', label: 'PostgreSQL', group: 'data' },
  { id: 'mysql', label: 'MySQL', group: 'data' },
  { id: 'sqlite', label: 'SQLite', group: 'data' },
  { id: 'mongodb', label: 'MongoDB', group: 'data' },
  { id: 'redis', label: 'Redis', group: 'data' },
  { id: 'supabase', label: 'Supabase', group: 'data' },
  { id: 'firebase', label: 'Firebase', group: 'data' },
  { id: 'convex', label: 'Convex', group: 'data' },
  { id: 'prisma', label: 'Prisma', group: 'data' },
  { id: 'drizzle', label: 'Drizzle', group: 'data' },
  { id: 'vercel', label: 'Vercel', group: 'hosting' },
  { id: 'netlify', label: 'Netlify', group: 'hosting' },
  { id: 'cloudflare', label: 'Cloudflare', group: 'hosting' },
  { id: 'railway', label: 'Railway', group: 'hosting' },
  { id: 'render', label: 'Render', group: 'hosting' },
  { id: 'fly', label: 'Fly.io', group: 'hosting' },
  { id: 'heroku', label: 'Heroku', group: 'hosting' },
  { id: 'digitalocean', label: 'DigitalOcean', group: 'hosting' },
  { id: 'aws', label: 'AWS', group: 'hosting' },
  { id: 'gcp', label: 'Google Cloud', group: 'hosting' },
  { id: 'hetzner', label: 'Hetzner', group: 'hosting' },
  { id: 'docker', label: 'Docker', group: 'hosting' },
  { id: 'stripe', label: 'Stripe', group: 'services' },
  { id: 'paddle', label: 'Paddle', group: 'services' },
  { id: 'lemonsqueezy', label: 'Lemon Squeezy', group: 'services' },
  { id: 'revenuecat', label: 'RevenueCat', group: 'services' },
  { id: 'resend', label: 'Resend', group: 'services' },
  { id: 'clerk', label: 'Clerk', group: 'services' },
  { id: 'auth0', label: 'Auth0', group: 'services' },
  { id: 'posthog', label: 'PostHog', group: 'services' },
  { id: 'openai', label: 'OpenAI', group: 'ai' },
  { id: 'anthropic', label: 'Anthropic', group: 'ai' },
  { id: 'gemini', label: 'Gemini', group: 'ai' },
  { id: 'huggingface', label: 'Hugging Face', group: 'ai' },
  { id: 'langchain', label: 'LangChain', group: 'ai' },
  { id: 'ollama', label: 'Ollama', group: 'ai' },
] as const satisfies readonly (Choice<string> & { group: TechGroupId })[];
type TechId = (typeof TECH)[number]['id'];

// ---------- pricing plans ----------

/** How a plan is billed. A free plan has no price. */
export const PLAN_PERIODS = [
  { id: 'free', label: 'Free' },
  { id: 'week', label: 'Weekly' },
  { id: 'month', label: 'Monthly' },
  { id: 'year', label: 'Yearly' },
  { id: 'once', label: 'One-time' },
] as const satisfies readonly Choice<string>[];
type PlanPeriod = (typeof PLAN_PERIODS)[number]['id'];

/** One way to pay for the product, as its pricing page says it: "Pro, $29 a month". */
export interface PricePlan {
  name: string;
  period: PlanPeriod;
  /** Minor units of `currency`; 0 for a free plan. */
  price: number;
  /** An uppercase ISO code from SUPPORTED_CURRENCIES. */
  currency: string;
  /** What it includes or anything to know, in one line: "2,500 credits a month", "7-day free trial". */
  note: string | null;
}

export const PLANS_MAX = 6;
export const PLAN_NAME_MAX = 40;
export const PLAN_NOTE_MAX = 80;
/** The most a plan can cost, in major units: past this it's a typo. */
const PLAN_PRICE_MAX = 1_000_000;

const PERIOD_IDS = ids(PLAN_PERIODS);

/**
 * A price as typed, in `currency`'s minor units: digits, with "." or "," before the decimals
 * ("29", "29.99", "29,99"); no thousands separators, no more decimals than the currency has.
 */
export function parsePlanPrice(input: string, currency: string): { value: number } | { error: string } {
  const raw = input.replace(/\s/g, '').replace(/^[$€£¥₺]/, '');
  const m = /^(\d{1,7})(?:[.,](\d{1,4}))?$/.exec(raw);
  if (!m) return { error: 'Enter the price as a number, like 29 or 29.99.' };
  const digits = currencyExponent(currency);
  const decimals = m[2] ?? '';
  if (decimals.length > digits) {
    return { error: digits === 0 ? `${currency} prices have no decimals.` : `Use at most ${digits} decimals.` };
  }
  const value = Number(m[1]) * 10 ** digits + Number(decimals.padEnd(digits, '0') || 0);
  if (value <= 0) return { error: 'A paid plan needs a price above zero. For one without, pick Free.' };
  if (value > PLAN_PRICE_MAX * 10 ** digits) return { error: 'That price looks too high.' };
  return { value };
}

/** A plan from anything (stored JSON): null when it doesn't hold together. */
function readPlan(v: unknown): PricePlan | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  const name = cleanText(p.name, PLAN_NAME_MAX)?.replace(/\n+/g, ' ') ?? null;
  const period = typeof p.period === 'string' && PERIOD_IDS.has(p.period) ? (p.period as PlanPeriod) : null;
  const currency = typeof p.currency === 'string' && isSupportedCurrency(p.currency) ? p.currency : 'USD';
  if (!name || !period) return null;
  if (period === 'free') return { name, period, price: 0, currency, note: cleanText(p.note, PLAN_NOTE_MAX)?.replace(/\n+/g, ' ') ?? null };
  const price = p.price;
  if (typeof price !== 'number' || !Number.isInteger(price) || price <= 0 || price > PLAN_PRICE_MAX * 10 ** currencyExponent(currency)) return null;
  return { name, period, price, currency, note: cleanText(p.note, PLAN_NOTE_MAX)?.replace(/\n+/g, ' ') ?? null };
}

/** What a plan comes to a month, for comparing them (weeks at 52 a year); null for free and one-time ones. */
export function planMonthly(p: PricePlan): number | null {
  if (p.period === 'month') return p.price;
  if (p.period === 'year') return normalizeToMonthly(p.price, 'year');
  if (p.period === 'week') return normalizeToMonthly(p.price, 'week');
  return null;
}

/**
 * How much a yearly plan saves against the monthly plan of the same name and currency, in whole
 * percent; null when there's no such plan or it saves nothing.
 */
export function yearlySaving(plan: PricePlan, plans: readonly PricePlan[]): number | null {
  if (plan.period !== 'year') return null;
  const monthly = plans.find((p) => p.period === 'month' && p.currency === plan.currency && sameName(p.name, plan.name));
  if (!monthly) return null;
  const pct = Math.round((1 - plan.price / (monthly.price * 12)) * 100);
  return pct > 0 ? pct : null;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The plans in the order to show them: the owner's, with plans of the same name side by side. */
export function groupPlans(plans: readonly PricePlan[]): PricePlan[] {
  const out: PricePlan[] = [];
  for (const p of plans) {
    if (out.includes(p)) continue;
    out.push(p, ...plans.filter((q) => q !== p && !out.includes(q) && sameName(q.name, p.name)));
  }
  return out;
}

// ---------- the details ----------

export const MESSAGE_MAX = 600;
export const DESCRIPTION_MAX = 500;
export const PROBLEM_MAX = 400;
export const AUDIENCE_MAX = 200;
export const PRICING_MAX = 200;
export const MORE_MAX = 600;
export const TEAM_SIZE_MAX = 10_000;
export const MARKETS_MAX = 5;
export const TECH_MAX = 16;
export const CHANNELS_MAX = 8;

export interface ProductDetails {
  /** The founder to visitors, in their own voice: why they built it, where it's going, what they'd like. */
  message: string | null;
  /** What it does, in a few sentences (the line under the name says it in one). */
  description: string | null;
  /** The problem it solves. */
  problem: string | null;
  /** Who it's for. */
  audience: string | null;
  model: ModelId | null;
  /** How it charges: one plan per way to pay. */
  plans: PricePlan[];
  /** Anything else about pricing, in a line or two. */
  pricing: string | null;
  /** People working on it, 1 to TEAM_SIZE_MAX. */
  teamSize: number | null;
  funding: FundingId | null;
  markets: MarketId[];
  tech: TechId[];
  channels: ChannelId[];
  /** Anything else the owner wants to say. */
  more: string | null;
}

export const NO_DETAILS: ProductDetails = {
  message: null,
  description: null,
  problem: null,
  audience: null,
  model: null,
  plans: [],
  pricing: null,
  teamSize: null,
  funding: null,
  markets: [],
  tech: [],
  channels: [],
  more: null,
};

/**
 * Owner text as it's kept: Windows line ends made plain, control characters out (newlines stay),
 * and the characters that make text pass for something else out too: direction overrides and
 * isolates (U+202A–U+202E, U+2066–U+2069, LRM, RLM), zero-width spaces, word joiners and BOMs. The
 * zero-width joiner stays, as emoji need it. Marks stacked on a letter are kept to three (enough for
 * Thai or Vietnamese, not for "zalgo" text spilling over the lines around it). No more than one blank
 * line in a row, trimmed and cut to `max`. Null when nothing is left.
 */
function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '')
    .replace(/(\p{M}{3})\p{M}+/gu, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
    .trim();
  return s === '' ? null : s;
}

/**
 * What a visitor could be sent away by, in owner text: a link (with its scheme or "www."), an email
 * address or a phone number (ten digits or more, or eight after a "+"). Links belong in the website
 * and store fields, which are nofollow; an address may well be a customer's (hoomuch never shows
 * one); and a number is how most scams go on from a page. Null when there's none. Prices, years and
 * names with a dot in them ("Fly.io", "Next.js") are none of these.
 */
export function contactIn(text: string): 'link' | 'email' | 'phone' | null {
  if (/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i.test(text)) return 'email';
  if (/\b(?:https?:\/\/|www\.)\S/i.test(text)) return 'link';
  for (const m of text.matchAll(/\+?\d[\d\s().-]{6,}\d/g)) {
    const digits = m[0].replace(/\D/g, '').length;
    if (digits >= 10 || (m[0].startsWith('+') && digits >= 8)) return 'phone';
  }
  return null;
}

function ids<T extends string>(list: readonly { id: T }[]): Set<string> {
  return new Set<string>(list.map((c) => c.id));
}
const MODEL_IDS = ids(MODELS);
const FUNDING_IDS = ids(FUNDING);
const MARKET_IDS = ids(MARKETS);
const TECH_IDS = ids(TECH);
const CHANNEL_IDS = ids(CHANNELS);

/** The ids in `v` that the list has, each once, in the list's order, at most `max` of them. */
function pick<T extends string>(v: unknown, list: readonly { id: T }[], known: Set<string>, max: number): T[] {
  if (!Array.isArray(v)) return [];
  const chosen = new Set(v.filter((x): x is string => typeof x === 'string' && known.has(x)));
  return list.filter((c) => chosen.has(c.id)).map((c) => c.id).slice(0, max);
}

function teamSize(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= TEAM_SIZE_MAX ? v : null;
}

/** The details from anything (a stored JSON value, a form's values): whatever fits is kept, nothing throws. */
export function normalizeDetails(v: Partial<Record<keyof ProductDetails, unknown>> | null | undefined): ProductDetails {
  if (!v || typeof v !== 'object') return NO_DETAILS;
  return {
    message: cleanText(v.message, MESSAGE_MAX),
    description: cleanText(v.description, DESCRIPTION_MAX),
    problem: cleanText(v.problem, PROBLEM_MAX),
    audience: cleanText(v.audience, AUDIENCE_MAX),
    model: typeof v.model === 'string' && MODEL_IDS.has(v.model) ? (v.model as ModelId) : null,
    plans: Array.isArray(v.plans) ? v.plans.map(readPlan).filter((p): p is PricePlan => p !== null).slice(0, PLANS_MAX) : [],
    pricing: cleanText(v.pricing, PRICING_MAX),
    teamSize: teamSize(v.teamSize),
    funding: typeof v.funding === 'string' && FUNDING_IDS.has(v.funding) ? (v.funding as FundingId) : null,
    markets: pick(v.markets, MARKETS, MARKET_IDS, MARKETS_MAX),
    tech: pick(v.tech, TECH, TECH_IDS, TECH_MAX),
    channels: pick(v.channels, CHANNELS, CHANNEL_IDS, CHANNELS_MAX),
    more: cleanText(v.more, MORE_MAX),
  };
}

/** The stored details (`public_products.details`); NO_DETAILS for none or anything unreadable. */
export function parseProductDetails(json: string | null | undefined): ProductDetails {
  if (!json) return NO_DETAILS;
  try {
    return normalizeDetails(JSON.parse(json) as Partial<Record<keyof ProductDetails, unknown>>);
  } catch {
    return NO_DETAILS;
  }
}

/** Whether the owner filled anything in. */
export function hasDetails(d: ProductDetails): boolean {
  return Object.values(d).some((v) => (Array.isArray(v) ? v.length > 0 : v !== null));
}

/** The JSON to store: only what's filled in; null when nothing is. */
export function serializeProductDetails(d: ProductDetails): string | null {
  if (!hasDetails(d)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (Array.isArray(v) ? v.length > 0 : v !== null) out[k] = v;
  return JSON.stringify(out);
}

/** A choice's label by id, for the page and the Markdown. */
export function labelOf(list: readonly { id: string; label: string }[], id: string): string {
  return list.find((c) => c.id === id)?.label ?? id;
}

/**
 * How a plan reads, the same on the page and in the Markdown: its price ("$29", "Free"), the unit
 * after it ("/ month"), and a line that makes it comparable with the others ("$24.17 a month,
 * billed yearly"), or null when there's nothing to add.
 */
export function describePlan(p: PricePlan): { price: string; unit: string | null; compare: string | null } {
  if (p.period === 'free') return { price: 'Free', unit: null, compare: null };
  const whole = p.price % 10 ** currencyExponent(p.currency) === 0;
  const price = formatMoney(p.price, p.currency, { whole });
  const monthly = planMonthly(p);
  const perMonth = monthly === null ? null : formatMoney(monthly, p.currency);
  switch (p.period) {
    case 'week':
      return { price, unit: '/ week', compare: `About ${perMonth} a month` };
    case 'month':
      return { price, unit: '/ month', compare: null };
    case 'year':
      return { price, unit: '/ year', compare: `${perMonth} a month, billed yearly` };
    case 'once':
      return { price, unit: 'once', compare: 'One payment, no subscription' };
  }
}
