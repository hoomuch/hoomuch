/**
 * An owner's public profile (GET /u/<handle>, SPEC F-22). Owner: Experience (pages).
 *
 * Laid out like a profile on a social network: initials, name, @handle, bio and links, with the
 * share buttons beside the name; then the owner's published products added up (all in USD, so they
 * add up as they are) and listed, each linking to its own page. Like the product page it renders
 * without the visitor's session. The name, bio and links are the owner's own words.
 */

import { BadgeCheck, Link2 } from 'lucide-react';
import type { Kpi, PublicFigures } from '../../data/types';
import { formatMoney, formatNumber } from '../../lib/money';
import { STALE_AFTER_MS } from '../../lib/public-pages';
import { Avatar } from '../components/avatar';
import { XMark } from '../components/icons';
import { KpiStat } from '../components/kpi';
import { ProductCard } from '../components/product-card';
import { STAT_CELL, StatGrid, VerifiedNote } from '../components/public-stats';
import { ShareButtons } from '../components/share-sheet';
import { profileJsonLd } from '../json-ld';
import { Layout } from '../layout';
import { useNow } from '../page-root';
import { ReportLink, ShowYourOwn } from './public-product';
import { formatDay } from './shared';

export interface PublicProfilePageProps {
  /** `avatar` and each `logo` are image URLs (lib/media.ts), null for initials. */
  profile: { handle: string; displayName: string; bio: string | null; website: string | null; xHandle: string | null; avatar: string | null };
  products: Array<{ slug: string; name: string; tagline: string | null; logo: string | null; stats: PublicFigures }>;
  url: string;
  image: string;
  /** Sign-up is open on this instance: the call to action says "Start free". */
  signupOpen: boolean;
  /** The instance publishes a privacy policy and terms: the footer links them. */
  legal?: boolean;
  /** Search engines are asked not to index it yet (lib/public-pages.ts searchIndexable). */
  noindex?: boolean;
  /** Where to report the page: the instance operator's address, when it names one. */
  reportTo?: string;
}

/** Rendered without the visitor's session; only served where public pages, Explore included, are on. */
const NO_CHROME = { user: null, flash: null, explore: true, exploreInHeader: true };
const usd = (minor: number) => formatMoney(minor, 'USD', { whole: true });
/** The owner's links: quiet, with an icon, like a social profile's. */
const OWNER_LINK = 'inline-flex min-w-0 items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground';

/** Products' figures added up; a change only when every product has one to compare with. */
function total(kpis: Kpi[]): Kpi {
  const value = kpis.reduce((s, k) => s + k.value, 0);
  const previous = kpis.every((k) => k.previous !== null) ? kpis.reduce((s, k) => s + (k.previous ?? 0), 0) : null;
  return { value, previous, deltaPct: previous === null || previous === 0 ? null : ((value - previous) / Math.abs(previous)) * 100 };
}

