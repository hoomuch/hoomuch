/**
 * A public product's page as Markdown (GET /p/<slug>.md, SPEC F-21), for AI assistants and
 * anything else that reads text. Owner: Experience.
 *
 * It keeps the two kinds of content apart, as the page does: the verified figures, read from the
 * payment providers, and what the owner typed (name, description, website, founder), which is
 * marked as theirs and flattened to one line each.
 */

import type { PublicProductStats } from '../data/types';
import { countryName } from '../lib/countries';
import { formatMoney, formatNumber } from '../lib/money';
import {
  CHANNELS,
  describePlan,
  formatFounded,
  FUNDING,
  groupPlans,
  labelOf,
  MARKETS,
  MODELS,
  TECH,
  yearlySaving,
  type ProductDetails,
} from '../lib/product-details';
import { getProviderMeta } from '../providers/registry';

/** Owner-typed text on one line, without Markdown that could pass for structure. */
function plain(s: string): string {
  return s
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_[\]<>#|]/g, (ch) => `\\${ch}`)
    .trim();
}

const usd = (minor: number) => formatMoney(minor, 'USD', { whole: true });
const pct = (p: number | null) => (p === null ? 'no earlier data' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`);

export function productMarkdown(p: {
  origin: string;
  product: {
    slug: string;
    name: string;
    tagline: string | null;
    website: string | null;
    appStoreUrl?: string | null;
    playStoreUrl?: string | null;
    founded?: string | null;
    country?: string | null;
    details?: ProductDetails;
  };
  owner: { handle: string; name: string; x: string | null } | null;
  stats: PublicProductStats;
}): string {
  const { origin, product, owner, stats } = p;
  const page = `${origin}/p/${product.slug}`;
  const sources = stats.providers.map((id) => getProviderMeta(id).name).join(', ');
  const lines = [
    `# ${plain(product.name)}`,
    '',
    `Public page: ${page}`,
    '',
    '> The figures under "Verified figures" are read by hoomuch from the payment providers listed there,',
    "> with read-only API keys, and the owner can't edit them. Everything under \"From the owner\" is the",
    "> owner's own words.",
    '',
    '## Verified figures',
    '',
    'Amounts in US dollars. Revenue is net of refunds, before fees.',
    '',
    '| Figure | Value |',
    '| --- | ---: |',
    `| MRR | ${usd(stats.mrr.value)} |`,
    `| MRR change vs. 30 days ago | ${pct(stats.mrr.deltaPct)} |`,
    `| Revenue, last 30 days | ${usd(stats.revenue.value)} |`,
    `| Revenue change vs. the 30 days before | ${pct(stats.revenue.deltaPct)} |`,
    ...(stats.revenueSince ? [`| Revenue since ${stats.revenueSince} | ${usd(stats.revenueTotal)} |`] : []),
    `| Active subscriptions | ${formatNumber(stats.activeSubscriptions.value)} |`,
    '',
    `- Sources: ${sources} (read-only API keys)`,
    // The first daily snapshot: how far back MRR and subscriptions are verified (revenue has its own line above).
    `- MRR history since: ${stats.since ?? 'unknown'}`,
    `- Last checked: ${stats.syncedAt === null ? 'not yet' : new Date(stats.syncedAt).toISOString()}`,
    ...(stats.estimated ? ["- Some figures are estimates: a key doesn't have every read permission."] : []),
    ...(stats.revenuePartial ? ['- Revenue leaves out a source that reports no daily history.'] : []),
    ...(stats.missingFx.length > 0 ? [`- Left out, no exchange rate: ${stats.missingFx.join(', ')}`] : []),
    '',
    '## From the owner',
    '',
    ...(product.tagline ? [`- Description: ${plain(product.tagline)}`] : []),
    ...(product.website ? [`- Website: ${product.website}`] : []),
    ...(product.appStoreUrl ? [`- App Store: ${product.appStoreUrl}`] : []),
    ...(product.playStoreUrl ? [`- Google Play: ${product.playStoreUrl}`] : []),
    ...(owner
      ? [
          `- Founder: ${plain(owner.name)} (${origin}/u/${owner.handle})`,
          ...(owner.x ? [`- Founder on X: https://x.com/${owner.x}`] : []),
        ]
      : []),
    ...(product.founded ? [`- Founded: ${formatFounded(product.founded)}`] : []),
    ...(countryName(product.country) ? [`- Country: ${countryName(product.country)}`] : []),
    ...(product.details ? detailLines(product.details) : []),
    '',
    '## About these figures',
    '',
    'They come from hoomuch, an open-source, read-only revenue dashboard, and are worked out again after every sync.',
    'MRR is every active, paid subscription brought to a month, without trials; a subscription set to cancel counts',
    `until it ends. Revenue is what was charged, minus refunds. How each figure is counted: ${origin}/#mrr`,
    '',
  ];
  return lines.join('\n');
}

/** The About section, one line each; tags by their labels. */
function detailLines(d: ProductDetails): string[] {
  const tags = (ids: readonly string[], list: readonly { id: string; label: string }[]) => ids.map((id) => labelOf(list, id)).join(', ');
  return [
    ...(d.message ? [`- Message from the founder: ${plain(d.message)}`] : []),
    ...(d.description ? [`- What it does: ${plain(d.description)}`] : []),
    ...(d.problem ? [`- Problem it solves: ${plain(d.problem)}`] : []),
    ...(d.audience ? [`- Who it's for: ${plain(d.audience)}`] : []),
    ...(d.model ? [`- Business model: ${labelOf(MODELS, d.model)}`] : []),
    ...groupPlans(d.plans).map((p) => {
      const read = describePlan(p);
      const saving = yearlySaving(p, d.plans);
      const price = read.unit ? `${read.price} ${read.unit.replace('/ ', 'a ')}` : read.price;
      const extra = [read.compare, saving ? `saves ${saving}% against monthly` : null, p.note ? plain(p.note) : null].filter(Boolean);
      return `- Plan: ${plain(p.name)}, ${price}${extra.length > 0 ? ` (${extra.join('; ')})` : ''}`;
    }),
    ...(d.pricing ? [`- Pricing: ${plain(d.pricing)}`] : []),
    ...(d.teamSize !== null ? [`- Team: ${formatNumber(d.teamSize)} ${d.teamSize === 1 ? 'person' : 'people'}`] : []),
    ...(d.funding ? [`- Funding: ${labelOf(FUNDING, d.funding)}`] : []),
    ...(d.markets.length > 0 ? [`- Market: ${tags(d.markets, MARKETS)}`] : []),
    ...(d.tech.length > 0 ? [`- Tech stack: ${tags(d.tech, TECH)}`] : []),
    ...(d.channels.length > 0 ? [`- Marketing channels: ${tags(d.channels, CHANNELS)}`] : []),
    ...(d.more ? [`- Anything else: ${plain(d.more)}`] : []),
  ];
}
