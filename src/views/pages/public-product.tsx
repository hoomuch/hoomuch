/**
 * A published product's public page (GET /p/<slug>, SPEC F-21). Owner: Experience (pages).
 *
 * Rendered without the visitor's session: no account, flash or zone of theirs reaches it, so the
 * same HTML can be cached for everyone. The figures are the stored PublicProductStats, in USD.
 * The name, tagline, website and founder details are the owner's words, and the page says so.
 *
 * Order: who and what (name, tagline, the founder as a byline with where and since when; Visit and
 * the share buttons), then how much it makes (total revenue, MRR, the last 30 days, subscriptions),
 * the chart (MRR or revenue, switched in place), the line saying where the figures come from with
 * the details behind it, what the founder says about it (About), and the one action for a visitor:
 * have a page like this.
 */

import { ArrowUpRight, BadgeCheck, Flag, ImageDown, Lock, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Button as CossButton } from '@/components/ui/button';
import { Card as CossCard, CardPanel } from '@/components/ui/card';
import { isOpenView, PUBLIC_RANGES, type MrrDay, type PublicFigures, type PublicHistory, type PublicMetric, type PublicRange, type RevenuePoint } from '../../data/types';
import { countryFlag, countryName } from '../../lib/countries';
import { formatMoney, formatNumber } from '../../lib/money';
import { formatFounded, type ProductDetails } from '../../lib/product-details';
import { STALE_AFTER_MS } from '../../lib/public-pages';
import { hasSignedInHint } from '../../lib/signed-in';
import { addDays, dayRange } from '../../lib/time';
import { getProviderMeta } from '../../providers/registry';
import { MrrChart } from '../charts/mrr-chart';
import { RevenueChart } from '../charts/revenue-chart';
import { DeltaBadge, KpiStat } from '../components/kpi';
import { Avatar, ProductTile } from '../components/avatar';
import { STAT_CELL, StatGrid, VerifiedNote } from '../components/public-stats';
import { XMark } from '../components/icons';
import { CopyField } from '../components/copy-field';
import { ProductAbout } from '../components/product-about';
import { needsHistory, type CardData, type CardKind } from '../components/share-cards/layout';
import { ShareCards } from '../components/share-cards/share-cards';
import { ProviderLogo } from '../components/provider-logos';
import { RelativeTime } from '../components/relative-time';
import { ShareButtons } from '../components/share-sheet';
import { Alert, LinkButton, SegmentedLinks, TextLink } from '../components/ui';
import { Layout } from '../layout';
import { useNow } from '../page-root';
import { useSignedIn } from '../use-signed-in';
import { formatDay, listNames } from './shared';

export interface PublicProductPageProps {
  /** `logo` is an image URL (lib/media.ts), null for initials. */
  product: {
    slug: string;
    name: string;
    tagline: string | null;
    website: string | null;
    /** The app's store listings, canonical (lib/public-pages.ts); null for none. */
    appStoreUrl: string | null;
    playStoreUrl: string | null;
    logo: string | null;
    /** When it was founded, 'YYYY' or 'YYYY-MM', and where (ISO code); null for none. The owner's words. */
    founded?: string | null;
    country?: string | null;
    /** The About section, the owner's words (lib/product-details.ts). */
    details?: ProductDetails;
  };
  /** The figures, without the chart history a visitor needs an account for (publicFigures). */
  stats: PublicFigures;
  /** The founder (SPEC F-22): every published product has one. */
  owner: { handle: string; name: string; x: string | null; avatar: string | null } | null;
  /** This page's absolute URL (canonical, link previews, Share). */
  url: string;
  /** The link preview image, absolute. */
  image: string;
  /** The page as Markdown, absolute (`<link rel="alternate">`). */
  markdown: string;
  /** The chart view the URL asked for (`?chart=&range=`); revenue over 30 days by default. */
  view?: ChartView;
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
const NO_CHROME = { user: null, flash: null, explore: true };
const usd = (minor: number) => formatMoney(minor, 'USD', { whole: true });

/** "acme.com/pricing" from "https://acme.com/pricing": what the link shows. */
function siteLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return `${u.hostname.replace(/^www\./, '')}${path}`;
  } catch {
    return url;
  }
}

