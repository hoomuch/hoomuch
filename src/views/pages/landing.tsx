/**
 * Landing page (GET /). Owner: Experience (pages). Copy and order: design/brief.md §2–3.
 *
 * One idea per section, one action on the page ("See your MRR"). The product is shown, not
 * described: the hero is followed by the real dashboard components fed with demo data, and the
 * setup section renders the real Stripe key guide from the provider registry.
 *
 * Personality lives in the hero, the owl and the footer only. "What we store" stays literal.
 * The founder note renders only once FOUNDER_NOTE holds real content: nothing invented ships.
 * Pricing shows only while sign-up is open, so a private instance doesn't advertise hoomuch.com.
 */

import { Check, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Frame } from '@/components/ui/frame';
import type { ExploreItem } from '../../data/explore';
import type { DashboardData } from '../../data/types';
import { formatMoney } from '../../lib/money';
import { getProviderMeta, PROVIDERS } from '../../providers/registry';
import type { RevenueVariant } from '../charts/revenue-chart';
import { BreakdownTable } from '../components/breakdown-table';
import { KeyGuide } from '../components/connection-form';
import { HorizonGlow } from '../components/horizon-glow';
import { Owl } from '../components/mascot';
import { ProductCard as PublicProductCard } from '../components/product-card';
import { ProviderStrip } from '../components/provider-strip';
import { RangeTabs } from '../components/range-tabs';
import { Card, LinkButton } from '../components/ui';
import { Layout, type PageChrome } from '../layout';
import { MrrCard, ProductCard, RevenueCard, SecondaryStats } from './dashboard';

export interface LandingPageProps {
  chrome: PageChrome;
  /** False when ALLOW_SIGNUP=false: the one action becomes "Log in". */
  signupOpen: boolean;
  /** Demo numbers for the live dashboard preview (view fixtures, dated to today). */
  demo: DashboardData;
  /** The demo's revenue chart (`?revenue=`, not remembered). Default: bars. */
  revenueVariant?: RevenueVariant;
  /** How often connections sync, in words ("every hour"). */
  cadence: string;
  /**
   * Products on Explore (SPEC F-23): the fastest growing, or the biggest when too few have grown.
   * Null until enough real products qualify, so the page never shows a sparse or made-up gallery.
   */
  gallery?: { kind: 'growth' | 'mrr'; items: ExploreItem[] } | null;
}

/**
 * [NEEDS REAL DATA] Fill in to show the founder note. Five sentences, first person, real
 * products and providers only (design/brief.md §3.1.4).
 */
const FOUNDER_NOTE: { paragraphs: string[]; name: string; role: string } | null = null;

/**
 * hoomuch.com's plans. Exact prices with currency and tax treatment; no "starting at",
 * strikethroughs or countdowns (design/brief.md §3.1.5).
 */
const PRICING: { plan: string; price: string; includes: string }[] = [
  {
    plan: 'Under $1,000 MRR',
    price: 'Free',
    includes:
      'Every provider and every feature on hoomuch.com, with no limit on connections. Free during the beta and after it.',
  },
  {
    plan: '$1,000 MRR and up',
    price: '$9 per month',
    includes:
      'Free while the beta lasts, with no card needed. After it, $9 per month or $90 per year, plus VAT or sales tax where it applies. We email you 30 days before the beta ends.',
  },
  {
    plan: 'Self-host',
    price: 'Free',
    includes:
      'Every feature, on your own Cloudflare account. Open source under AGPL-3.0. Cloudflare’s Workers Paid plan ($5 per month) is recommended for production.',
  },
];

const SECTION = 'mx-auto mt-28 max-w-[40rem] sm:mt-32';
const H2 = 'font-heading text-section-sm sm:text-section';
const LEAD = 'mt-3 text-pretty text-lead text-muted-foreground';

/** Every provider a visitor can connect (the demo isn't one). */
const PROVIDER_COUNT = PROVIDERS.filter((p) => p.id !== 'demo').length;

/** Keeps brand names whole and "= one MRR" together when the headline wraps. */
const NB = ' ';