export function PublicProfilePage(props: PublicProfilePageProps) {
  const { profile, products } = props;
  const now = useNow();
  const mrr = total(products.map((p) => p.stats.mrr));
  const revenue = total(products.map((p) => p.stats.revenue));
  const subs = total(products.map((p) => p.stats.activeSubscriptions));
  const mrrText = usd(mrr.value);
  const revenueTotal = products.reduce((sum, p) => sum + p.stats.revenueTotal, 0);
  const since = products.map((p) => p.stats.revenueSince).filter((d): d is string => d !== null).sort()[0] ?? null;
  const count = products.length === 1 ? '1 product' : `${products.length} products`;
  const title = `${profile.displayName}: ${mrrText} MRR across ${count}, verified`;
  const description = `${usd(revenue.value)} revenue in the last 30 days across ${count}, read from their payment providers by hoomuch.`;
  return (
    <Layout
      {...NO_CHROME}
      legal={props.legal}
      noindex={props.noindex}
      title={title}
      description={description}
      og={{ url: props.url, image: props.image, title }}
      jsonLd={profileJsonLd({ url: props.url, title, description, profile, products })}
      marketing
    >
      {/* The header to the content: 32 (design/system.md §3.3), then 24 between blocks, on the full app column. */}
      <header className="mb-8">
        <p className="flex items-center gap-2 text-body font-medium text-success-foreground">
          <BadgeCheck className="size-4 shrink-0" />
          Revenue verified by hoomuch
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <div className="flex min-w-0 items-center gap-4">
            <Avatar name={profile.displayName} src={profile.avatar} className="size-16 font-heading text-title sm:size-20 sm:text-section-sm" />
            <div className="min-w-0">
              <h1 className="font-heading text-hero-sm wrap-break-word">{profile.displayName}</h1>
              <p className="text-body text-muted-foreground">@{profile.handle}</p>
            </div>
          </div>
          <ShareButtons url={props.url} title={profile.displayName} text={`${profile.displayName} is at ${mrrText} MRR, verified by hoomuch`} copy />
        </div>
        {profile.bio ? <p className="mt-4 max-w-[34rem] text-lead text-pretty wrap-break-word">{profile.bio}</p> : null}
        {profile.website || profile.xHandle ? (
          <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-body">
            {profile.website ? (
              <a href={profile.website} rel="nofollow ugc noopener noreferrer" target="_blank" className={OWNER_LINK}>
                <Link2 className="size-4 shrink-0" />
                <span className="truncate">{profile.website.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '')}</span>
              </a>
            ) : null}
            {profile.xHandle ? (
              <a href={`https://x.com/${profile.xHandle}`} rel="nofollow ugc noopener noreferrer" target="_blank" className={OWNER_LINK}>
                <XMark className="size-3.5 shrink-0" />@{profile.xHandle}
              </a>
            ) : null}
          </p>
        ) : null}
      </header>

      <div className="grid gap-6">
        <StatGrid label="Totals" note="Changes compare with 30 days ago. Revenue compares with the 30 days before. Amounts in US dollars.">
          <KpiStat
            inlineDelta
            className={STAT_CELL}
            label="Total revenue"
            value={usd(revenueTotal)}
            hint={since ? `Since ${formatDay(since)}` : 'No history yet'}
          />
          <KpiStat
            inlineDelta
            className={STAT_CELL}
            label="MRR"
            value={mrrText}
            deltaPct={mrr.deltaPct}
            deltaLabel="vs. 30 days ago"
            hint={`${formatNumber(subs.value)} subscriptions`}
          />
          <KpiStat
            inlineDelta
            className={STAT_CELL}
            label="Revenue, 30 days"
            value={usd(revenue.value)}
            deltaPct={revenue.deltaPct}
            deltaLabel="vs. the 30 days before"
          />
          <KpiStat inlineDelta className={STAT_CELL} label="Products" value={String(products.length)} hint="With verified revenue" />
        </StatGrid>

        {/* A section with its own heading: 32 above it, not the 24 between cards. */}
        <section aria-labelledby="products-title" className="mt-2">
          <h2 id="products-title" className="mb-4 font-heading text-base">
            Products by {profile.displayName}
          </h2>
          <ul className="grid gap-6 sm:grid-cols-2">
            {products.map((p) => {
              const stale = p.stats.syncedAt === null || now - p.stats.syncedAt > STALE_AFTER_MS;
              return (
                <li key={p.slug} className="min-w-0">
                  <ProductCard
                    href={`/p/${p.slug}`}
                    name={p.name}
                    tagline={p.tagline}
                    logo={p.logo}
                    figures={[
                      { label: 'Revenue, 30d', value: usd(p.stats.revenue.value) },
                      { label: 'MRR', value: usd(p.stats.mrr.value) },
                      { label: 'Total', value: usd(p.stats.revenueTotal) },
                    ]}
                    providers={p.stats.providers}
                    note={stale ? 'Not updated recently' : null}
                  />
                </li>
              );
            })}
          </ul>
        </section>

        <VerifiedNote
          details={
            <p>
              hoomuch reads each product’s figures from its payment providers with read-only API keys, on a schedule, and the
              owner can’t edit them. Amounts are in US dollars. The name, bio and links above are the owner’s own words.
            </p>
          }
        >
          Read from each product’s payment providers with read-only API keys.
        </VerifiedNote>
      </div>

      {props.reportTo ? <ReportLink to={props.reportTo} url={props.url} /> : null}

      <ShowYourOwn signupOpen={props.signupOpen} />
    </Layout>
  );
}


