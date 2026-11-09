/**
 * Share (GET /share, /share/profile, /share/new, /share/products/:id[/edit]; SPEC F-21/F-22): the
 * owner's public pages. Owner: Experience (pages).
 *
 * Laid out like a profile on a social network: the founder on top (photo or initials, name, @handle, bio,
 * links, what's public) with Edit profile beside the name and the profile's link with one-tap posts
 * under it; the products below as a list. A product's view leads with sharing it (link, posts,
 * badge) or, while it's a draft, with publishing it; its details, unpublish and delete wait behind
 * Edit. Every action is a plain POST form. Nothing is public until the owner ticks the confirmation
 * and publishes.
 */

import { ArrowUpRight, ChevronRight, Link2, Pencil, Plus, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button as CossButton } from '@/components/ui/button';
import { Card as CossCard } from '@/components/ui/card';
import type { ProviderId } from '../../providers/types';
import { formatMoney } from '../../lib/money';
import { cn } from '../../lib/utils';
import { BIO_MAX, DISPLAY_NAME_MAX, HANDLE_MAX, NAME_MAX, SLUG_MAX, TAGLINE_MAX, WEBSITE_MAX } from '../../lib/public-pages';
import { Avatar, ProductTile } from '../components/avatar';
import { CopyField } from '../components/copy-field';
import { ImageUploadCard } from '../components/image-upload';
import { EmptyState } from '../components/empty-state';
import { XMark } from '../components/icons';
import { ProviderLogo } from '../components/provider-logos';
import { RelativeTime } from '../components/relative-time';
import { ShareSheet } from '../components/share-sheet';
import { Button, Card, CheckboxOption, ConfirmCheckbox, Field, FormError, LinkButton, PageHeader, TextLink } from '../components/ui';
import { Layout, type PageChrome } from '../layout';

interface ShareProduct {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  website: string | null;
  connectionIds: string[];
  published: boolean;
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
  connections: string[];
}

export interface ShareFormErrors {
  name?: string;
  slug?: string;
  website?: string;
  connections?: string;
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
 * (/share/new), a product's own view (/share/products/:id) and its form (/share/products/:id/edit).
 */
export type ShareView =
  | { kind: 'overview' }
  | { kind: 'profile' }
  | { kind: 'new' }
  | { kind: 'product'; id: string }
  | { kind: 'edit'; id: string };

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
  /** A failed create or edit, re-rendered with 422. `productId` null is the new-product form. */
  form?: { productId: string | null; values: ShareFormValues; error?: string | null; fieldErrors?: ShareFormErrors };
  /** The founder profile (SPEC F-22), null before they save one; publishing a product needs it. */
  profile?: Profile | null;
  /** A failed profile save, re-rendered with 422. */
  profileForm?: { values: ProfileFormValues; error?: string | null; fieldErrors?: ProfileFormErrors };
}

export function SharePage(props: SharePageProps) {
  const view = props.view ?? { kind: 'overview' };
  const product = view.kind === 'product' || view.kind === 'edit' ? props.products.find((p) => p.id === view.id) : undefined;
  const error = Boolean(props.form || props.profileForm);
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
                <span className={cn('block truncate text-caption', !p.published && p.mrr !== null ? 'text-brand' : 'text-muted-foreground')}>
                  {p.published ? `${strip(props.origin)}/p/${p.slug}` : p.mrr !== null ? 'Ready to publish' : 'Waiting for its first sync'}
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
            <Card title="Badge" description="For your site or README. It links to the page.">
              <BadgeCopy product={p} origin={props.origin} />
            </Card>
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
        ) : (
          <Card
            title="Publish"
            description={p.mrr !== null && props.profile ? `Its page will show ${usd(p.mrr)} MRR, as checked by hoomuch.` : undefined}
          >
            <PublishForm product={p} hasProfile={Boolean(props.profile)} />
          </Card>
        )}
      </div>
    </>
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
            values={failed?.values ?? { name: p.name, slug: p.slug, tagline: p.tagline ?? '', website: p.website ?? '', connections: p.connectionIds }}
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
  const where =
    p.logoSource === 'upload'
      ? 'Your own logo.'
      : p.logoSource === 'site'
        ? 'Your website’s icon. Upload your own to use that instead.'
        : p.website
          ? 'Initials for now: your website has no icon hoomuch can use yet. Upload a logo, or try the icon again.'
          : 'Initials for now. Upload a logo, or add the product’s website below and its icon is used.';
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
            {p.website && p.logoSource !== 'site' ? (
              <form method="post" action={`${base}/site`}>
                <Button variant="ghost" small busyLabel="Fetching…">
                  Use your website’s icon
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
}) {
  const v = props.values;
  const errors = props.failed?.fieldErrors ?? {};
  const formError = props.failed && Object.keys(errors).length === 0 ? props.failed.error : null;
  const focus = formError ? 'form' : errors.name ? 'name' : errors.slug ? 'slug' : errors.website ? 'website' : null;
  const id = (name: string) => `${props.idPrefix}-${name}`;
  const picked = new Set(v?.connections ?? []);
  const rows = props.connections.map((c) => ({
    c,
    elsewhere: c.productId !== null && c.productId !== props.productId ? (props.productName.get(c.productId) ?? 'another product') : undefined,
  }));
  const free = rows.filter((r) => r.elsewhere === undefined);
  const taken = rows.filter((r) => r.elsewhere !== undefined);
  return (
    <form method="post" action={props.action}>
      <FormError message={formError} autoFocus={focus === 'form'} />
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
