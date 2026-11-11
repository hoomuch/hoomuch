/**
 * Share (GET /share, /share/profile, /share/new, /share/products/:id[/edit]; SPEC F-21/F-22): the
 * owner's public pages. Owner: Experience (pages).
 *
 * Laid out like a profile on a social network: the founder on top (photo or initials, name, @handle, bio,
 * links, what's public) with Edit profile beside the name and the profile's link with one-tap posts
 * under it; the products below as a list. A product's view leads with sharing it (link, posts,
 * badge) or, while it's a draft, with publishing it; its details, unpublish and delete wait behind
 * Edit, and what the page says about it (founded, country, the About section) behind its own form.
 * Every action is a plain POST form. Nothing is public until the owner ticks the confirmation and
 * publishes.
 */

import { ArrowUpRight, ChevronRight, ImagePlus, Link2, Pencil, Plus, UserRound } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button as CossButton } from '@/components/ui/button';
import { Card as CossCard } from '@/components/ui/card';
import type { RevenuePoint } from '../../data/types';
import type { ProviderId } from '../../providers/types';
import { COUNTRIES, countryName } from '../../lib/countries';
import { formatMoney, SUPPORTED_CURRENCIES, toMajor } from '../../lib/money';
import {
  AUDIENCE_MAX,
  CHANNELS,
  CHANNELS_MAX,
  DESCRIPTION_MAX,
  FOUNDED_MIN_YEAR,
  MESSAGE_MAX,
  FOUNDED_MONTHS,
  formatFounded,
  FUNDING,
  MARKETS,
  MARKETS_MAX,
  MODELS,
  MORE_MAX,
  PLAN_NAME_MAX,
  PLAN_NOTE_MAX,
  PLAN_PERIODS,
  PLANS_MAX,
  PRICING_MAX,
  PROBLEM_MAX,
  TECH,
  TECH_GROUPS,
  TECH_MAX,
  type ProductDetails,
} from '../../lib/product-details';
import { cn } from '../../lib/utils';
import { BIO_MAX, DISPLAY_NAME_MAX, HANDLE_MAX, NAME_MAX, SLUG_MAX, STORE_LINK_MAX, TAGLINE_MAX, WEBSITE_MAX } from '../../lib/public-pages';
import { Avatar, ProductTile } from '../components/avatar';
import { CopyField } from '../components/copy-field';
import { ImageField, ImageUploadCard } from '../components/image-upload';
import { TagIcon } from '../components/product-about';
import { EmptyState } from '../components/empty-state';
import { XMark } from '../components/icons';
import { ProviderLogo } from '../components/provider-logos';
import { RelativeTime } from '../components/relative-time';
import type { CardData } from '../components/share-cards/layout';
import { ShareCards } from '../components/share-cards/share-cards';
import { ShareSheet } from '../components/share-sheet';
import {
  Alert,
  Button,
  Card,
  CheckboxOption,
  ChipCheckbox,
  ConfirmCheckbox,
  Field,
  FormError,
  LinkButton,
  PageHeader,
  SelectField,
  TextareaField,
  TextLink,
} from '../components/ui';
import { Layout, type PageChrome } from '../layout';
import { useNow } from '../page-root';

interface ShareProduct {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  website: string | null;
  /** The App Store and Google Play listings, canonical; null for none. */
  appStoreUrl: string | null;
  playStoreUrl: string | null;
  connectionIds: string[];
  published: boolean;
  /** The operator took its page down (migration 0017): it can't be published again. */
  removed: boolean;
  /** MRR in USD from the stored figures; null before there are any. */
  mrr: number | null;
  /** When the stored figures were worked out. */
  statsAt: number | null;
  /** The owner lists it on Explore (SPEC F-23). */
  listed: boolean;
  /** Listed and published but not on Explore, and why; null otherwise. */
  explore: 'hidden' | 'history' | 'stale' | 'no-mrr' | null;
  /** When it was last published; null while it's a draft. */
  publishedAt: number | null;
  /** The logo's URL (lib/media.ts), and where it came from; null for initials. */
  logo: string | null;
  logoSource: 'site' | 'upload' | null;
  /** What its page says about it, the owner's words: 'YYYY' or 'YYYY-MM', an ISO country code, the About section. */
  founded: string | null;
  country: string | null;
  details: ProductDetails;
}

/** Why a listed product isn't on Explore yet, in the owner's terms. */
const EXPLORE_WHY: Record<NonNullable<ShareProduct['explore']>, string> = {
  hidden: 'Taken off Explore by hoomuch. Its page and badge stay public.',
  history: 'Listed on Explore: it shows there once it has 30 days of revenue history.',
  stale: 'Listed on Explore: it shows there again after its next sync.',
  'no-mrr': 'Listed on Explore: it shows there once it has MRR.',
};

interface ShareConnection {
  id: string;
  name: string;
  provider: ProviderId;
  /** The product it's in, if any: a connection counts in one product only. */
  productId: string | null;
}

export interface ShareFormValues {
  name: string;
  slug: string;
  tagline: string;
  website: string;
  appStore: string;
  playStore: string;
  connections: string[];
}

export interface ShareFormErrors {
  /** The logo chosen on the new-product form (not kept after an error: a browser can't refill a file field). */
  logo?: string;
  name?: string;
  slug?: string;
  website?: string;
  appStore?: string;
  playStore?: string;
  connections?: string;
}

/** The details form as typed (lib/product-details.ts checks it). */
export interface DetailsFormValues {
  foundedYear: string;
  foundedMonth: string;
  country: string;
  teamSize: string;
  funding: string;
  message: string;
  description: string;
  problem: string;
  audience: string;
  model: string;
  /** The plan rows that had anything in them, as typed. */
  plans: Array<{ name: string; price: string; currency: string; period: string; note: string }>;
  pricing: string;
  markets: string[];
  tech: string[];
  channels: string[];
  more: string;
}

export interface DetailsFormErrors {
  /** A link, address or number in the founder's text (lib/product-details.ts contactIn). */
  message?: string;
  description?: string;
  problem?: string;
  audience?: string;
  pricing?: string;
  more?: string;
  founded?: string;
  country?: string;
  teamSize?: string;
  /** By the row's place in `DetailsFormValues.plans`. */
  plans?: Record<number, string>;
  markets?: string;
  tech?: string;
  channels?: string;
}

export interface ProfileFormValues {
  handle: string;
  displayName: string;
  bio: string;
  website: string;
  xHandle: string;
}

export interface ProfileFormErrors {
  handle?: string;
  displayName?: string;
  website?: string;
  xHandle?: string;
}

