/**
 * Explore (GET /explore, SPEC F-23): the products whose owners list them, and their founders.
 * Owner: Experience (pages).
 *
 * The other half of the loop public pages start: a visitor who came for one product finds the
 * rest, and wants a page of their own. Rendered without the visitor's session like every public
 * page. Every choice (tab, order, provider) is a link, so it works before hydration and each view
 * has its own URL.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Plus, Search } from 'lucide-react';
import { Card as CossCard } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ExploreData, ExploreFounder, ExploreItem } from '../../data/explore';
import { formatMoney } from '../../lib/money';
import { EXPLORE_GROWTH_MIN_MRR, EXPLORE_MIN_HISTORY_DAYS, EXPLORE_QUERY_MAX, type ExploreSort } from '../../lib/public-pages';
import { getProviderMeta } from '../../providers/registry';
import type { ProviderId } from '../../providers/types';
import { Avatar, ProductTile } from '../components/avatar';
import { DeltaBadge } from '../components/kpi';
import { ProviderLogo } from '../components/provider-logos';
import { LinkButton, ScrollTable, SegmentedLinks, TableRowHeader } from '../components/ui';
import { Layout } from '../layout';
import { useSignedIn } from '../use-signed-in';
import { ShowYourOwn } from './public-product';

export interface ExplorePageProps {
  data: ExploreData;
  /** This page's absolute URL and the link preview image. */
  url: string;
  image: string;
  signupOpen: boolean;
  /** The instance publishes a privacy policy and terms: the footer links them. */
  legal?: boolean;
}

const usd = (minor: number) => formatMoney(minor, 'USD', { whole: true });
const SORT_LABEL: Record<ExploreSort, string> = { mrr: 'MRR', growth: 'Growing', new: 'New' };
const SORT_CAPTION: Record<ExploreSort, string> = {
  mrr: 'highest MRR first',
  growth: 'fastest MRR growth over 30 days first',
  new: 'most recently published first',
};

/** A view's URL: only what differs from the default (products, by MRR, every provider, no search). */
function href(v: { tab?: 'founders'; sort?: ExploreSort; provider?: ProviderId | null; q?: string | null }): string {
  const q = new URLSearchParams();
  if (v.q) q.set('q', v.q);
  if (v.tab) q.set('tab', v.tab);
  if (v.sort && v.sort !== 'mrr') q.set('sort', v.sort);
  if (v.provider) q.set('provider', v.provider);
  const s = q.toString();
  return s ? `/explore?${s}` : '/explore';
}

/** How long typing pauses before the search runs. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Search as you type (after hydration): the query waits SEARCH_DEBOUNCE_MS of quiet, then the
 * view's data comes from /explore.json and replaces the list in place; the URL follows with
 * replaceState, so typing doesn't fill the history. A newer search aborts an older one, so a slow
 * answer can't overwrite a fresh one. Before hydration the form submits on Enter, as a plain GET.
 */
