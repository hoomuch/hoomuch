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

import { Check, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Frame } from '@/components/ui/frame';
import type { DashboardData } from '../../data/types';
import { getProviderMeta } from '../../providers/registry';
import { ProviderDot } from '../components/badges';
import { BreakdownTable } from '../components/breakdown-table';
import { KeyGuide } from '../components/connection-form';
import { HorizonGlow } from '../components/horizon-glow';
import { Owl } from '../components/mascot';
import { RangeTabs } from '../components/range-tabs';
import { Card, LinkButton } from '../components/ui';
import { Layout, type PageChrome } from '../layout';
import { MrrCard, RevenueCard, SecondaryStats } from './dashboard';

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
const H2 = 'font-heading text-section-sm sm:text-section';
const LEAD = 'mt-3 text-pretty text-lead text-muted-foreground';

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
      {/* 1. Hero. Seen once, on a first visit, so its lines rise in one after another (60ms
          apart, done in about half a second). The demo below stays put: it's the product. */}
      <section className="mx-auto max-w-[40rem] pt-6 text-center sm:pt-14">
        <h1 className="rise-in font-heading text-hero-sm sm:text-hero">
          Stripe + Lemon{NB}Squeezy + RevenueCat ={NB}one{NB}MRR.
        </h1>
        <p className="rise-in mx-auto mt-5 max-w-[36rem] text-lead text-pretty text-muted-foreground [animation-delay:60ms]">
          A revenue dashboard for founders who sell in more than one place. It only ever reads. You can close the other
          three tabs.
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
            <RangeTabs current={demo.rangeDays} basePath="/" anchor="demo" />
          </div>
          {/* Same pieces, same order as /dashboard. */}
          <MrrCard data={demo} />
          <SecondaryStats data={demo} className="mt-3 sm:mt-4" />
          <div className="mt-3 grid gap-3 sm:mt-4 sm:gap-4">
            <Card title="By connection" bodyClassName="px-2 pb-3 sm:px-3 sm:pb-4">
              <BreakdownTable rows={demo.breakdown} currency={demo.currency} rangeDays={demo.rangeDays} />
            </Card>
            <RevenueCard data={demo} />
          </div>
        </Frame>
      </section>

      {/* 2. Setup */}
      <section aria-labelledby="setup-title" className={SECTION}>
        <h2 id="setup-title" className={H2}>
          Setup is one key.
        </h2>
        <p className={LEAD}>
          Make a read-only key in Stripe, paste it here, and your numbers show up a few seconds later. The first sync
          pulls 90 days of history.
        </p>
        <div className="mt-8">
          <KeyGuide meta={stripe} headingId="landing-key-guide" preview />
        </div>
        <ul className="mt-8 space-y-3 text-lead" aria-label="What each provider's key can do">
          <li className="flex gap-3">
            <ProviderDot dotClass={stripe.dotClass} size="md" className="mt-2.5" />
            <span>
              <span className="font-semibold">Stripe:</span> restricted key, read-only.
            </span>
          </li>
          <li className="flex gap-3">
            <ProviderDot dotClass={revenuecat.dotClass} size="md" className="mt-2.5" />
            <span>
              <span className="font-semibold">RevenueCat:</span> v2 secret key with read-only scopes.
            </span>
          </li>
          <li className="flex gap-3">
            <ProviderDot dotClass={lemon.dotClass} size="md" className="mt-2.5" />
            <span>
              <span className="font-semibold">Lemon Squeezy:</span> API key. Lemon Squeezy keys can’t be limited to
              read-only, so this one has full access. hoomuch only reads with it.
            </span>
          </li>
        </ul>
      </section>

      {/* 3. What we store (literal) */}
      <section aria-labelledby="store-title" className={SECTION}>
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
          Syncs run {props.cadence}. Currencies convert at the European Central Bank’s daily rates. Deleting your account
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

      {/* 5. Pricing (literal): only with real numbers */}
      {PRICING ? (
        <section aria-labelledby="pricing-title" className={SECTION}>
          <h2 id="pricing-title" className={H2}>
            Pricing
          </h2>
          <dl className="mt-8 divide-y border-y text-lead">
            {PRICING.map((p) => (
              <div key={p.plan} className="grid gap-1 py-5 sm:grid-cols-[10rem_1fr] sm:gap-6">
                <dt className="font-semibold">
                  {p.plan}
                  <span className="block font-normal tabular-nums">{p.price}</span>
                </dt>
                <dd className="text-muted-foreground">{p.includes}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {/* 6. Last call */}
      {props.signupOpen ? (
        <section aria-labelledby="last-title" className={`${SECTION} mb-8 text-center sm:mb-12`}>
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