/** The title and description link previews show: the figure first, as a person would say it. */
function publicProductSummary(product: { name: string }, stats: PublicFigures): { title: string; description: string } {
  const providers = listNames(stats.providers.map((p) => getProviderMeta(p).name));
  return {
    title: `${product.name}: ${usd(stats.mrr.value)} MRR, verified`,
    description:
      `${usd(stats.revenue.value)} revenue in the last 30 days and ` +
      `${formatNumber(stats.activeSubscriptions.value)} active subscriptions, read from ${providers} by hoomuch.`,
  };
}


export function PublicProductPage(props: PublicProductPageProps) {
  const { product, stats, owner } = props;
  const now = useNow();
  const stale = stats.syncedAt === null || now - stats.syncedAt > STALE_AFTER_MS;
  const providerNames = listNames(stats.providers.map((p) => getProviderMeta(p).name));
  const summary = publicProductSummary(product, stats);
  const history = usePublicHistory(product.slug);
  const [imageOpen, setImageOpen] = useState<CardKind | null>(null);
  const mounted = useMounted();
  // Back from signing up for a locked image (`?share=`): open the dialog on it.
  useEffect(() => {
    const url = new URL(window.location.href);
    const want = url.searchParams.get('share');
    if (want !== 'figure' && want !== 'chart' && want !== 'calendar') return;
    url.searchParams.delete('share');
    window.history.replaceState(null, '', url);
    setImageOpen(want);
  }, []);
  return (
    <Layout
      {...NO_CHROME}
      legal={props.legal}
      noindex={props.noindex}
      title={summary.title}
      description={summary.description}
      og={{ url: props.url, image: props.image, title: summary.title, markdown: props.markdown }}
      marketing
    >
      {/* The header to the content: 32 (design/system.md §3.3), then 24 between blocks. Full app
          column, so every edge lines up with the top bar's and the footer's. */}
      <header className="mb-8 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 items-start gap-4">
          <ProductTile name={product.name} src={product.logo} className="size-14 rounded-2xl font-heading text-title" />
          <div className="min-w-0">
            <h1 className="font-heading text-hero-sm wrap-break-word">{product.name}</h1>
            {product.tagline ? <p className="mt-1 text-lead text-pretty text-muted-foreground wrap-break-word">{product.tagline}</p> : null}
            {owner || product.country || product.founded ? <Byline owner={owner} country={product.country ?? null} founded={product.founded ?? null} /> : null}
            <ProductLinks product={product} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ShareButtons url={props.url} title={product.name} text={`${product.name} is at ${usd(stats.mrr.value)} MRR, verified by hoomuch`} copy />
          {/* Drawn in the browser, so it's there once the page is hydrated. */}
          {mounted ? (
            <CossButton type="button" variant="outline" className="rounded-full" onClick={() => setImageOpen('figure')}>
              <ImageDown />
              Share image
            </CossButton>
          ) : null}
        </div>
      </header>

      <div className="grid gap-6">
        {stale ? (
          <Alert tone="warning" title="Not updated recently">
            {stats.syncedAt === null ? (
              <>These figures haven’t been confirmed by a sync yet.</>
            ) : (
              <>
                The last sync that confirmed these figures was <RelativeTime ms={stats.syncedAt} />. They may be out of date.
              </>
            )}
          </Alert>
        ) : null}

        <StatGrid label="Revenue" note="Changes compare with 30 days ago. Revenue compares with the 30 days before. Amounts in US dollars.">
          <KpiStat
            inlineDelta
            className={STAT_CELL}
            label="Total revenue"
            value={usd(stats.revenueTotal)}
            hint={stats.revenueSince ? `Since ${formatDay(stats.revenueSince)}` : 'No history yet'}
          />
          <KpiStat
            inlineDelta
            className={STAT_CELL}
            label="MRR"
            value={usd(stats.mrr.value)}
            deltaPct={stats.mrr.deltaPct}
            deltaLabel="vs. 30 days ago"
            hint={`${usd(stats.mrr.value * 12)} ARR`}
          />
          <KpiStat
            inlineDelta
            className={STAT_CELL}
            label="Revenue, 30 days"
            value={usd(stats.revenue.value)}
            deltaPct={stats.revenue.deltaPct}
            deltaLabel="vs. the 30 days before"
          />
          <KpiStat
            inlineDelta
            className={STAT_CELL}
            label="Subscriptions"
            value={formatNumber(stats.activeSubscriptions.value)}
            deltaPct={stats.activeSubscriptions.deltaPct}
            deltaLabel="vs. 30 days ago"
          />
        </StatGrid>

        <section aria-label="Chart">
          <ChartCard slug={product.slug} stats={stats} initial={props.view ?? OPEN_VIEW} signupOpen={props.signupOpen} history={history} />
          <div className="mt-2">
            <VerifiedNote
              caveats={
                stats.estimated || stats.revenuePartial || stats.missingFx.length > 0 ? (
                  <ul className="grid gap-1.5 text-caption text-muted-foreground">
                    {stats.estimated ? <Note>Some figures are estimates: a key doesn’t have every read permission.</Note> : null}
                    {stats.revenuePartial ? <Note>Revenue leaves out a source that reports no daily history.</Note> : null}
                    {stats.missingFx.length > 0 ? (
                      <Note>Amounts in {listNames(stats.missingFx)} are left out: there’s no exchange rate for them.</Note>
                    ) : null}
                  </ul>
                ) : null
              }
              details={
                <>
                  <ul className="flex flex-wrap gap-x-6 gap-y-2 text-foreground" aria-label="Sources">
                    {stats.providers.map((p) => (
                      <li key={p} className="inline-flex items-center gap-2">
                        <ProviderLogo provider={p} size="md" />
                        {getProviderMeta(p).name}
                      </li>
                    ))}
                  </ul>
                  <p>
                    hoomuch reads these figures with read-only API keys, on a schedule, and the owner can’t edit them. Revenue is
                    net of refunds and before fees; other currencies are converted to US dollars. Total revenue counts what hoomuch
                    holds, from {stats.revenueSince ? formatDay(stats.revenueSince) : 'the day its history starts'}. The name,
                    description, website, founder details, founded date, country and the About section are the owner’s own words.
                  </p>
                </>
              }
            >
              Read from {providerNames} with read-only API keys. Last checked <RelativeTime ms={stats.syncedAt} fallback="not yet" />.
            </VerifiedNote>
          </div>
        </section>
      </div>

      {product.details ? (
        <ProductAbout
          name={product.name}
          details={product.details}
          founder={owner ? { name: owner.name, handle: owner.handle, avatar: owner.avatar } : null}
          perSubscription={stats.activeSubscriptions.value > 0 ? Math.round(stats.mrr.value / stats.activeSubscriptions.value) : null}
        />
      ) : null}

      {props.reportTo ? <ReportLink to={props.reportTo} url={props.url} /> : null}

      <ShareImageDialog
        kind={imageOpen}
        onClose={() => setImageOpen(null)}
        product={product}
        stats={stats}
        url={props.url}
        history={history}
        signupOpen={props.signupOpen}
      />

      <ShowYourOwn signupOpen={props.signupOpen} />
    </Layout>
  );
}

