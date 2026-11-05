/**
 * Landing page (GET /). Owner: Experience (pages). Copy and order: design/brief.md §2–3.
 *
 * One idea per section, one action on the page ("See your MRR"). The product is shown, not
 * described: the hero is followed by the real dashboard components fed with demo data, and the
 * setup section renders the real Stripe key guide from the provider registry.
 *
 * Personality lives in the hero, the owl and the footer only. "What we store" stays literal.
 * The founder note and pricing render only once FOUNDER_NOTE / PRICING hold real content:
 * nothing invented ships.
 */

import type { Child } from 'hono/jsx';
import type { DashboardData } from '../../data/types';
import { getProviderMeta } from '../../providers/registry';
import { RevenueChart } from '../charts/revenue-chart';
import { ProviderDot } from '../components/badges';
import { BreakdownTable } from '../components/breakdown-table';
import { KeyGuide } from '../components/connection-form';
import { IconCheck } from '../components/icons';
import { Owl } from '../components/mascot';
import { RangeTabs } from '../components/range-tabs';
import { Card, LinkButton } from '../components/ui';
import { Layout, type PageChrome } from '../layout';
import { KpiStrip } from './dashboard';

export interface LandingPageProps {
  chrome: PageChrome;
  /** False when ALLOW_SIGNUP=false: the one action becomes "Log in". */
  signupOpen: boolean;
  /** Demo numbers for the live dashboard preview (view fixtures, dated to today). */
  demo: DashboardData;
  /** How often connections sync, in words ("every hour"). */
  cadence: string;
}

/**
 * [NEEDS REAL DATA] Fill in to show the founder note. Five sentences, first person, real
 * products and providers only (design/brief.md §3.1.4).
 */
const FOUNDER_NOTE: { paragraphs: string[]; name: string; role: string } | null = null;

/**
 * [NEEDS REAL DATA] Fill in to show pricing. Exact prices with currency and tax treatment; no
 * "starting at", strikethroughs or countdowns (design/brief.md §3.1.5).
 */
const PRICING: { plan: string; price: string; includes: string }[] | null = null;

const SECTION = 'mx-auto mt-28 max-w-[40rem] sm:mt-32';
const H2 = 'text-2xl leading-[1.875rem] font-semibold tracking-[-0.02em] sm:text-[1.75rem] sm:leading-[2.125rem]';
const LEAD = 'mt-3 text-pretty text-base-content/70 sm:text-lg sm:leading-7';

/** Keeps brand names whole and "= one MRR" together when the headline wraps. */
const NB = ' ';