/**
 * Which of the Share views: the overview (/share), the profile form (/share/profile), a new product
 * (/share/new), a product's own view (/share/products/:id), its form (/share/products/:id/edit) and
 * what its page says about it (/share/products/:id/details).
 */
export type ShareView =
  | { kind: 'overview' }
  | { kind: 'profile' }
  | { kind: 'new' }
  | { kind: 'product'; id: string }
  | { kind: 'edit'; id: string }
  | { kind: 'details'; id: string };

type Profile = {
  handle: string;
  displayName: string;
  bio: string | null;
  website: string | null;
  xHandle: string | null;
  /** The photo's URL (lib/media.ts); null for initials. */
  avatar: string | null;
};

export interface SharePageProps {
  chrome: PageChrome;
  view?: ShareView;
  /** This instance's origin, for the page links and embed code. */
  origin: string;
  products: ShareProduct[];
  /** Connections that can be published: not demo data, not a test-mode key. */
  connections: ShareConnection[];
  /** Connections that can't be (demo data, test-mode keys), by name. */
  excluded: string[];
  maxProducts: number;
  /** Photos and logos can be added (the instance has the MEDIA binding). */
  media?: boolean;
  /** The operator's address (LEGAL_EMAIL), for an owner whose page was taken down. */
  operatorEmail?: string;
  /** A failed create or edit, re-rendered with 422. `productId` null is the new-product form. */
  form?: { productId: string | null; values: ShareFormValues; error?: string | null; fieldErrors?: ShareFormErrors };
  /** The founder profile (SPEC F-22), null before they save one; publishing a product needs it. */
  profile?: Profile | null;
  /** A failed profile save, re-rendered with 422. */
  profileForm?: { values: ProfileFormValues; error?: string | null; fieldErrors?: ProfileFormErrors };
  /** A failed details save, re-rendered with 422 (on the details view's product). */
  detailsForm?: { values: DetailsFormValues; error?: string | null; fieldErrors?: DetailsFormErrors };
  /**
   * What the share images of the product in view are made from (its stored figures and their
   * history, the owner's own): sent with a published product's own view only.
   */
  cards?: { productId: string; today: string; daily: RevenuePoint[]; weekly: RevenuePoint[]; revenue: number; revenueTotal: number };
}

export function SharePage(props: SharePageProps) {
  const view = props.view ?? { kind: 'overview' };
  const product = view.kind === 'product' || view.kind === 'edit' || view.kind === 'details' ? props.products.find((p) => p.id === view.id) : undefined;
  const error = Boolean(props.form || props.profileForm || props.detailsForm);
  const title =
    view.kind === 'profile'
      ? props.profile
        ? 'Edit profile'
        : 'Set up your profile'
      : view.kind === 'new'
        ? 'New product'
        : product
          ? view.kind === 'edit'
            ? `Edit ${product.name}`
            : view.kind === 'details'
              ? `About ${product.name}`
              : product.name
          : 'Share';
  return (
    <Layout {...props.chrome} title={`${error ? 'Error: ' : ''}${title}`} nav="share" noindex backdrop>
      {/* One column, header included, so a header's actions line up with the cards' right edge. */}
      <div className="max-w-2xl">
        {view.kind === 'profile' ? (
          <ProfileView {...props} />
        ) : view.kind === 'new' ? (
          <NewProductView {...props} />
        ) : product && view.kind === 'edit' ? (
          <EditProductView {...props} product={product} />
        ) : product && view.kind === 'details' ? (
          <DetailsView {...props} product={product} />
        ) : product ? (
          <ProductView {...props} product={product} />
        ) : (
          <Overview {...props} />
        )}
      </div>
    </Layout>
  );
}