function Note(props: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning-foreground" />
      <span>{props.children}</span>
    </li>
  );
}

/**
 * Where to get it: the website, and for an app its App Store and Google Play listings, the owner's
 * links (rel="nofollow ugc"). The stores keep their own marks; nothing shows when there's none.
 */
function ProductLinks(props: { product: PublicProductPageProps['product'] }) {
  const p = props.product;
  if (!p.website && !p.appStoreUrl && !p.playStoreUrl) return null;
  const rel = 'nofollow ugc noopener noreferrer';
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {p.website ? (
        <LinkButton href={p.website} variant="secondary" small rel={rel} target="_blank">
          Visit {siteLabel(p.website)}
          <ArrowUpRight />
        </LinkButton>
      ) : null}
      {p.appStoreUrl ? (
        <LinkButton href={p.appStoreUrl} variant="secondary" small rel={rel} target="_blank">
          <ProviderLogo provider="appstore" />
          App Store
        </LinkButton>
      ) : null}
      {p.playStoreUrl ? (
        <LinkButton href={p.playStoreUrl} variant="secondary" small rel={rel} target="_blank">
          <ProviderLogo provider="googleplay" />
          Google Play
        </LinkButton>
      ) : null}
    </div>
  );
}

/**
 * Who makes it, like a post's author: their initials and name, linked to their profile; then where
 * it's made and since when, as the owner says.
 */