function useLiveSearch(initial: ExploreData) {
  const [data, setData] = useState(initial);
  const [query, setQuery] = useState(initial.q ?? '');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const shown = useRef(initial.q ?? '');

  const run = async (raw: string) => {
    const q = raw.trim();
    if (q === shown.current) return;
    inFlight.current?.abort();
    const ac = new AbortController();
    inFlight.current = ac;
    setBusy(true);
    const view = { tab: data.tab === 'founders' ? ('founders' as const) : undefined, sort: data.sort, provider: data.provider, q };
    try {
      const res = await fetch(href(view).replace('/explore', '/explore.json'), { signal: ac.signal, headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const next = (await res.json()) as ExploreData;
      shown.current = q;
      setData(next);
      window.history.replaceState(null, '', href(view));
    } catch {
      // Aborted by a newer search, or offline: keep what's on screen.
    } finally {
      if (inFlight.current === ac) setBusy(false);
    }
  };

  useEffect(() => {
    if (query.trim() === shown.current) return;
    const timer = setTimeout(() => void run(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // On the query only: `run` reads the view as it is when the pause ends.
  }, [query]);

  /** Enter searches at once instead of waiting out the pause. */
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void run(query);
  };

  return { data, query, setQuery, busy, submit };
}

export function ExplorePage(props: ExplorePageProps) {
  const search = useLiveSearch(props.data);
  const { data } = search;
  const founders = data.tab === 'founders';
  const title = founders ? 'Founders with verified revenue' : 'Products with verified revenue';
  // A visitor's own product: sign up (or log in), then Share, where products are added; straight
  // to Share for a browser that has a session already (lib/signed-in.ts).
  const signedIn = useSignedIn();
  const addHref = signedIn ? '/share' : props.signupOpen ? '/signup?next=%2Fshare' : '/login?next=%2Fshare';
  const q = data.q;
  return (
    <Layout
      user={null}
      flash={null}
      explore
      legal={props.legal}
      nav="explore"
      title={title}
      description="MRR and revenue of indie products, read from Stripe, Paddle, RevenueCat, the app stores and more by hoomuch. Nothing here is typed in."
      og={{ url: props.url, image: props.image, title }}
      marketing
    >
      <header className="mb-8">
        <h1 className="font-heading text-hero-sm">Explore</h1>
        <p className="mt-2 max-w-[34rem] text-lead text-pretty text-muted-foreground">
          Products and their founders, with revenue hoomuch reads from their payment providers. Nothing here is typed in.
        </p>
      </header>

      <div className="grid gap-6">
        {/* Search and the way in: what a visitor came to find, or their own product to add. */}
        <div className="flex flex-wrap items-center gap-3">
          <form method="get" action="/explore" role="search" onSubmit={search.submit} className="min-w-0 flex-1 basis-64">
            {founders ? <input type="hidden" name="tab" value="founders" /> : null}
            {!founders && data.sort !== 'mrr' ? <input type="hidden" name="sort" value={data.sort} /> : null}
            {!founders && data.provider ? <input type="hidden" name="provider" value={data.provider} /> : null}
            <label htmlFor="explore-q" className="sr-only">
              {founders ? 'Search founders' : 'Search products and founders'}
            </label>
            <span className="relative block">
              {search.busy ? (
                <Spinner aria-hidden="true" role={undefined} aria-label={undefined} className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
              ) : (
                <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
              )}
              <Input
                nativeInput
                id="explore-q"
                name="q"
                type="search"
                value={search.query}
                onChange={(e) => search.setQuery(e.currentTarget.value)}
                autoComplete="off"
                maxLength={EXPLORE_QUERY_MAX}
                placeholder={founders ? 'Search founders' : 'Search products or founders'}
                enterKeyHint="search"
                className="[&_[data-slot=input]]:ps-9"
              />
            </span>
          </form>
          <LinkButton href={addHref}>
            <Plus />
            Add your product
          </LinkButton>
        </div>

        {/* The choices: what to show (tabs, like a profile's), its order beside them, then the
            providers (16 between). Two kinds of choice, so two looks. */}
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b">
            <nav aria-label="Show" className="-mb-px flex">
              <Tab href={href({ sort: data.sort, provider: data.provider, q })} current={!founders}>
                Products
              </Tab>
              <Tab href={href({ tab: 'founders', q })} current={founders}>
                Founders
              </Tab>
            </nav>
            {founders ? null : (
              <SegmentedLinks
                label="Order"
                className="mb-2"
                items={(['mrr', 'growth', 'new'] as const).map((s) => ({
                  key: s,
                  href: href({ sort: s, provider: data.provider, q }),
                  label: SORT_LABEL[s],
                  current: data.sort === s,
                }))}
              />
            )}
          </div>

          {founders || data.providers.length < 2 ? null : (
            <nav aria-label="Provider" className="flex flex-wrap gap-2">
              <ProviderChip href={href({ sort: data.sort, q })} current={data.provider === null}>
                All
              </ProviderChip>
              {data.providers.map((p) => (
                <ProviderChip key={p.id} href={href({ sort: data.sort, provider: p.id, q })} current={data.provider === p.id}>
                  <ProviderLogo provider={p.id} />
                  {getProviderMeta(p.id).name}
                  <span className="text-muted-foreground tabular-nums">{p.products}</span>
                </ProviderChip>
              ))}
            </nav>
          )}
        </div>

        {/* Said once a search has run; the list itself is what sighted visitors read. */}
        <p className="sr-only" aria-live="polite">
          {q ? `${founders ? data.founders.length : data.items.length} ${founders ? 'founders' : 'products'} match “${q}”` : ''}
        </p>

        <div aria-busy={search.busy || undefined} className={search.busy ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          {founders && data.founders.length > 0 ? (
            <FounderTable founders={data.founders} />
          ) : !founders && data.items.length > 0 ? (
            <ProductTable items={data.items} sort={data.sort} />
          ) : (
            // Nothing to list: say why, and offer the one thing that fills it, their own product.
            <CossCard className="items-center px-6 py-12 text-center">
              <p className="font-semibold">{q ? `Nothing matches “${q}”` : 'Nothing here yet'}</p>
              <p className="mt-2 max-w-sm text-body text-pretty text-muted-foreground">
                {q
                  ? 'Is it yours? Add it, and its verified page and badge are free.'
                  : data.provider
                    ? `No product on Explore sells through ${getProviderMeta(data.provider).name} yet. Is yours one?`
                    : 'Products show up here once their founders publish them. Yours can be the first.'}
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <LinkButton href={addHref}>
                  <Plus />
                  Add your product
                </LinkButton>
                {q ? (
                  <LinkButton href={href({ tab: founders ? 'founders' : undefined, sort: data.sort, provider: data.provider })} variant="secondary">
                    Clear search
                  </LinkButton>
                ) : null}
              </div>
            </CossCard>
          )}
        </div>

        <p className="text-caption text-muted-foreground">
          On Explore: products whose founders list them, with at least {EXPLORE_MIN_HISTORY_DAYS} days of revenue history and
          a sync in the last 72 hours. Growing ranks products at {usd(EXPLORE_GROWTH_MIN_MRR)} MRR or more. Amounts in US dollars.
        </p>
      </div>

      <ShowYourOwn signupOpen={props.signupOpen} />
    </Layout>
  );
}

/** A tab: the main nav's look (text, a brand underline on the current one), so it reads as "where", not "how". */
function Tab(props: { href: string; current: boolean; children: ReactNode }) {
  return (
    <a
      href={props.href}
      aria-current={props.current ? 'page' : undefined}
      className="focus-inset relative inline-flex h-11 items-center rounded-md px-3 text-body font-medium whitespace-nowrap text-muted-foreground transition-colors duration-150 first:-ml-3 hover:text-foreground after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-transparent aria-[current=page]:text-foreground aria-[current=page]:after:bg-brand"
    >
      {props.children}
    </a>
  );
}

function ProviderChip(props: { href: string; current: boolean; children: ReactNode }) {
  return (
    <a
      href={props.href}
      aria-current={props.current ? 'page' : undefined}
      className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-body text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:border-foreground/40 aria-[current=page]:text-foreground"
    >
      {props.children}
    </a>
  );
}

function ProductTable(props: { items: ExploreItem[]; sort: ExploreSort }) {
  return (
    <ScrollTable labelledBy="explore-caption">
      <caption id="explore-caption" className="sr-only">
        Products on Explore, {SORT_CAPTION[props.sort]}
      </caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className="w-10 text-right">
            #
          </TableHead>
          <TableHead scope="col">Product</TableHead>
          {/* On a phone the row keeps what ranks it (MRR and its change); the founder moves under the name. */}
          <TableHead scope="col" className="hidden sm:table-cell">
            Founder
          </TableHead>
          <TableHead scope="col" className="text-right">
            MRR
          </TableHead>
          <TableHead scope="col" className="text-right">
            30 days
          </TableHead>
          <TableHead scope="col" className="hidden text-right sm:table-cell">
            Revenue, 30d
          </TableHead>
          <TableHead scope="col" className="hidden sm:table-cell">
            Sources
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.items.map((it, i) => (
          <TableRow key={it.slug}>
            <TableCell className="text-right text-muted-foreground tabular-nums">{i + 1}</TableCell>
            <TableRowHeader className="sm:min-w-56">
              <a href={`/p/${it.slug}`} className="flex min-w-0 items-center gap-3 hover:underline">
                <ProductTile name={it.name} src={it.logo} className="size-8 rounded-lg text-caption" />
                <span className="min-w-0">
                  <span className="block font-semibold wrap-break-word whitespace-normal">{it.name}</span>
                  {it.tagline ? <span className="hidden max-w-80 truncate text-muted-foreground sm:block">{it.tagline}</span> : null}
                  <span className="block text-muted-foreground sm:hidden">by {it.founder.name}</span>
                </span>
              </a>
            </TableRowHeader>
            <TableCell className="hidden sm:table-cell">
              <a href={`/u/${it.founder.handle}`} className="inline-flex items-center gap-2 whitespace-nowrap hover:underline">
                <Avatar name={it.founder.name} src={it.founder.avatar} className="size-6 text-[0.625rem]" />
                {it.founder.name}
              </a>
            </TableCell>
            <TableCell className="text-right font-semibold tabular-nums">{usd(it.mrr)}</TableCell>
            <TableCell className="text-right">
              <DeltaBadge pct={it.growthPct} label="MRR vs. 30 days ago" />
            </TableCell>
            <TableCell className="hidden text-right tabular-nums sm:table-cell">{usd(it.revenue30)}</TableCell>
            <TableCell className="hidden sm:table-cell">
              <span className="flex gap-1.5">
                {it.providers.map((p) => (
                  <span key={p} title={getProviderMeta(p).name}>
                    <ProviderLogo provider={p} />
                    <span className="sr-only">{getProviderMeta(p).name}</span>
                  </span>
                ))}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </ScrollTable>
  );
}

function FounderTable(props: { founders: ExploreFounder[] }) {
  return (
    <ScrollTable labelledBy="founders-caption">
      <caption id="founders-caption" className="sr-only">
        Founders on Explore, highest MRR across their products first
      </caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className="w-10 text-right">
            #
          </TableHead>
          <TableHead scope="col">Founder</TableHead>
          <TableHead scope="col" className="text-right">
            Products
          </TableHead>
          <TableHead scope="col" className="text-right">
            MRR
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.founders.map((f, i) => (
          <TableRow key={f.handle}>
            <TableCell className="text-right text-muted-foreground tabular-nums">{i + 1}</TableCell>
            <TableRowHeader>
              <a href={`/u/${f.handle}`} className="flex min-w-0 items-center gap-3 hover:underline">
                <Avatar name={f.name} src={f.avatar} className="size-8 text-caption" />
                <span className="min-w-0">
                  <span className="block font-semibold wrap-break-word">{f.name}</span>
                  <span className="block text-muted-foreground">@{f.handle}</span>
                </span>
              </a>
            </TableRowHeader>
            <TableCell className="text-right tabular-nums">{f.products}</TableCell>
            <TableCell className="text-right font-semibold tabular-nums">{usd(f.mrr)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </ScrollTable>
  );
}