const usd = (minor: number) => formatMoney(minor, 'USD', { whole: true });
const strip = (url: string) => url.replace(/^https?:\/\//, '');
const siteLabel = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

/** Room for another product: under the cap, with a connection no product has yet. */
function canAddProduct(props: SharePageProps): boolean {
  return props.products.length < props.maxProducts && props.connections.some((c) => c.productId === null);
}

/** What a post about a product says before its link. */
function productPost(p: ShareProduct): string {
  return p.mrr !== null ? `${p.name} is at ${usd(p.mrr)} MRR, verified by hoomuch` : `${p.name}: revenue verified by hoomuch`;
}

// ---------- the overview: the founder, then the products ----------

function Overview(props: SharePageProps) {
  return (
    <>
      <PageHeader title="Share" description="Your founder profile and a public page for each product. Nothing is public until you publish it." />
      <div className="grid gap-8">
        {props.profile ? <ProfileHeader profile={props.profile} origin={props.origin} products={props.products} /> : <ProfileEmpty />}
        <Products {...props} />
        {props.excluded.length > 0 ? (
          <p className="text-caption text-muted-foreground">
            Not offered: {props.excluded.join(', ')}. Demo data and test-mode keys never count on a public page.
          </p>
        ) : null}
      </div>
    </>
  );
}

/**
 * The founder as a profile header: who, what's public, Edit profile beside the name, and the
 * profile's link with one-tap posts under it once a product is public (until then /u/ is a 404).
 */
function ProfileHeader(props: { profile: Profile; origin: string; products: ShareProduct[] }) {
  const p = props.profile;
  const live = props.products.filter((x) => x.published);
  const mrr = live.reduce((sum, x) => sum + (x.mrr ?? 0), 0);
  const url = `${props.origin}/u/${p.handle}`;
  const across = live.length === 1 ? '' : ` across ${live.length} products`;
  return (
    <CossCard render={<section aria-labelledby="profile-name" />} className="min-w-0 overflow-hidden">
      <div className="flex items-start gap-4 p-5 sm:gap-5 sm:p-6">
        {/* The photo opens Edit profile, as on a social network. */}
        <a href="/share/profile" aria-label="Edit profile" className="shrink-0 rounded-full">
          <Avatar name={p.displayName} src={p.avatar} className="size-14 font-heading text-title sm:size-16" />
        </a>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
            <div className="min-w-0">
              <h2 id="profile-name" className="font-heading text-title wrap-break-word">
                {p.displayName}
              </h2>
              <p className="text-body text-muted-foreground">
                {live.length > 0 ? (
                  <a href={`/u/${p.handle}`} className="hover:text-foreground hover:underline">
                    @{p.handle}
                  </a>
                ) : (
                  `@${p.handle}`
                )}
              </p>
            </div>
            <LinkButton href="/share/profile" variant="secondary" small>
              <Pencil />
              Edit profile
            </LinkButton>
          </div>
          {p.bio ? <p className="mt-3 text-body text-pretty wrap-break-word">{p.bio}</p> : null}
          {p.website || p.xHandle ? (
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-body text-muted-foreground">
              {p.website ? (
                <a href={p.website} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1.5 hover:text-foreground">
                  <Link2 className="size-4 shrink-0" />
                  <span className="truncate">{siteLabel(p.website)}</span>
                </a>
              ) : null}
              {p.xHandle ? (
                <a href={`https://x.com/${p.xHandle}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 hover:text-foreground">
                  <XMark className="size-3.5 shrink-0" />@{p.xHandle}
                </a>
              ) : null}
            </p>
          ) : null}
          {live.length > 0 ? (
            <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-body text-muted-foreground">
              <span>
                <span className="font-semibold text-foreground tabular-nums">{usd(mrr)}</span> MRR
              </span>
              <span>
                <span className="font-semibold text-foreground tabular-nums">{live.length}</span> {live.length === 1 ? 'public product' : 'public products'}
              </span>
            </p>
          ) : null}
        </div>
      </div>
      <div className="border-t bg-muted/30 px-5 py-4 sm:px-6">
        {live.length > 0 ? (
          <ShareSheet id="profile-link" url={url} title={p.displayName} text={`I’m at ${usd(mrr)} MRR${across}, verified by hoomuch`} />
        ) : (
          <p className="text-body text-muted-foreground">
            Your profile goes public at {strip(url)} with your first published product.
          </p>
        )}
      </div>
    </CossCard>
  );
}

/** Before there's a profile: what it's for, and the way to make one. Publishing needs it. */
function ProfileEmpty() {
  return (
    <CossCard render={<section aria-labelledby="profile-name" />} className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-4 p-5 sm:gap-x-5 sm:p-6">
        <span aria-hidden="true" className="flex size-14 shrink-0 items-center justify-center rounded-full border border-dashed text-muted-foreground sm:size-16">
          <UserRound className="size-6" />
        </span>
        <div className="min-w-0 flex-1 basis-60">
          <h2 id="profile-name" className="font-heading text-base">
            Set up your founder profile
          </h2>
          <p className="mt-0.5 text-body text-pretty text-muted-foreground">
            Your name and handle on every product page. You need one to publish.
          </p>
        </div>
        <LinkButton href="/share/profile">Set up profile</LinkButton>
      </div>
    </CossCard>
  );
}

/** The products as a list, or what to do while there are none. */
function Products(props: SharePageProps) {
  if (props.products.length === 0) {
    return props.connections.length === 0 ? (
      <EmptyState
        plain
        title="Connect a live account first"
        actions={
          <LinkButton href="/connections" variant={props.profile ? 'primary' : 'secondary'}>
            Go to Connections
          </LinkButton>
        }
      >
        A public page shows figures from your connections. Demo data and test-mode keys can’t be published.
      </EmptyState>
    ) : (
      <EmptyState
        plain
        title="No products yet"
        actions={
          <LinkButton href="/share/new" variant={props.profile ? 'primary' : 'secondary'}>
            <Plus />
            New product
          </LinkButton>
        }
      >
        A product adds up the connections you pick, for example Stripe for the web app and RevenueCat for the iOS app.
      </EmptyState>
    );
  }
  return (
    <section aria-labelledby="products-title" className="grid gap-3">
      <div className="flex items-center justify-between gap-4">
        <h2 id="products-title" className="font-heading text-base">
          Products
        </h2>
        {/* Shown under the cap even with no free connection: the new view says what to do then. */}
        {props.products.length < props.maxProducts ? (
          <LinkButton href="/share/new" variant="secondary" small>
            <Plus />
            New product
          </LinkButton>
        ) : null}
      </div>
      <CossCard render={<ul />} className="divide-y overflow-hidden">
        {props.products.map((p) => (
          <li key={p.id}>
            <a href={`/share/products/${p.id}`} className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-accent/40 sm:px-6">
              <ProductTile name={p.name} src={p.logo} className="size-9 text-caption" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{p.name}</span>
                <span className={cn('block truncate text-caption', !p.published && !p.removed && p.mrr !== null ? 'text-brand' : 'text-muted-foreground')}>
                  {p.removed
                    ? 'Taken down by this site'
                    : p.published
                      ? `${strip(props.origin)}/p/${p.slug}`
                      : p.mrr !== null
                        ? 'Ready to publish'
                        : 'Waiting for its first sync'}
                </span>
              </span>
              <span className="hidden text-muted-foreground tabular-nums sm:inline">{p.mrr !== null ? `${usd(p.mrr)} MRR` : null}</span>
              <Status product={p} />
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            </a>
          </li>
        ))}
      </CossCard>
    </section>
  );
}

function Status(props: { product: ShareProduct }) {
  if (props.product.removed) return <Badge variant="error">Taken down</Badge>;
  return props.product.published ? <Badge variant="success">Public</Badge> : <Badge variant="outline">Draft</Badge>;
}

/** The badge: a preview and one field to copy, HTML or Markdown (the switch appears once hydrated). */
function BadgeCopy(props: { product: ShareProduct; origin: string }) {
  const [format, setFormat] = useState<'html' | 'md'>('html');
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const page = `${props.origin}/p/${props.product.slug}`;
  const badge = `${props.origin}/badge/${props.product.slug}.svg`;
  const value =
    format === 'html'
      ? `<a href="${page}"><img src="${badge}" alt="MRR verified by hoomuch" height="20"></a>`
      : `[![MRR verified by hoomuch](${badge})](${page})`;
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-4">
        {/* Same origin as this page, so the CSP's img-src 'self' allows it. */}
        <img src={`/badge/${props.product.slug}.svg`} alt={`The badge for ${props.product.name}`} height={20} className="h-5 w-auto" />
        {ready ? (
          <div className="flex gap-1" role="group" aria-label="Badge format">
            {(['html', 'md'] as const).map((f) => (
              <CossButton key={f} type="button" size="sm" variant={format === f ? 'secondary' : 'ghost'} aria-pressed={format === f} onClick={() => setFormat(f)}>
                {f === 'html' ? 'HTML' : 'Markdown'}
              </CossButton>
            ))}
          </div>
        ) : null}
      </div>
      <CopyField id={`badge-${props.product.id}`} label={format === 'html' ? 'Badge as HTML' : 'Badge as Markdown'} value={value} />
    </div>
  );
}

function PublishForm(props: { product: ShareProduct; hasProfile: boolean }) {
  if (!props.hasProfile) {
    return (
      <p className="text-body text-muted-foreground">
        <TextLink href="/share/profile">Set up your founder profile</TextLink> first: a public page says who makes the product.
      </p>
    );
  }
  if (props.product.mrr === null) {
    return <p className="text-body text-muted-foreground">No figures yet: it can be published once its connections have finished a sync.</p>;
  }
  return (
    <form method="post" action={`/share/products/${props.product.id}/publish`}>
      <ConfirmCheckbox id={`confirm-${props.product.id}`} label="Anyone can see its revenue, MRR and subscriptions, in US dollars, with my founder profile." />
      {/* Listing is the default; unticking it is the rare case, so it's quiet. */}
      <div className="mb-4">
        <CheckboxOption id={`listed-${props.product.id}`} name="listed" value="yes" defaultChecked label="Also list it on Explore" />
      </div>
      <Button busyLabel="Publishing…">Publish</Button>
    </form>
  );
}

// ---------- a product's own view: share it, or publish it ----------

function ProductView(props: SharePageProps & { product: ShareProduct }) {
  const p = props.product;
  const base = `/share/products/${p.id}`;
  const page = `${props.origin}/p/${p.slug}`;
  return (
    <>
      <PageHeader
        back={{ href: '/share', label: 'Share' }}
        title={p.name}
        description={
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body">
            <Status product={p} />
            {p.mrr !== null ? (
              <span className="tabular-nums">
                {usd(p.mrr)} MRR
                {p.published ? null : (
                  <>
                    , as of <RelativeTime ms={p.statsAt} />
                  </>
                )}
              </span>
            ) : (
              <span>No figures yet</span>
            )}
          </p>
        }
        actions={
          <>
            {p.published ? (
              <LinkButton href={`/p/${p.slug}`} variant="secondary" small>
                View page
                <ArrowUpRight />
              </LinkButton>
            ) : null}
            <LinkButton href={`${base}/edit`} variant="secondary" small>
              <Pencil />
              Edit
            </LinkButton>
          </>
        }
      />
      <div className="grid gap-6">
        {p.published ? (
          <>
            <Card title="Share" description="Post it, or send the link.">
              <ShareSheet id={`link-${p.id}`} url={page} title={p.name} text={productPost(p)} />
            </Card>
            {props.cards?.productId === p.id && p.mrr !== null ? (
              <Card title="Share as an image" description="Its figure, revenue chart or revenue calendar, to post with the link.">
                <ShareCards
                  data={{
                    slug: p.slug,
                    name: p.name,
                    logo: p.logo,
                    host: strip(props.origin),
                    mrr: p.mrr,
                    revenue: props.cards.revenue,
                    revenueTotal: props.cards.revenueTotal,
                    today: props.cards.today,
                    daily: props.cards.daily,
                    weekly: props.cards.weekly,
                  } satisfies CardData}
                />
              </Card>
            ) : null}
            <Card title="Badge" description="For your site or README. It links to the page.">
              <BadgeCopy product={p} origin={props.origin} />
            </Card>
            <AboutCard product={p} />
            <form method="post" action={`${base}/listing`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1">
              <p className="text-body text-muted-foreground">
                {!p.listed ? (
                  'Not on Explore.'
                ) : p.explore ? (
                  EXPLORE_WHY[p.explore]
                ) : (
                  <>
                    On <TextLink href="/explore">Explore</TextLink>.
                  </>
                )}
              </p>
              <input type="hidden" name="listed" value={p.listed ? 'no' : 'yes'} />
              <Button variant="ghost" small>
                {p.listed ? 'Take off Explore' : 'List on Explore'}
              </Button>
            </form>
          </>
        ) : p.removed ? (
          // Taken down by the operator: no publish form, and the reason to ask them about it.
          <Alert tone="error" title="Taken down">
            The people who run this site took this product’s page down, so its page and badge are gone and it can’t be published
            again.{' '}
            {props.operatorEmail ? (
              <>
                If you think that’s a mistake, write to <TextLink href={`mailto:${props.operatorEmail}`}>{props.operatorEmail}</TextLink>.
              </>
            ) : null}
          </Alert>
        ) : (
          <Card
            title="Publish"
            description={p.mrr !== null && props.profile ? `Its page will show ${usd(p.mrr)} MRR, as checked by hoomuch.` : undefined}
          >
            <PublishForm product={p} hasProfile={Boolean(props.profile)} />
          </Card>
        )}
        {p.published ? null : <AboutCard product={p} />}
      </div>
    </>
  );
}

/** The parts of the details the summary counts: message, what it does, problem, audience, pricing, team, funding, markets, tech, channels, anything else. */
const DETAIL_PARTS = 11;

/** What the page says about the product beyond its figures: what's filled in, and the way to the form. */
function AboutCard(props: { product: ShareProduct }) {
  const p = props.product;
  const d = p.details;
  const filled = [
    d.message,
    d.description,
    d.problem,
    d.audience || d.model,
    d.plans.length || d.pricing,
    d.teamSize,
    d.funding,
    d.markets.length,
    d.tech.length,
    d.channels.length,
    d.more,
  ].filter(Boolean).length;
  const facts = [p.founded ? `Founded ${formatFounded(p.founded)}` : null, countryName(p.country)].filter((x): x is string => x !== null);
  const any = facts.length > 0 || filled > 0;
  return (
    <Card
      title="About the product"
      description={
        any
          ? [...facts, filled > 0 ? `${filled} of ${DETAIL_PARTS} details filled in` : null].filter(Boolean).join(' · ')
          : 'When it was founded, where, what it solves, who it’s for, its tech stack and more. Its page shows them under About, as your words.'
      }
      actions={
        <LinkButton href={`/share/products/${p.id}/details`} variant="secondary" small>
          {any ? <Pencil /> : <Plus />}
          {any ? 'Edit details' : 'Add details'}
        </LinkButton>
      }
    />
  );
}

/** The details' own page: founded, country and the About section, every field optional. */
function DetailsView(props: SharePageProps & { product: ShareProduct }) {
  const p = props.product;
  const base = `/share/products/${p.id}`;
  return (
    <>
      <PageHeader
        back={{ href: base, label: p.name }}
        title="About the product"
        description="Its public page shows these as your words, apart from the figures hoomuch checks. Every field is optional. Links, email addresses and phone numbers stay out of them: your website and store pages have their own fields."
      />
      <Card>
        <DetailsForm product={p} failed={props.detailsForm} action={`${base}/details`} cancel={base} />
      </Card>
    </>
  );
}

const NOT_SET = { value: '', label: 'Not set' };

/**
 * The details, in the order the page answers a visitor's questions: what it is, how it makes money,
 * how it finds customers, how it's built, and the company behind it.
 */
function DetailsForm(props: { product: ShareProduct; failed?: SharePageProps['detailsForm']; action: string; cancel: string }) {
  const p = props.product;
  const d = p.details;
  const thisYear = new Date(useNow()).getUTCFullYear();
  const v: DetailsFormValues = props.failed?.values ?? {
    foundedYear: p.founded?.slice(0, 4) ?? '',
    foundedMonth: p.founded?.slice(5, 7) ?? '',
    country: p.country ?? '',
    teamSize: d.teamSize !== null ? String(d.teamSize) : '',
    funding: d.funding ?? '',
    message: d.message ?? '',
    description: d.description ?? '',
    problem: d.problem ?? '',
    audience: d.audience ?? '',
    model: d.model ?? '',
    plans: d.plans.map((x) => ({
      name: x.name,
      price: x.period === 'free' ? '' : String(toMajor(x.price, x.currency)),
      currency: x.currency,
      period: x.period,
      note: x.note ?? '',
    })),
    pricing: d.pricing ?? '',
    markets: d.markets,
    tech: d.tech,
    channels: d.channels,
    more: d.more ?? '',
  };
  const errors = props.failed?.fieldErrors ?? {};
  // A long form: the summary stays on top, and takes focus unless a text field can (the pickers can't).
  const focus = errors.teamSize ? 'team' : props.failed ? 'form' : null;
  const years = Array.from({ length: thisYear - FOUNDED_MIN_YEAR + 1 }, (_, i) => String(thisYear - i));
  return (
    <form method="post" action={props.action}>
      <FormError message={props.failed?.error} autoFocus={focus === 'form'} />
      <FormPart title="A message from you" description="It opens the About section, with your name and photo.">
        <TextareaField
          id="details-message"
          name="message"
          label="Message to visitors"
          maxLength={MESSAGE_MAX}
          value={v.message}
          rows={4}
          placeholder="Why you built it, where it’s going, and what you’d like from the people reading this."
          help={`In your own voice. Up to ${MESSAGE_MAX} characters.`}
          error={errors.message}
        />
      </FormPart>
      <FormPart title="What it is">
        <TextareaField
          id="details-description"
          name="description"
          label="What it does"
          maxLength={DESCRIPTION_MAX}
          value={v.description}
          help={`A few sentences: what it is and what people use it for. The line under its name says it in one. Up to ${DESCRIPTION_MAX} characters.`}
          error={errors.description}
        />
        {/* The limit is said up front: the box stops taking text at it, and a pasted paragraph would
            otherwise end mid-sentence on the public page. */}
        <TextareaField
          id="details-problem"
          name="problem"
          label="Problem it solves"
          maxLength={PROBLEM_MAX}
          value={v.problem}
          help={`Up to ${PROBLEM_MAX} characters.`}
          error={errors.problem}
        />
        <TextareaField
          id="details-audience"
          name="audience"
          label="Who it’s for"
          maxLength={AUDIENCE_MAX}
          value={v.audience}
          rows={2}
          help={`Up to ${AUDIENCE_MAX} characters.`}
          error={errors.audience}
        />
        <SelectField id="details-model" name="model" label="Sells to" options={[NOT_SET, ...MODELS.map((m) => ({ value: m.id, label: m.label }))]} value={v.model} />
        <ChipGroup
          name="markets"
          kind="market"
          legend="Market"
          max={MARKETS_MAX}
          groups={[{ id: 'all', label: '', items: MARKETS }]}
          picked={v.markets}
          error={errors.markets}
        />
      </FormPart>
      <FormPart
        title="How it makes money"
        description="One row for each way to pay, as on your pricing page: a monthly and a yearly plan are two rows. A yearly plan shows what it saves against the monthly one with the same name."
      >
        <PlanRows initial={v.plans} errors={errors.plans} />
        <Field
          id="details-pricing"
          name="pricing"
          label="Anything else about pricing"
          maxLength={PRICING_MAX}
          value={v.pricing}
          placeholder="Prints are priced per object, delivered."
          error={errors.pricing}
        />
      </FormPart>
      <FormPart title="How it finds customers">
        <ChipGroup
          name="channels"
          kind="channel"
          legend="Marketing channels"
          max={CHANNELS_MAX}
          groups={[{ id: 'all', label: '', items: CHANNELS }]}
          picked={v.channels}
          error={errors.channels}
        />
      </FormPart>
      <FormPart title="How it’s built">
        <ChipGroup
          name="tech"
          kind="tech"
          legend="Tech stack"
          max={TECH_MAX}
          groups={TECH_GROUPS.map((g) => ({ id: g.id, label: g.label, items: TECH.filter((t) => t.group === g.id) }))}
          picked={v.tech}
          error={errors.tech}
        />
      </FormPart>
      <FormPart title="The company">
        <div className="grid gap-x-4 sm:grid-cols-2">
          <SelectField
            id="details-founded-year"
            name="founded_year"
            label="Year founded"
            options={[NOT_SET, ...years.map((y) => ({ value: y, label: y }))]}
            value={v.foundedYear}
            error={errors.founded}
          />
          <SelectField
            id="details-founded-month"
            name="founded_month"
            label="Month founded"
            options={[NOT_SET, ...FOUNDED_MONTHS]}
            value={v.foundedMonth}
          />
        </div>
        <SelectField
          id="details-country"
          name="country"
          label="Country"
          // Names alone, so typing one jumps to it in the list (a flag in front would hide the name).
          options={[NOT_SET, ...COUNTRIES.map((c) => ({ value: c.code, label: c.name }))]}
          value={v.country}
          error={errors.country}
          help="Where it’s made: where you or the company are."
        />
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field
            id="details-team"
            name="team_size"
            label="Team size"
            inputMode="numeric"
            maxLength={6}
            value={v.teamSize}
            placeholder="1"
            autoFocus={focus === 'team'}
            error={errors.teamSize}
          />
          <SelectField id="details-funding" name="funding" label="Funding" options={[NOT_SET, ...FUNDING.map((f) => ({ value: f.id, label: f.label }))]} value={v.funding} />
        </div>
      </FormPart>
      <TextareaField id="details-more" name="more" label="Anything else" maxLength={MORE_MAX} value={v.more} help={`Up to ${MORE_MAX} characters.`} error={errors.more} />
      <FormActions submitLabel="Save details" cancel={props.cancel} />
    </form>
  );
}

type PlanRow = DetailsFormValues['plans'][number];

const CURRENCY_OPTIONS = SUPPORTED_CURRENCIES.map((c) => ({ value: c, label: c }));
const PERIOD_OPTIONS = PLAN_PERIODS.map((x) => ({ value: x.id, label: x.label }));

/** The rows to start with: the plans there are, then room for more (a monthly and a yearly one when there are none). */
function startRows(initial: readonly PlanRow[]): PlanRow[] {
  const empty = (period: string): PlanRow => ({ name: '', price: '', currency: initial[0]?.currency ?? 'USD', period, note: '' });
  const rows = [...initial];
  if (rows.length === 0) rows.push(empty('month'), empty('year'));
  else if (rows.length < PLANS_MAX) rows.push(empty('month'));
  return rows;
}

/**
 * The pricing plans, a row each. Before hydration the form carries these rows and an empty one,
 * and a saved form comes back with another empty row; after it, "Add a plan" and "Remove" change
 * the rows in place. A row left empty is left out.
 */
function PlanRows(props: { initial: readonly PlanRow[]; errors?: Record<number, string> }) {
  const [rows, setRows] = useState(() => startRows(props.initial).map((row, key) => ({ key, row })));
  const [nextKey, setNextKey] = useState(PLANS_MAX + 1);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const add = () => {
    setRows((r) => [...r, { key: nextKey, row: { name: '', price: '', currency: r[0]?.row.currency || 'USD', period: 'month', note: '' } }]);
    setNextKey((k) => k + 1);
  };
  return (
    <div className="mb-5 grid gap-3">
      {rows.map(({ key, row }, i) => {
        const id = (field: string) => `details-plan-${key}-${field}`;
        const error = props.errors?.[i];
        // Examples on a new row only: on a filled one they'd read as values.
        const fresh = !row.name && !row.price && !row.note;
        return (
          <fieldset key={key} className="rounded-xl border px-4 pt-3" data-invalid={error ? '' : undefined}>
            <legend className="sr-only">Plan {i + 1}</legend>
            <div className="mb-3 flex min-h-8 items-center justify-between gap-4">
              <p aria-hidden="true" className="text-caption font-medium text-muted-foreground">
                Plan {i + 1}
              </p>
              {mounted && rows.length > 1 ? (
                <CossButton type="button" variant="ghost" size="sm" onClick={() => setRows((r) => r.filter((x) => x.key !== key))}>
                  Remove
                </CossButton>
              ) : null}
            </div>
            <div className="grid gap-x-3 sm:grid-cols-2">
              <Field id={id('name')} name={`plan_${i}_name`} label="Name" maxLength={PLAN_NAME_MAX} value={row.name} placeholder={fresh ? 'Pro' : undefined} hideOptional />
              <SelectField id={id('period')} name={`plan_${i}_period`} label="Billing" options={PERIOD_OPTIONS} value={row.period} />
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_6.5rem] gap-x-3">
                <Field id={id('price')} name={`plan_${i}_price`} label="Price" inputMode="decimal" maxLength={12} value={row.price} placeholder={fresh ? '29' : undefined} hideOptional />
                <SelectField id={id('currency')} name={`plan_${i}_currency`} label="Currency" options={CURRENCY_OPTIONS} value={row.currency} narrow />
              </div>
              <Field id={id('note')} name={`plan_${i}_note`} label="Note" maxLength={PLAN_NOTE_MAX} value={row.note} placeholder={fresh ? '2,500 credits a month' : undefined} />
            </div>
            {error ? <p className="-mt-1 mb-3 text-caption text-destructive-foreground">{error}</p> : null}
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-caption text-muted-foreground">Leave a row empty to leave it out. A free plan needs no price.</p>
        {mounted && rows.length < PLANS_MAX ? (
          <CossButton type="button" variant="outline" size="sm" onClick={add}>
            <Plus />
            Add a plan
          </CossButton>
        ) : null}
      </div>
    </div>
  );
}

/** A part of a long form, under a small heading, with what it's for when that needs saying. */
function FormPart(props: { title: string; description?: string; children: ReactNode }) {
  return (
    <fieldset className="mb-6 border-b pb-2">
      <legend className="mb-1 font-heading text-base">{props.title}</legend>
      {props.description ? <p className="mb-4 text-caption text-pretty text-muted-foreground">{props.description}</p> : <div className="mb-3" />}
      {props.children}
    </fieldset>
  );
}

/**
 * Tags from a fixed list as chips (native checkboxes, so it works before hydration), in groups
 * when the list has them. The limit is said up front; the server turns back too many.
 */
function ChipGroup(props: {
  name: string;
  kind: 'market' | 'channel' | 'tech';
  legend: string;
  max: number;
  groups: ReadonlyArray<{ id: string; label: string; items: ReadonlyArray<{ id: string; label: string }> }>;
  picked: readonly string[];
  error?: string;
}) {
  const picked = new Set(props.picked);
  const id = `details-${props.name}`;
  return (
    <fieldset className="mb-5" aria-describedby={`${id}-rule${props.error ? ` ${id}-error` : ''}`} data-invalid={props.error ? '' : undefined}>
      <legend className="text-body font-medium">
        {props.legend}
        <span className="font-normal text-faint"> (optional)</span>
      </legend>
      <p id={`${id}-rule`} className="mt-1 mb-3 text-caption text-muted-foreground">
        Up to {props.max}.
      </p>
      <div className="grid gap-3">
        {props.groups.map((g) => (
          <div key={g.id}>
            {g.label ? <p className="mb-2 text-caption font-medium text-muted-foreground">{g.label}</p> : null}
            <div className="flex flex-wrap gap-2">
              {g.items.map((item) => (
                <ChipCheckbox
                  key={item.id}
                  id={`${id}-${item.id}`}
                  name={props.name}
                  value={item.id}
                  label={item.label}
                  icon={<TagIcon kind={props.kind} id={item.id} />}
                  defaultChecked={picked.has(item.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      {props.error ? (
        <p id={`${id}-error`} className="mt-2 text-caption text-destructive-foreground">
          {props.error}
        </p>
      ) : null}
    </fieldset>
  );
}

// ---------- the forms: a product's details, a new product, the profile ----------

function EditProductView(props: SharePageProps & { product: ShareProduct }) {
  const p = props.product;
  const base = `/share/products/${p.id}`;
  const failed = props.form?.productId === p.id ? props.form : undefined;
  return (
    <>
      <PageHeader back={{ href: base, label: p.name }} title="Edit product" />
      <div className="grid gap-8">
        {props.media ? <LogoCard product={p} /> : null}
        <Card>
          <ProductForm
            action={base}
            idPrefix={p.id}
            connections={props.connections}
            productName={new Map(props.products.map((x) => [x.id, x.name]))}
            productId={p.id}
            values={
              failed?.values ?? {
                name: p.name,
                slug: p.slug,
                tagline: p.tagline ?? '',
                website: p.website ?? '',
                appStore: p.appStoreUrl ?? '',
                playStore: p.playStoreUrl ?? '',
                connections: p.connectionIds,
              }
            }
            failed={failed}
            origin={props.origin}
            submitLabel="Save changes"
            cancel={base}
          />
        </Card>
        <section aria-labelledby="take-down" className="grid gap-3 border-t pt-6">
          <h2 id="take-down" className="font-heading text-base">
            {p.published ? 'Unpublish or delete' : 'Delete'}
          </h2>
          <p className="text-body text-muted-foreground">
            {p.published ? 'Unpublishing takes the page and badge down; you can publish again any time. ' : ''}
            Deleting the product takes it away for good. Your connections and their data stay.
          </p>
          <div className="flex flex-wrap gap-2">
            {p.published ? (
              <form method="post" action={`${base}/unpublish`}>
                <Button variant="secondary" small>
                  Unpublish
                </Button>
              </form>
            ) : null}
            <form method="post" action={`${base}/delete`}>
              <Button variant="ghost" small>
                Delete product
              </Button>
            </form>
          </div>
        </section>
      </div>
    </>
  );
}

/** The product's logo: its website's icon, the owner's own, or initials; each change is one form. */
function LogoCard(props: { product: ShareProduct }) {
  const p = props.product;
  const base = `/share/products/${p.id}/logo`;
  const source = p.website || p.appStoreUrl;
  const where =
    p.logoSource === 'upload'
      ? 'Your own logo.'
      : p.logoSource === 'site'
        ? `The icon from your ${p.website ? 'website' : 'App Store page'}. Upload your own to use that instead.`
        : source
          ? 'Initials for now: hoomuch found no icon it can use. Upload a logo, or try the icon again.'
          : 'Initials for now. Upload a logo, or add the product’s website or App Store link below and its icon is used.';
  return (
    <Card>
      <ImageUploadCard
        id={`logo-${p.id}`}
        action={base}
        field="logo"
        label={p.logoSource === 'upload' ? 'Change logo' : 'Upload a logo'}
        preview={<ProductTile name={p.name} src={p.logo} className="size-16 rounded-2xl font-heading text-title" />}
        title="Logo"
        description={where}
        extra={
          <>
            {source && p.logoSource !== 'site' ? (
              <form method="post" action={`${base}/site`}>
                <Button variant="ghost" small busyLabel="Fetching…">
                  {p.website ? 'Use your website’s icon' : 'Use your App Store icon'}
                </Button>
              </form>
            ) : null}
            {p.logo ? (
              <form method="post" action={`${base}/delete`}>
                <Button variant="ghost" small>
                  Remove
                </Button>
              </form>
            ) : null}
          </>
        }
      />
    </Card>
  );
}

function NewProductView(props: SharePageProps) {
  const failed = props.form?.productId === null ? props.form : undefined;
  return (
    <>
      <PageHeader
        back={{ href: '/share', label: 'Share' }}
        title="New product"
        description="Pick the connections it adds up, for example Stripe for the web app and RevenueCat for the iOS app."
      />
      <div>
        {canAddProduct(props) || failed ? (
          <Card>
            <ProductForm
              action="/share/products"
              idPrefix="new"
              connections={props.connections}
              productName={new Map(props.products.map((x) => [x.id, x.name]))}
              productId={null}
              values={failed?.values}
              failed={failed}
              origin={props.origin}
              submitLabel="Save product"
              cancel="/share"
              logo={Boolean(props.media)}
            />
          </Card>
        ) : (
          <p className="text-body text-muted-foreground">
            {props.products.length >= props.maxProducts
              ? `You have ${props.maxProducts} products, the most one account can have.`
              : 'Every live connection is in a product. Take one out of its product under Edit, or '}
            {props.products.length >= props.maxProducts ? null : <TextLink href="/connections">connect another account</TextLink>}
            {props.products.length >= props.maxProducts ? null : '.'}
          </p>
        )}
      </div>
    </>
  );
}

function ProductForm(props: {
  action: string;
  idPrefix: string;
  connections: ShareConnection[];
  productName: Map<string, string>;
  productId: string | null;
  values?: ShareFormValues;
  failed?: SharePageProps['form'];
  origin: string;
  submitLabel: string;
  /** Where Cancel goes. */
  cancel: string;
  /** Ask for a logo too (a new product, where the instance keeps images): the form posts as multipart. */
  logo?: boolean;
}) {
  const v = props.values;
  const errors = props.failed?.fieldErrors ?? {};
  const formError = props.failed && Object.keys(errors).length === 0 ? props.failed.error : null;
  const focus = formError
    ? 'form'
    : errors.name
      ? 'name'
      : errors.slug
        ? 'slug'
        : errors.website
          ? 'website'
          : errors.appStore
            ? 'appStore'
            : errors.playStore
              ? 'playStore'
              : errors.logo
                ? 'logo'
                : null;
  const id = (name: string) => `${props.idPrefix}-${name}`;
  const picked = new Set(v?.connections ?? []);
  const rows = props.connections.map((c) => ({
    c,
    elsewhere: c.productId !== null && c.productId !== props.productId ? (props.productName.get(c.productId) ?? 'another product') : undefined,
  }));
  const free = rows.filter((r) => r.elsewhere === undefined);
  const taken = rows.filter((r) => r.elsewhere !== undefined);
  return (
    <form method="post" action={props.action} encType={props.logo ? 'multipart/form-data' : undefined}>
      <FormError message={formError} autoFocus={focus === 'form'} />
      {props.logo ? (
        <ImageField
          id={id('logo')}
          name="logo"
          label="Logo"
          error={errors.logo}
          placeholder={
            <span aria-hidden="true" className="flex size-16 items-center justify-center rounded-2xl border border-dashed text-muted-foreground">
              <ImagePlus className="size-6" />
            </span>
          }
          help="A square works best. Leave it empty and the product’s website icon is used, if it has one."
        />
      ) : null}
      <Field
        id={id('name')}
        name="name"
        label="Product name"
        required
        maxLength={NAME_MAX}
        value={v?.name}
        autoFocus={focus === 'name'}
        error={errors.name}
      />
      <Field
        id={id('slug')}
        name="slug"
        label="Page address"
        maxLength={SLUG_MAX}
        value={v?.slug}
        help={`${strip(props.origin)}/p/your-address. Lowercase letters, digits and hyphens. Leave it empty to use the name.`}
        spellCheck={false}
        autoCapitalize="none"
        inputClassName="font-mono"
        autoFocus={focus === 'slug'}
        error={errors.slug}
      />
      <Field id={id('tagline')} name="tagline" label="One line about it" maxLength={TAGLINE_MAX} value={v?.tagline} />
      <Field
        id={id('website')}
        name="website"
        label="Website"
        type="url"
        inputMode="url"
        maxLength={WEBSITE_MAX}
        value={v?.website}
        placeholder="https://"
        spellCheck={false}
        autoCapitalize="none"
        autoFocus={focus === 'website'}
        error={errors.website}
      />
      {/* For an app: its store listings, linked on the public page beside the website. */}
      <Field
        id={id('app-store')}
        name="app_store"
        label="App Store"
        type="url"
        inputMode="url"
        maxLength={STORE_LINK_MAX}
        value={v?.appStore}
        placeholder="https://apps.apple.com/app/id…"
        spellCheck={false}
        autoCapitalize="none"
        autoFocus={focus === 'appStore'}
        error={errors.appStore}
      />
      <Field
        id={id('play-store')}
        name="play_store"
        label="Google Play"
        type="url"
        inputMode="url"
        maxLength={STORE_LINK_MAX}
        value={v?.playStore}
        placeholder="https://play.google.com/store/apps/details?id=…"
        help="For an app: its store pages, linked on the product’s public page."
        spellCheck={false}
        autoCapitalize="none"
        autoFocus={focus === 'playStore'}
        error={errors.playStore}
      />
      {/* The free ones first; one already in another product comes after, faded, with its product
          named, and the rule is said once under the list. */}
      <fieldset className="mb-5" aria-describedby={errors.connections ? id('connections-error') : taken.length > 0 ? id('connections-rule') : undefined}>
        <legend className="mb-2 text-body font-medium">Connections it adds up</legend>
        <div className="grid gap-3">
          {[...free, ...taken].map(({ c, elsewhere }) => (
            <CheckboxOption
              key={c.id}
              id={id(`conn-${c.id}`)}
              name="connections"
              value={c.id}
              defaultChecked={picked.has(c.id)}
              disabled={elsewhere !== undefined}
              label={
                <span className="inline-flex items-center gap-2">
                  <ProviderLogo provider={c.provider} />
                  {c.name}
                </span>
              }
              hint={elsewhere !== undefined ? `In ${elsewhere}` : undefined}
            />
          ))}
        </div>
        {errors.connections ? (
          <p id={id('connections-error')} className="mt-2 text-caption text-destructive-foreground">
            {errors.connections}
          </p>
        ) : taken.length > 0 ? (
          <p id={id('connections-rule')} className="mt-3 text-caption text-muted-foreground">
            A connection counts in one product only.
          </p>
        ) : null}
      </fieldset>
      <FormActions submitLabel={props.submitLabel} cancel={props.cancel} />
    </form>
  );
}

function FormActions(props: { submitLabel: string; cancel: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button>{props.submitLabel}</Button>
      <LinkButton href={props.cancel} variant="ghost">
        Cancel
      </LinkButton>
    </div>
  );
}

/** The profile's own page: the form, like a social network's Edit profile. */
function ProfileView(props: SharePageProps) {
  const p = props.profile ?? null;
  const live = props.products.some((x) => x.published);
  const host = strip(props.origin);
  return (
    <>
      <PageHeader
        back={{ href: '/share', label: 'Share' }}
        title={p ? 'Edit profile' : 'Set up your profile'}
        description={
          p && live ? (
            <>
              Shown on your product pages, and at <TextLink href={`/u/${p.handle}`}>{`${host}/u/${p.handle}`}</TextLink> with your public products added
              up.
            </>
          ) : (
            <>A public product page says who makes it. Your profile shows on your product pages, and at {host}/u/your-handle while one of them is public.</>
          )
        }
      />
      <div className="grid gap-6">
        {p && props.media ? (
          <Card>
            <ImageUploadCard
              id="profile-photo"
              action="/share/profile/photo"
              field="photo"
              label={p.avatar ? 'Change photo' : 'Add a photo'}
              preview={<Avatar name={p.displayName} src={p.avatar} className="size-20 font-heading text-section-sm" />}
              title="Photo"
              description="On your profile, your product pages and Explore. A square works best."
              extra={
                p.avatar ? (
                  <form method="post" action="/share/profile/photo/delete">
                    <Button variant="ghost" small>
                      Remove
                    </Button>
                  </form>
                ) : null
              }
            />
          </Card>
        ) : null}
        <Card>
          <ProfileForm profile={p} failed={props.profileForm} origin={props.origin} />
        </Card>
      </div>
    </>
  );
}

/** The founder profile's fields, in the order a social profile asks for them. */
function ProfileForm(props: { profile: Profile | null; failed?: SharePageProps['profileForm']; origin: string }) {
  const p = props.profile;
  const v: ProfileFormValues = props.failed?.values ?? {
    handle: p?.handle ?? '',
    displayName: p?.displayName ?? '',
    bio: p?.bio ?? '',
    website: p?.website ?? '',
    xHandle: p?.xHandle ? `@${p.xHandle}` : '',
  };
  const errors = props.failed?.fieldErrors ?? {};
  const formError = props.failed && Object.keys(errors).length === 0 ? props.failed.error : null;
  const focus = formError ? 'form' : errors.displayName ? 'name' : errors.handle ? 'handle' : errors.website ? 'website' : errors.xHandle ? 'x' : null;
  return (
    <form method="post" action="/share/profile">
      <FormError message={formError} autoFocus={focus === 'form'} />
      <Field
        id="profile-name"
        name="display_name"
        label="Name"
        required
        maxLength={DISPLAY_NAME_MAX}
        value={v.displayName}
        autoComplete="name"
        autoFocus={focus === 'name'}
        error={errors.displayName}
      />
      <Field
        id="profile-handle"
        name="handle"
        label="Handle"
        required
        maxLength={HANDLE_MAX}
        value={v.handle}
        help={`${strip(props.origin)}/u/your-handle`}
        spellCheck={false}
        autoCapitalize="none"
        inputClassName="font-mono"
        autoFocus={focus === 'handle'}
        error={errors.handle}
      />
      <Field id="profile-bio" name="bio" label="Bio" maxLength={BIO_MAX} value={v.bio} help={`Up to ${BIO_MAX} characters.`} />
      <Field
        id="profile-website"
        name="website"
        label="Website"
        type="url"
        inputMode="url"
        maxLength={WEBSITE_MAX}
        value={v.website}
        placeholder="https://"
        spellCheck={false}
        autoCapitalize="none"
        autoFocus={focus === 'website'}
        error={errors.website}
      />
      <Field
        id="profile-x"
        name="x_handle"
        label="X username"
        maxLength={120}
        value={v.xHandle}
        placeholder="@"
        spellCheck={false}
        autoCapitalize="none"
        autoFocus={focus === 'x'}
        error={errors.xHandle}
      />
      <FormActions submitLabel="Save profile" cancel="/share" />
    </form>
  );
}