function Byline(props: { owner: PublicProductPageProps['owner']; country: string | null; founded: string | null }) {
  const o = props.owner;
  const country = countryName(props.country);
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-muted-foreground">
      {o ? (
        <>
          <a href={`/u/${o.handle}`} className="inline-flex min-w-0 items-center gap-2 font-medium text-foreground hover:underline">
            <Avatar name={o.name} src={o.avatar} className="size-6 text-[0.625rem]" />
            <span className="min-w-0 wrap-break-word">{o.name}</span>
          </a>
          {o.x ? (
            <a href={`https://x.com/${o.x}`} rel="nofollow ugc noopener noreferrer" target="_blank" className="inline-flex items-center gap-1.5 wrap-anywhere hover:text-foreground">
              <XMark className="size-3 shrink-0" />@{o.x}
            </a>
          ) : (
            <span>@{o.handle}</span>
          )}
        </>
      ) : null}
      {country && props.country ? (
        <>
          {o ? <Dot /> : null}
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true">{countryFlag(props.country)}</span>
            {country}
          </span>
        </>
      ) : null}
      {props.founded ? (
        <>
          {o || country ? <Dot /> : null}
          <span>Founded {formatFounded(props.founded)}</span>
        </>
      ) : null}
    </p>
  );
}

function Dot() {
  return (
    <span aria-hidden="true" className="text-faint">
      ·
    </span>
  );
}

interface ChartView {
  metric: PublicMetric;
  range: PublicRange;
}

const OPEN_VIEW: ChartView = { metric: 'revenue', range: '30d' };
const RANGE_LABEL: Record<PublicRange, string> = { '7d': '7D', '30d': '30D', '90d': '90D', '1y': '1Y', all: 'All' };
const RANGE_WORDS: Record<PublicRange, string> = {
  '7d': 'last 7 days',
  '30d': 'last 30 days',
  '90d': 'last 90 days',
  '1y': 'last 12 months',
  all: 'all time',
};
const RANGE_DAYS: Record<Exclude<PublicRange, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 364 };

/** The URL of a view: the open one is the page itself. */
function viewQuery(v: ChartView): string {
  return isOpenView(v.metric, v.range) ? '' : `?chart=${v.metric}&range=${v.range}`;
}

/** A locked view the visitor asked for, and why it's locked for them. */
type Prompt = { view: ChartView; reason: 'sign-in' | 'verify' };

type Load = 'ok' | 'sign-in' | 'verify' | 'error';

/** The history behind the locked views, for a signed-in visitor (routes/public.tsx). */
async function loadHistory(slug: string): Promise<{ result: Load; history?: PublicHistory }> {
  try {
    const res = await fetch(`/api/p/${slug}/history`, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (res.ok) return { result: 'ok', history: (await res.json()) as PublicHistory };
    if (res.status === 401) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { result: body.error === 'verify' ? 'verify' : 'sign-in' };
    }
    return { result: 'error' };
  } catch {
    return { result: 'error' };
  }
}

/** The history behind the locks, shared by the chart and the share images: opened once, for both. */
interface HistoryState {
  history: PublicHistory | null;
  /** Where opening it got to: not tried yet, under way, or how it ended. */
  status: 'idle' | 'loading' | Load;
  /** Opens it (once; later calls get the same answer). */
  load: () => Promise<Load>;
}