export function LandingPage(props: LandingPageProps) {
  const cta = props.signupOpen ? { href: '/signup', label: 'See your MRR' } : { href: '/login', label: 'Log in' };
  const stripe = getProviderMeta('stripe');
  const lemon = getProviderMeta('lemonsqueezy');
  const revenuecat = getProviderMeta('revenuecat');
  const demo = props.demo;

  return (
    <Layout
      {...props.chrome}
      title="One MRR for Stripe, Lemon Squeezy and RevenueCat"
      description="See your total MRR, ARR, subscriptions and trials from Stripe, Lemon Squeezy and RevenueCat on one dashboard, in your currency. Read-only."
      marketing
      footerNote={`Syncs ${props.cadence}, so you can check less often.`}
    >
      {/* 1. Hero */}
      <section class="mx-auto max-w-[40rem] pt-6 text-center sm:pt-14">
        <h1 class="text-[2.125rem] leading-10 font-semibold tracking-[-0.025em] sm:text-5xl sm:leading-[3.25rem]">
          Stripe + Lemon{NB}Squeezy + RevenueCat ={NB}one{NB}MRR.
        </h1>
        <p class="mx-auto mt-5 max-w-[36rem] text-lg leading-7 text-pretty text-base-content/70">
          A revenue dashboard for founders who sell in more than one place. It only ever reads. You can close the other
          three tabs.
        </p>
        <div class="mt-8">
          <LinkButton href={cta.href} class="h-11 px-5 text-base">
            {cta.label}
          </LinkButton>
        </div>
        {props.signupOpen ? (
          <p class="mt-3 text-sm text-base-content/70">No key handy? Start with demo data after you sign up.</p>
        ) : null}
      </section>

      {/* 1b. The real dashboard, demo numbers. The owl sits on its top edge. */}
      <section id="demo" aria-labelledby="demo-title" class="mt-28 scroll-mt-6 sm:mt-32">
        <div class="relative rounded-box border border-base-300 bg-base-200 p-3 sm:p-5">
          <Owl pose="perched" eager class="absolute right-6 bottom-full sm:right-10" />
          <div class="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 sm:mb-4">
            <h2 id="demo-title" class="font-semibold">
              Dashboard <span class="font-normal text-base-content/70">· demo data</span>
            </h2>
            <RangeTabs current={demo.rangeDays} basePath="/" anchor="demo" />
          </div>
          <KpiStrip data={demo} class="bg-base-100" />
          <div class="mt-3 grid gap-3 sm:mt-4 sm:gap-4">
            <Card title="Revenue" description={`Charges minus refunds per day, before fees. Last ${demo.rangeDays} days.`} class="bg-base-100">
              <RevenueChart series={demo.revenueSeries} connections={demo.breakdown} currency={demo.currency} />
            </Card>
            <Card title="By connection" class="bg-base-100">
              <BreakdownTable rows={demo.breakdown} currency={demo.currency} rangeDays={demo.rangeDays} />
            </Card>
          </div>
        </div>
      </section>

      {/* 2. Setup */}
      <section aria-labelledby="setup-title" class={SECTION}>
        <h2 id="setup-title" class={H2}>
          Setup is one key.
        </h2>
        <p class={LEAD}>
          Make a read-only key in Stripe, paste it here, and your numbers show up a few seconds later. The first sync
          pulls 90 days of history.
        </p>
        <div class="mt-8">
          <KeyGuide meta={stripe} headingId="landing-key-guide" preview />
        </div>
        <ul class="mt-8 space-y-3" aria-label="What each provider's key can do">
          <li class="flex gap-3">
            <ProviderDot dotClass={stripe.dotClass} size="md" class="mt-1.5" />
            <span>
              <span class="font-semibold">Stripe:</span> restricted key, read-only.
            </span>
          </li>
          <li class="flex gap-3">
            <ProviderDot dotClass={revenuecat.dotClass} size="md" class="mt-1.5" />
            <span>
              <span class="font-semibold">RevenueCat:</span> v2 secret key with read-only scopes.
            </span>
          </li>
          <li class="flex gap-3">
            <ProviderDot dotClass={lemon.dotClass} size="md" class="mt-1.5" />
            <span>
              <span class="font-semibold">Lemon Squeezy:</span> API key. Lemon Squeezy keys can’t be limited to
              read-only, so this one has full access. hoomuch only reads with it.
            </span>
          </li>
        </ul>
      </section>

      {/* 3. What we store (literal) */}
      <section aria-labelledby="store-title" class={SECTION}>
        <h2 id="store-title" class={H2}>
          What hoomuch keeps, and what it doesn’t.
        </h2>
        <div class="mt-8 grid gap-8 sm:grid-cols-2">
          <div>
            <h3 class="font-semibold">Stored</h3>
            <ul class="mt-3 space-y-2.5 text-base-content/70">
              <StoreItem>
                Your API keys, encrypted with <span class="whitespace-nowrap">AES-256-GCM</span>
              </StoreItem>
              <StoreItem>Amounts, currencies, dates and plan names</StoreItem>
              <StoreItem>A daily snapshot of MRR, subscriptions and trials</StoreItem>
            </ul>
          </div>
          <div>
            <h3 class="font-semibold">Never stored</h3>
            <ul class="mt-3 space-y-2.5 text-base-content/70">
              <StoreItem never>Your customers’ names or email addresses</StoreItem>
              <StoreItem never>Card details</StoreItem>
              <StoreItem never>Your password. Only a PBKDF2 hash of it.</StoreItem>
            </ul>
          </div>
        </div>
        <p class="mt-8 text-base-content/70">
          Syncs run {props.cadence}. Currencies convert at the European Central Bank’s daily rates. Deleting your account
          deletes your keys and every synced number, immediately.
        </p>
      </section>

      {/* 4. Founder note: only with real content */}
      {FOUNDER_NOTE ? (
        <section aria-labelledby="founder-title" class={SECTION}>
          <h2 id="founder-title" class={H2}>
            Why this exists
          </h2>
          {FOUNDER_NOTE.paragraphs.map((p) => (
            <p class="mt-4 sm:text-lg sm:leading-7">{p}</p>
          ))}
          <p class="mt-6 text-sm text-base-content/70">
            <span class="font-semibold text-base-content">{FOUNDER_NOTE.name}</span>, {FOUNDER_NOTE.role}
          </p>
        </section>
      ) : null}

      {/* 5. Pricing (literal): only with real numbers */}
      {PRICING ? (
        <section aria-labelledby="pricing-title" class={SECTION}>
          <h2 id="pricing-title" class={H2}>
            Pricing
          </h2>
          <dl class="mt-8 divide-y divide-base-300 border-y border-base-300">
            {PRICING.map((p) => (
              <div class="grid gap-1 py-5 sm:grid-cols-[10rem_1fr] sm:gap-6">
                <dt class="font-semibold">
                  {p.plan}
                  <span class="block font-normal tabular-nums">{p.price}</span>
                </dt>
                <dd class="text-base-content/70">{p.includes}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {/* 6. Last call */}
      {props.signupOpen ? (
        <section aria-labelledby="last-title" class={`${SECTION} mb-8 text-center sm:mb-12`}>
          <h2 id="last-title" class={H2}>
            One number. Every store.
          </h2>
          <div class="mt-6">
            <LinkButton href={cta.href} class="h-11 px-5 text-base">
              {cta.label}
            </LinkButton>
          </div>
        </section>
      ) : null}
    </Layout>
  );
}

function StoreItem(props: { never?: boolean; children?: Child }) {
  return (
    <li class="flex gap-2.5">
      {props.never ? (
        <span aria-hidden="true" class="mt-0.5 flex size-5 shrink-0 items-center justify-center text-base-content/60">
          ×
        </span>
      ) : (
        <IconCheck class="mt-1 size-4 shrink-0 text-base-content/70" />
      )}
      <span>{props.children}</span>
    </li>
  );
}