export function LandingPage(props: LandingPageProps) {
  const cta = props.signupOpen ? { href: '/signup', label: 'See your MRR' } : { href: '/login', label: 'Log in' };
  const stripe = getProviderMeta('stripe');
  const demo = props.demo;
  // The demo's revenue chart, switched in place: the range tabs carry it, as nothing remembers it here.
  const [revenueVariant, setRevenueVariant] = useState(props.revenueVariant ?? 'bars');

  return (
    <Layout
      {...props.chrome}
      // What people search first, the brand last (the layout appends it): 61 characters in all,
      // so the result shows it whole. The description names the rest of the stack (design/brief.md §3.1).
      title="MRR dashboard for Stripe, RevenueCat and app stores"
      description="Total MRR, ARR, subscriptions and trials from Stripe, Paddle, Lemon Squeezy, RevenueCat, the App Store, Google Play and more. Read-only and open source."
      marketing
      footerNote={`Syncs ${props.cadence}, so you can check less often.`}
    >
      {/* 1. Hero. Seen once, on a first visit, so its lines rise in one after another (60ms
          apart, done in about half a second). The demo below stays put: it's the product. */}
      <section className="mx-auto max-w-[40rem] pt-6 text-center sm:pt-14">
        <h1 className="rise-in font-heading text-hero-sm sm:text-hero">Every store you sell in. One{NB}MRR.</h1>
        <p className="rise-in mx-auto mt-5 max-w-[36rem] text-lead text-pretty text-muted-foreground [animation-delay:60ms]">
          A revenue dashboard for founders who sell in more than one place. It only ever reads. You can close the other
          tabs.
        </p>
        <div className="rise-in mt-8 [animation-delay:120ms]">
          <LinkButton href={cta.href} large>
            {cta.label}
          </LinkButton>
        </div>
        {props.signupOpen ? (
          <p className="rise-in mt-3 text-body text-muted-foreground [animation-delay:180ms]">No key handy? Start with demo data after you sign up.</p>
        ) : null}
      </section>

      {/* 1a. Every provider, from the registry, in one slow loop (the page's only one). */}
      <ProviderStrip className="mx-auto mt-16 max-w-[48rem] sm:mt-20" />

      {/* 1b. The real dashboard, demo numbers. The owl sits on its top edge, and a dotted sun
          (Dither Field shader) rises behind it. */}
      <section id="demo" aria-labelledby="demo-title" className="relative mt-28 scroll-mt-6 sm:mt-32">
        <HorizonGlow className="inset-x-0 -top-32 h-32 sm:-top-36 sm:h-36" />
        <Frame className="relative border p-2 sm:p-4">
          <Owl pose="perched" eager className="absolute right-6 bottom-full sm:right-10" />
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 sm:mb-4">
            <h2 id="demo-title" className="font-semibold">
              Dashboard <span className="font-normal text-muted-foreground">· demo data</span>
            </h2>
            <RangeTabs current={demo.rangeDays} basePath="/" anchor="demo" keep={revenueVariant === 'line' ? 'revenue=line' : undefined} />
          </div>
          {/* Same pieces, same order as /dashboard, up to the calendar (it has no demo month):
              the list under the frame names it instead. */}
          <MrrCard data={demo} />
          <SecondaryStats data={demo} className="mt-3 sm:mt-4" />
          <div className="mt-3 grid gap-3 sm:mt-4 sm:gap-4">
            <Card title="By connection" bodyClassName="px-2 pb-3 sm:px-3 sm:pb-4">
              <BreakdownTable rows={demo.breakdown} currency={demo.currency} rangeDays={demo.rangeDays} />
            </Card>
            <ProductCard data={demo} />
            <RevenueCard data={demo} variant={props.revenueVariant} basePath="/" onVariantChange={setRevenueVariant} />
          </div>
        </Frame>
        {/* What the demo can't show. Literal: each line is a screen or a behaviour that exists. */}
        <ul className="mx-auto mt-10 grid max-w-[48rem] gap-6 text-body sm:grid-cols-3 sm:gap-8" aria-label="Also in hoomuch">
          <AlsoItem title="Any day, opened up.">
            A calendar shows each day’s revenue, refunds and MRR, store by store.
          </AlsoItem>
          <AlsoItem title="Every charge in one list.">
            Charges and refunds from all your stores together, filtered by store or by day.
          </AlsoItem>
          <AlsoItem title="Says when it’s estimating.">
            If a figure is incomplete, say a key is missing an optional permission, the dashboard tells you which and why.
          </AlsoItem>
        </ul>
      </section>

      {/* 1c. Real products, real numbers: founders who publish theirs (Explore). Only with enough of them. */}
      {props.gallery ? <Gallery gallery={props.gallery} /> : null}

      {/* 2. Setup: the same three steps for every store, then the real connect form for one of
          them. The full-access keys stay named plainly: that's the trust move (brief §3.1.2). */}
      <section aria-labelledby="setup-title" className={SECTION}>
        <h2 id="setup-title" className={H2}>
          Setup is one key per store.
        </h2>
        <p className={LEAD}>
          No SDK and no code: hoomuch reads each store’s own API, and your numbers show up after the first sync.
        </p>
        <ol className="mt-8 space-y-5 text-lead">
          <SetupStep n={1} title="Pick a store.">
            Any of the {PROVIDER_COUNT} above. Add one for each place you sell.
          </SetupStep>
          <SetupStep n={2} title="Make the narrowest key it offers.">
            The connect form shows where to make it and exactly which read permissions to grant. Lemon{NB}Squeezy,
            Gumroad and Adapty keys can’t be limited to read-only, so they have full access, and hoomuch only reads with
            them.
          </SetupStep>
          <SetupStep n={3} title="Paste it.">
            It’s checked live, then saved encrypted. The first sync pulls 90 days of history.
          </SetupStep>
        </ol>
        <p className="mt-10 text-body text-muted-foreground">Here’s the connect form for Stripe:</p>
        <div className="mt-3">
          <KeyGuide meta={stripe} headingId="landing-key-guide" preview />
        </div>
      </section>

      {/* 3. What we store (literal) */}
      <section id="store" aria-labelledby="store-title" className={`${SECTION} scroll-mt-6`}>
        <h2 id="store-title" className={H2}>
          What hoomuch keeps, and what it doesn’t.
        </h2>
        <div className="mt-8 grid gap-8 sm:grid-cols-2">
          <div>
            <h3 className="text-lead font-semibold">Stored</h3>
            <ul className="mt-3 space-y-2.5 text-lead text-muted-foreground">
              <StoreItem>
                Your API keys, encrypted with <span className="whitespace-nowrap">AES-256-GCM</span>
              </StoreItem>
              <StoreItem>Amounts, currencies, dates and plan names</StoreItem>
              <StoreItem>A daily snapshot of MRR, subscriptions and trials</StoreItem>
            </ul>
          </div>
          <div>
            <h3 className="text-lead font-semibold">Never stored</h3>
            <ul className="mt-3 space-y-2.5 text-lead text-muted-foreground">
              <StoreItem never>Your customers’ names or email addresses</StoreItem>
              <StoreItem never>Card details</StoreItem>
              <StoreItem never>Your password. Only a PBKDF2 hash of it.</StoreItem>
            </ul>
          </div>
        </div>
        <p className="mt-8 text-lead text-muted-foreground">
          Syncs run {props.cadence}, and about a minute after a new subscription or refund where you turn on webhooks.
          Currencies convert at the European Central Bank’s daily rates. Deleting your account
          deletes your keys and every synced number, immediately.
        </p>
      </section>

      {/* 4. Founder note: only with real content */}
      {FOUNDER_NOTE ? (
        <section aria-labelledby="founder-title" className={SECTION}>
          <h2 id="founder-title" className={H2}>
            Why this exists
          </h2>
          {FOUNDER_NOTE.paragraphs.map((p) => (
            <p key={p} className="mt-4 text-lead">
              {p}
            </p>
          ))}
          <p className="mt-6 text-body text-muted-foreground">
            <span className="font-semibold text-foreground">{FOUNDER_NOTE.name}</span>, {FOUNDER_NOTE.role}
          </p>
        </section>
      ) : null}

      {/* 5. Pricing (literal): hoomuch.com's plans, so only where anyone can sign up */}
      {props.signupOpen ? (
        <section aria-labelledby="pricing-title" className={SECTION}>
          <h2 id="pricing-title" className={H2}>
            Free until your MRR reaches $1,000.
          </h2>
          <dl className="mt-8 divide-y border-y text-lead">
            {PRICING.map((p) => (
              <div key={p.plan} className="grid gap-1 py-5 sm:grid-cols-[12rem_1fr] sm:gap-6">
                <dt className="font-semibold">
                  {p.plan}
                  <span className="block font-normal tabular-nums">{p.price}</span>
                </dt>
                <dd className="text-pretty text-muted-foreground">{p.includes}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {/* 6. Last call */}
      {props.signupOpen ? (
        <section aria-labelledby="last-title" className={`${SECTION} text-center`}>
          <h2 id="last-title" className={H2}>
            One number. Every store.
          </h2>
          <div className="mt-6">
            <LinkButton href={cta.href} large>
              {cta.label}
            </LinkButton>
          </div>
        </section>
      ) : null}
    </Layout>
  );
}

/** One thing the demo can't show: what it is in bold, then one line. */
function AlsoItem(props: { title: string; children?: ReactNode }) {
  return (
    <li>
      <p className="font-semibold">{props.title}</p>
      <p className="mt-1 text-pretty text-muted-foreground">{props.children}</p>
    </li>
  );
}

/** One setup step: a numbered circle (the <ol> already says the order), the step, then the detail. */
function SetupStep(props: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-4">
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-full border text-body font-semibold tabular-nums"
      >
        {props.n}
      </span>
      <p>
        <span className="font-semibold">{props.title}</span> <span className="text-muted-foreground">{props.children}</span>
      </p>
    </li>
  );
}

function StoreItem(props: { never?: boolean; children?: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      {props.never ? (
        <X className="mt-1.5 size-4 shrink-0 text-faint" />
      ) : (
        <Check className="mt-1.5 size-4 shrink-0 text-success" />
      )}
      <span>{props.children}</span>
    </li>
  );
}

const usd = (minor: number) => formatMoney(minor, 'USD', { whole: true });

/** Founders' published products, as cards to their pages, and the way to the rest. */
function Gallery(props: { gallery: NonNullable<LandingPageProps['gallery']> }) {
  const growth = props.gallery.kind === 'growth';
  return (
    <section aria-labelledby="gallery-title" className="mt-28 sm:mt-32">
      <div className="mx-auto max-w-[40rem] text-center">
        <h2 id="gallery-title" className={H2}>
          {growth ? 'Growing this month' : 'Founders who show their numbers'}
        </h2>
        <p className={LEAD}>
          {growth
            ? 'Products whose founders publish their revenue on hoomuch, by how much their MRR grew in 30 days. Every figure is read from the payment provider.'
            : 'Products whose founders publish their revenue on hoomuch. Every figure is read from the payment provider, none is typed in.'}
        </p>
      </div>
      <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {/* Three on a phone, so the strip stays a glance; the rest are a tap away on Explore. */}
        {props.gallery.items.map((it, i) => (
          <li key={it.slug} className={i >= 3 ? 'hidden min-w-0 sm:block' : 'min-w-0'}>
            <PublicProductCard
              href={`/p/${it.slug}`}
              name={it.name}
              tagline={it.tagline}
              byline={`by ${it.founder.name}`}
              figures={[
                { label: 'MRR', value: usd(it.mrr), deltaPct: it.growthPct },
                { label: 'Revenue, 30d', value: usd(it.revenue30) },
              ]}
              providers={it.providers}
            />
          </li>
        ))}
      </ul>
      <div className="mt-8 text-center">
        <LinkButton href="/explore" variant="secondary">
          See every product on Explore
        </LinkButton>
      </div>
    </section>
  );
}