function usePublicHistory(slug: string): HistoryState {
  const [history, setHistory] = useState<PublicHistory | null>(null);
  const [status, setStatus] = useState<HistoryState['status']>('idle');
  const pending = useRef<Promise<Load> | null>(null);
  const load = useCallback(() => {
    // One request at a time; the history is kept once it comes, anything else is asked again next time.
    if (!pending.current) {
      setStatus('loading');
      pending.current = loadHistory(slug).then(({ result, history: h }) => {
        if (h) setHistory(h);
        setStatus(result);
        if (result !== 'ok') pending.current = null;
        return result;
      });
    }
    return pending.current;
  }, [slug]);
  // A browser with a session (lib/signed-in.ts) gets every view opened up front, so its locks go
  // before anyone reaches for them.
  useEffect(() => {
    if (hasSignedInHint(document.cookie)) void load();
  }, [load]);
  return { history, status, load };
}

/**
 * The chart, like a dashboard's: revenue or MRR over 7 days to all time. Anyone sees revenue over
 * the last 30 days; every other view needs a free account, and choosing one asks for it. That's the
 * point of the lock: a visitor curious about someone's numbers is who hoomuch is for.
 *
 * Before hydration every choice is a link (`?chart=&range=`), and a locked one renders the lock
 * with sign-up and log-in links. After it, choices switch in place; a locked one fetches the
 * history (a signed-in visitor gets it) or opens the sign-up prompt.
 */
