/**
 * A public product's page as Markdown (GET /p/<slug>.md, SPEC F-21), for AI assistants and
 * anything else that reads text. Owner: Experience.
 *
 * It keeps the two kinds of content apart, as the page does: the verified figures, read from the
 * payment providers, and what the owner typed (name, description, website, founder), which is
 * marked as theirs and flattened to one line each.
 */

import type { PublicProductStats } from '../data/types';
import { formatMoney, formatNumber } from '../lib/money';
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
  product: { slug: string; name: string; tagline: string | null; website: string | null; appStoreUrl?: string | null; playStoreUrl?: string | null };
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
    `- Data since: ${stats.since ?? 'unknown'}`,
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
    '',
  ];
  return lines.join('\n');
}