function ChartCard(props: { slug: string; stats: PublicFigures; initial: ChartView; signupOpen: boolean; history: HistoryState }) {
  const { stats } = props;
  const { history } = props.history;
  const [view, setView] = useState<ChartView>(props.initial);
  const [failed, setFailed] = useState(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const open = isOpenView(view.metric, view.range);
  const busy = props.history.status === 'loading';

  const show = (to: ChartView) => {
    setView(to);
    const url = new URL(window.location.href);
    url.search = viewQuery(to);
    window.history.replaceState(null, '', url);
  };

  // Landed on a locked view (a shared link, or back from signing up): open it if the visitor can.
  // Only a locked landing says so if that fails (the page opens the history up front for a browser
  // with a session, usePublicHistory).
  const load = props.history.load;
  useEffect(() => {
    if (isOpenView(props.initial.metric, props.initial.range)) return;
    void load().then((result) => {
      if (result === 'error') setFailed(true);
    });
  }, [load, props.initial.metric, props.initial.range]);

  const choose = (to: ChartView) => async (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    if (isOpenView(to.metric, to.range) || history) return show(to);
    const result = await load();
    if (result === 'ok') show(to);
    else if (result === 'error') setFailed(true);
    else setPrompt({ view: to, reason: result === 'verify' ? 'verify' : 'sign-in' });
  };

  const locked = (v: ChartView) => !isOpenView(v.metric, v.range) && !history;
  const item = (v: ChartView, label: string, key: string, current: boolean) => ({
    key,
    href: `${viewQuery(v) || '?'}#chart`,
    current,
    onClick: choose(v),
    label: (
      <span className="inline-flex items-center gap-1">
        {label}
        {locked(v) ? <Lock aria-label="needs a free account" className="size-3 shrink-0 opacity-70" /> : null}
      </span>
    ),
  });

  const series = !open && history ? viewSeries(history, view) : null;
  const headline = open ? sum(stats.openSeries) : series ? (view.metric === 'mrr' ? last(series.mrr) : sum(series.revenue)) : null;
  const next = `/p/${props.slug}${viewQuery(prompt?.view ?? view)}`;

  return (
    <CossCard render={<div id="chart" />} className="min-w-0">
      <CardPanel className="p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div>
            <p className="text-body text-muted-foreground">
              {view.metric === 'mrr' ? 'MRR' : 'Revenue'}, {RANGE_WORDS[view.range]}
            </p>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2.5 text-title tabular-nums">
              {headline === null ? <span className="text-faint">—</span> : usd(headline)}
              {open ? (
                <span className="text-body">
                  <DeltaBadge pct={stats.revenue.deltaPct} label="vs. the 30 days before" />
                  <span className="sr-only"> vs. the 30 days before</span>
                </span>
              ) : null}
            </p>
          </div>
          <div className="flex flex-wrap gap-2" aria-busy={busy || undefined}>
            <SegmentedLinks
              label="Figure"
              items={[
                item({ metric: 'revenue', range: view.range }, 'Revenue', 'revenue', view.metric === 'revenue'),
                item({ metric: 'mrr', range: view.range }, 'MRR', 'mrr', view.metric === 'mrr'),
              ]}
            />
            <SegmentedLinks
              label="Period"
              items={PUBLIC_RANGES.map((r) => item({ metric: view.metric, range: r }, RANGE_LABEL[r], r, view.range === r))}
            />
          </div>
        </div>
        {open ? (
          <RevenueChart series={points(stats.openSeries)} connections={[]} currency="USD" title="Revenue per day, last 30 days" variant="line" />
        ) : series ? (
          view.metric === 'mrr' ? (
            <MrrChart
              series={series.mrr}
              windowDays={series.window}
              currency="USD"
              title={`MRR, ${RANGE_WORDS[view.range]}`}
              weekly={view.range === '1y' || view.range === 'all'}
            />
          ) : (
            <RevenueChart series={points(series.revenue)} connections={[]} currency="USD" title={`Revenue, ${RANGE_WORDS[view.range]}`} variant="line" />
          )
        ) : (
          <LockedChart next={next} signupOpen={props.signupOpen} failed={failed} />
        )}
      </CardPanel>
      <SignupPrompt prompt={prompt} next={next} signupOpen={props.signupOpen} onClose={() => setPrompt(null)} />
    </CossCard>
  );
}

const sum = (rows: readonly { total: number }[]) => rows.reduce((a, r) => a + r.total, 0);
const last = (rows: readonly { total: number }[]) => rows.at(-1)?.total ?? 0;
const points = (rows: readonly RevenuePoint[]) => rows.map((r) => ({ ...r, byConnection: {} }));

/** A view's series out of the history: revenue points, and MRR with the days its axis spans. */
function viewSeries(h: PublicHistory, v: ChartView): { revenue: RevenuePoint[]; mrr: MrrDay[]; window: string[] } {
  if (v.range === 'all') {
    // MRR's axis starts at its first point, a month's end: from earlier, the chart would say its
    // history starts later than the axis.
    return { revenue: h.revenueMonthly, mrr: h.mrrMonthly, window: dayRange(h.mrrMonthly[0]?.day ?? h.today, h.today) };
  }
  const days = RANGE_DAYS[v.range];
  const from = addDays(h.today, -(days - 1));
  const revenue = v.range === '1y' ? h.revenueWeekly : h.revenueDaily.slice(-days);
  return { revenue, mrr: h.mrrDaily.filter((d) => d.day >= from), window: dayRange(from, h.today) };
}

/** In place of a locked chart: what a free account opens, and the way to one. */
function LockedChart(props: { next: string; signupOpen: boolean; failed: boolean }) {
  const q = `?next=${encodeURIComponent(props.next)}`;
  return (
    // As tall as a chart and its "Show data" line, so opening one doesn't move the page.
    <div className="flex min-h-60 flex-col items-center justify-center gap-4 rounded-xl border border-dashed px-6 py-12 text-center">
      <Lock className="size-5 text-muted-foreground" />
      {props.failed ? (
        <p className="max-w-sm text-body text-muted-foreground">Couldn’t load this chart. Try again in a moment.</p>
      ) : (
        <>
          <p className="max-w-sm text-body text-pretty text-muted-foreground">
            MRR, and revenue over 7 days, 90 days, a year or all time, open with a free hoomuch account.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {props.signupOpen ? <LinkButton href={`/signup${q}`}>Create a free account</LinkButton> : null}
            <LinkButton href={`/login${q}`} variant="secondary">
              Log in
            </LinkButton>
          </div>
        </>
      )}
    </div>
  );
}

/** True once hydrated: for what only works in a browser. */
function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * The share images, in a native modal <dialog> (focus moves in, Escape closes it). Anyone makes the
 * images from figures a visitor already sees; the year's chart and the calendar use the history
 * behind the lock, so picking one opens it for a signed-in visitor and says how to otherwise.
 */
function ShareImageDialog(props: {
  kind: CardKind | null;
  onClose: () => void;
  product: PublicProductPageProps['product'];
  stats: PublicFigures;
  url: string;
  history: HistoryState;
  signupOpen: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [wanted, setWanted] = useState<CardKind>('calendar');
  const { product, stats } = props;
  const h = props.history.history;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.kind && !d.open) d.showModal();
    if (!props.kind && d.open) d.close();
  }, [props.kind]);
  const data = useMemo<CardData>(
    () => ({
      slug: product.slug,
      name: product.name,
      logo: product.logo,
      host: new URL(props.url).host,
      mrr: stats.mrr.value,
      revenue: stats.revenue.value,
      revenueTotal: stats.revenueTotal,
      today: h?.today ?? stats.openSeries.at(-1)?.day ?? '',
      daily: h?.revenueDaily ?? stats.openSeries,
      weekly: h?.revenueWeekly ?? null,
    }),
    [product, stats, props.url, h],
  );
  const next = `/p/${product.slug}?share=${wanted}`;
  const q = `?next=${encodeURIComponent(next)}`;
  const status = props.history.status;
  return (
    <dialog
      ref={ref}
      onClose={props.onClose}
      aria-labelledby="share-image-title"
      className="m-auto w-[min(48rem,calc(100%-2rem))] rounded-2xl border bg-popover p-5 text-popover-foreground shadow-lg backdrop:bg-black/60 sm:p-6"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 id="share-image-title" className="font-heading text-title">
            Share as an image
          </h2>
          <p className="mt-1 text-body text-muted-foreground">Post it with the link, so people can check the figures.</p>
        </div>
        <button type="button" onClick={() => ref.current?.close()} className="-m-2 rounded-md p-2 text-muted-foreground hover:text-foreground" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>
      <div className="mb-5">
        <CopyField id="share-image-link" label={`Link to ${product.name}`} value={props.url} />
      </div>
      {props.kind ? (
        <ShareCards
          key={props.kind}
          data={data}
          initialKind={props.kind}
          locked={(spec) => !h && needsHistory(spec)}
          onLocked={(spec) => {
            setWanted(spec.kind);
            void props.history.load();
          }}
          lockedPanel={
            <div className="flex flex-col items-center gap-4 px-4 py-10 text-center">
              <Lock className="size-5 text-muted-foreground" />
              {status === 'loading' ? (
                <p className="text-body text-muted-foreground">Opening…</p>
              ) : status === 'error' ? (
                <p className="max-w-sm text-body text-muted-foreground">Couldn’t open it. Try again in a moment.</p>
              ) : status === 'verify' ? (
                <>
                  <p className="max-w-sm text-body text-pretty text-muted-foreground">Confirm your email first: then the year’s chart and the calendar open.</p>
                  <LinkButton href="/verify-email">Confirm my email</LinkButton>
                </>
              ) : (
                <>
                  <p className="max-w-sm text-body text-pretty text-muted-foreground">
                    The year’s chart and the revenue calendar open with a free hoomuch account.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {props.signupOpen ? <LinkButton href={`/signup${q}`}>Create a free account</LinkButton> : null}
                    <LinkButton href={`/login${q}`} variant="secondary">
                      Log in
                    </LinkButton>
                  </div>
                </>
              )}
            </div>
          }
        />
      ) : null}
    </dialog>
  );
}

/**
 * Asked for when a visitor without an account picks a locked view: a native modal <dialog> (focus
 * moves in, Escape closes it), opened after hydration only.
 */
function SignupPrompt(props: { prompt: Prompt | null; next: string; signupOpen: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.prompt && !d.open) d.showModal();
    if (!props.prompt && d.open) d.close();
  }, [props.prompt]);
  const q = `?next=${encodeURIComponent(props.next)}`;
  const verify = props.prompt?.reason === 'verify';
  return (
    <dialog
      ref={ref}
      onClose={props.onClose}
      aria-labelledby="signup-prompt-title"
      className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-2xl border bg-popover p-6 text-popover-foreground shadow-lg backdrop:bg-black/60"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 id="signup-prompt-title" className="font-heading text-title">
          {verify ? 'Confirm your email first' : 'See the full history'}
        </h2>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          className="-m-2 rounded-md p-2 text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X className="size-4" />
        </button>
      </div>
      {verify ? (
        <>
          <p className="mt-2 text-body text-muted-foreground">
            We sent you a link when you signed up. Once your address is confirmed, every chart opens.
          </p>
          <div className="mt-5">
            <LinkButton href="/verify-email" block>
              Confirm my email
            </LinkButton>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-body text-muted-foreground">A free hoomuch account opens every chart on every public page.</p>
          <ul className="mt-4 grid gap-2 text-body">
            <Perk>MRR, and revenue over 7 days, 90 days, a year and all time</Perk>
            <Perk>Your own revenue from Stripe, Paddle, RevenueCat, the app stores and more, on one dashboard</Perk>
            <Perk>A verified page and badge like this one for your product</Perk>
          </ul>
          <div className="mt-6 grid gap-2">
            {props.signupOpen ? (
              <LinkButton href={`/signup${q}`} block>
                Create a free account
              </LinkButton>
            ) : null}
            <LinkButton href={`/login${q}`} variant="secondary" block>
              Log in
            </LinkButton>
          </div>
        </>
      )}
    </dialog>
  );
}

function Perk(props: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <BadgeCheck className="mt-0.5 size-4 shrink-0 text-success-foreground" />
      <span>{props.children}</span>
    </li>
  );
}

/**
 * A quiet way to tell the people running the site about a page that breaks the rules: an email to
 * the operator's address, with the page in the subject. A plain link, so it works everywhere.
 */
export function ReportLink(props: { to: string; url: string }) {
  const href = `mailto:${props.to}?subject=${encodeURIComponent(`Report: ${props.url}`)}&body=${encodeURIComponent('What’s wrong with this page:\n\n')}`;
  return (
    <p className="mt-6 flex items-center gap-1.5 text-caption text-muted-foreground">
      <Flag aria-hidden="true" className="size-3.5 shrink-0" />
      <span>
        Spam, a scam or someone else’s details on this page? <TextLink href={href}>Report it</TextLink>
      </span>
    </p>
  );
}

/** The one action on a public page: a visitor who liked it can have one too. */
export function ShowYourOwn(props: { signupOpen: boolean }) {
  // Someone who already has an account (lib/signed-in.ts) is asked to publish, not to sign up.
  const signedIn = useSignedIn();
  if (signedIn) {
    return (
      <section className="mt-12 text-center sm:mt-16">
        <h2 className="font-heading text-section-sm sm:text-section">Show your own MRR</h2>
        <p className="mx-auto mt-2 max-w-[32rem] text-pretty text-muted-foreground">
          Publish a page like this one for your product, with a badge for your site or README. Nothing is public until you do.
        </p>
        <div className="mt-5">
          <LinkButton href="/share" large>
            Publish yours
          </LinkButton>
        </div>
      </section>
    );
  }
  return (
    // 48 above on a phone, 64 from `sm`: a section of its own, like the landing page's.
    <section className="mt-12 text-center sm:mt-16">
      <h2 className="font-heading text-section-sm sm:text-section">Show your own MRR</h2>
      <p className="mx-auto mt-2 max-w-[32rem] text-pretty text-muted-foreground">
        hoomuch puts Stripe, Paddle, RevenueCat, the app stores and more on one dashboard, and you can publish a page like this
        one. It only ever reads.
      </p>
      <div className="mt-5">
        <LinkButton href={props.signupOpen ? '/signup' : '/'} large>
          {props.signupOpen ? 'Start free' : 'About hoomuch'}
        </LinkButton>
      </div>
      {/* With sign-up closed the button already goes there. */}
      {props.signupOpen ? (
        <p className="mt-3 text-caption text-muted-foreground">
          <TextLink href="/">What is hoomuch?</TextLink>
        </p>
      ) : null}
    </section>
  );
}
