/**
 * The pages around the landing page: one per integration, guides for combining stores, verified
 * revenue pages, self-hosting and comparisons. Owner: Experience (pages).
 *
 * Literal pages, like "What we store": what hoomuch does with each store, in the words of SPEC §6
 * (views/content/). Nothing here is invented for search engines, and every page has one action.
 * They render without the visitor's session, like Explore, so one response can be cached for
 * everyone (routes/marketing.tsx); a signed-in browser finds its way back after hydration.
 */

import type { ReactNode } from 'react';
import { getProviderMeta } from '../../providers/registry';
import { ProviderLogo } from '../components/provider-logos';
import { KeyGuide } from '../components/connection-form';
import { LinkButton, TextLink } from '../components/ui';
import { COMPARISONS, type Comparison } from '../content/compare';
import { INTEGRATION_GUIDES, PAIR_GUIDES, type IntegrationGuide, type PairGuide } from '../content/integrations';
import { articleJsonLd, type Crumb } from '../json-ld';
import { Layout, type PageChrome } from '../layout';
import { useSignedIn } from '../use-signed-in';

/** What every page here gets from its route. */
interface MarketingProps {
  chrome: PageChrome;
  /** The page's absolute URL (canonical, link previews, structured data). */
  url: string;
  /** Its link preview image, absolute. */
  image: string;
  /** Sign-up is open on this instance: the action is "See your MRR", else "Log in". */
  signupOpen: boolean;
}

const H2 = 'font-heading text-section-sm';
const LEAD = 'mt-4 max-w-[40rem] text-lead text-pretty text-muted-foreground';
const PROSE = 'grid gap-3 text-lead text-pretty text-muted-foreground';
const SECTION = 'mt-14 max-w-[40rem]';

/** A guide by its slug, or undefined: the route already 404s an unknown one. */
export const integrationBySlug = (slug: string) => INTEGRATION_GUIDES.find((g) => g.slug === slug);
export const guideBySlug = (slug: string) => PAIR_GUIDES.find((g) => g.slug === slug);
export const comparisonBySlug = (slug: string) => COMPARISONS.find((c) => c.slug === slug);

/** The RevenueCat + Stripe guide is worth a link from these stores' pages. */
const PAIR_LINKED: Record<string, readonly string[]> = {
  'revenuecat-and-stripe': ['revenuecat', 'stripe', 'appstore', 'googleplay', 'adapty', 'superwall'],
};

// ---------- the frame every page shares ----------

function Breadcrumbs(props: { trail: Crumb[] }) {
  const last = props.trail.length - 1;
  return (
    <nav aria-label="Breadcrumb" className="mb-6 text-body text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <li>
          <a href="/" className="rounded-md transition-colors hover:text-foreground">
            hoomuch
          </a>
        </li>
        {props.trail.map(([name, path], i) => (
          <li key={path} className="flex items-center gap-2">
            <span aria-hidden="true" className="text-faint">
              /
            </span>
            {i === last ? (
              <span aria-current="page" className="text-foreground">
                {name}
              </span>
            ) : (
              <a href={path} className="rounded-md transition-colors hover:text-foreground">
                {name}
              </a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The one action, at the end of every page: sign up, or log in where sign-up is closed. */
function CallToAction(props: { signupOpen: boolean; label?: string; next?: string; note?: string }) {
  const signedIn = useSignedIn();
  const next = props.next ? `?next=${encodeURIComponent(props.next)}` : '';
  const action = signedIn
    ? { href: props.next ?? '/dashboard', label: props.next ? 'Open Share' : 'Open your dashboard' }
    : props.signupOpen
      ? { href: `/signup${next}`, label: props.label ?? 'See your MRR' }
      : { href: `/login${next}`, label: 'Log in' };
  return (
    <section aria-labelledby="cta-title" className="mt-20 max-w-[40rem] border-t pt-10">
      <h2 id="cta-title" className={H2}>
        One number. Every store.
      </h2>
      <p className="mt-3 text-lead text-muted-foreground">
        {/* hoomuch.com's plan, so only where anyone can sign up (like the landing page's pricing). */}
        {props.signupOpen ? (props.note ?? 'Read-only, open source, and free until your MRR reaches $1,000.') : 'Read-only and open source.'}
      </p>
      <div className="mt-6">
        <LinkButton href={action.href} large>
          {action.label}
        </LinkButton>
      </div>
    </section>
  );
}

function Article(props: {
  page: MarketingProps;
  title: string;
  description: string;
  trail: Crumb[];
  h1: ReactNode;
  lead: ReactNode;
  children?: ReactNode;
  /** `note` replaces the plan line under the heading, where sign-up is open. */
  cta?: { label?: string; next?: string; note?: string };
}) {
  const { page } = props;
  return (
    <Layout
      {...page.chrome}
      title={props.title}
      description={props.description}
      og={{ url: page.url, image: page.image }}
      jsonLd={articleJsonLd({ url: page.url, title: props.title, description: props.description, trail: props.trail })}
      marketing
    >
      <article>
        <Breadcrumbs trail={props.trail} />
        <header className="max-w-[44rem]">
          <h1 className="font-heading text-hero-sm sm:text-hero">{props.h1}</h1>
          <div className={LEAD}>{props.lead}</div>
        </header>
        {props.children}
        <CallToAction signupOpen={page.signupOpen} label={props.cta?.label} next={props.cta?.next} note={props.cta?.note} />
      </article>
    </Layout>
  );
}

function Section(props: { id: string; title: string; children?: ReactNode }) {
  return (
    <section aria-labelledby={props.id} className={SECTION}>
      <h2 id={props.id} className={H2}>
        {props.title}
      </h2>
      <div className={`mt-4 ${PROSE}`}>{props.children}</div>
    </section>
  );
}

function Paragraphs(props: { lines: readonly string[] }) {
  return (
    <>
      {props.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </>
  );
}

function Bullets(props: { items: readonly ReactNode[] }) {
  return (
    <ul className="grid list-disc gap-2 pl-5 marker:text-faint">
      {props.items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** Every integration as a link with its logo: the index's grid, and "Other integrations" below a page. */
function IntegrationGrid(props: { except?: string }) {
  return (
    <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {INTEGRATION_GUIDES.filter((g) => g.id !== props.except).map((g) => {
        const meta = getProviderMeta(g.id);
        return (
          <li key={g.id}>
            <a
              href={`/integrations/${g.slug}`}
              className="flex h-full items-start gap-3 rounded-2xl border p-4 transition-colors hover:bg-accent/50"
            >
              <ProviderLogo provider={g.id} size="md" />
              <span className="min-w-0">
                <span className="block font-semibold text-foreground">{meta.name}</span>
                <span className="mt-0.5 block text-body text-muted-foreground">{meta.tagline}</span>
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

// ---------- /integrations ----------

export type IntegrationsPageProps = MarketingProps;

export function IntegrationsPage(props: IntegrationsPageProps) {
  const count = INTEGRATION_GUIDES.length;
  return (
    <Article
      page={props}
      title={`Integrations: ${count} billing platforms and app stores`}
      description={`Read-only connections to Stripe, Paddle, Lemon Squeezy, Polar, RevenueCat, Chargebee, Dodo Payments, Gumroad, Adapty, Superwall and the app stores.`}
      trail={[['Integrations', '/integrations']]}
      h1={`${count} billing platforms and app stores. One MRR.`}
      lead={
        <p>
          Each store connects with a key you make, the narrowest one it offers, and hoomuch only ever reads with it. Here’s
          what it reads from each one, and how it counts it.
        </p>
      }
    >
      <section aria-labelledby="all-title" className="mt-12">
        <h2 id="all-title" className="sr-only">
          Every integration
        </h2>
        <IntegrationGrid />
      </section>
      <Section id="pairs-title" title="Selling in more than one place">
        <p>Every connection adds up into one MRR. A few stores report each other’s sales, so pick one source for each.</p>
        <Bullets
          items={PAIR_GUIDES.map((g) => (
            <TextLink key={g.slug} href={`/guides/${g.slug}`}>
              {g.title}
            </TextLink>
          ))}
        />
      </Section>
    </Article>
  );
}

// ---------- /integrations/<slug> ----------

export interface IntegrationPageProps extends MarketingProps {
  slug: string;
}

export function IntegrationPage(props: IntegrationPageProps) {
  const guide = integrationBySlug(props.slug) as IntegrationGuide;
  const meta = getProviderMeta(guide.id);
  const pairs = PAIR_GUIDES.filter((g) => PAIR_LINKED[g.slug]?.includes(guide.id));
  return (
    <Article
      page={props}
      title={guide.title}
      description={guide.description}
      trail={[
        ['Integrations', '/integrations'],
        [meta.name, `/integrations/${guide.slug}`],
      ]}
      h1={
        <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <ProviderLogo provider={guide.id} size="lg" />
          {meta.name} MRR dashboard
        </span>
      }
      lead={<p>{guide.summary}</p>}
    >
      <Section id="mrr-title" title="How MRR is counted">
        <Paragraphs lines={guide.mrr} />
      </Section>
      <Section id="revenue-title" title="How revenue is counted">
        <Paragraphs lines={guide.revenue} />
      </Section>
      <section aria-labelledby="connect-title" className={SECTION}>
        <h2 id="connect-title" className={H2}>
          Connect {meta.name}
        </h2>
        <p className={`mt-4 ${PROSE}`}>The connect form in the app shows the same steps and checks the key live before saving it.</p>
        <div className="mt-6">
          <KeyGuide meta={meta} headingId="integration-key-guide" preview />
        </div>
      </section>
      {meta.webhook ? (
        <Section id="webhook-title" title="Real-time updates">
          <p>
            Point {meta.name}’s webhooks at your connection and a sync starts about a minute after a new subscription or
            refund, instead of waiting for the next scheduled one. The call only starts a sync: its contents are never read.
          </p>
          {meta.webhook.events.length > 0 ? <p>Events to send: {meta.webhook.events.join(', ')}.</p> : null}
        </Section>
      ) : null}
      <Section id="limits-title" title="Good to know">
        <Bullets items={guide.limits} />
      </Section>
      {pairs.length > 0 ? (
        <Section id="pairs-title" title="Using it with other stores">
          <Bullets
            items={pairs.map((g) => (
              <TextLink key={g.slug} href={`/guides/${g.slug}`}>
                {g.title}
              </TextLink>
            ))}
          />
        </Section>
      ) : null}
      <section aria-labelledby="others-title" className="mt-14">
        <h2 id="others-title" className={H2}>
          Other integrations
        </h2>
        <IntegrationGrid except={guide.id} />
      </section>
    </Article>
  );
}

// ---------- /guides/<slug> ----------

export interface GuidePageProps extends MarketingProps {
  slug: string;
}

export function GuidePage(props: GuidePageProps) {
  const guide = guideBySlug(props.slug) as PairGuide;
  const linked = INTEGRATION_GUIDES.filter((g) => PAIR_LINKED[guide.slug]?.includes(g.id));
  return (
    <Article
      page={props}
      title={guide.title}
      description={guide.description}
      trail={[
        ['Integrations', '/integrations'],
        [guide.title, `/guides/${guide.slug}`],
      ]}
      h1={guide.title}
      lead={<p>{guide.summary}</p>}
    >
      {guide.sections.map((s, i) => (
        <Section key={s.heading} id={`guide-${i}`} title={s.heading}>
          <Paragraphs lines={s.body} />
        </Section>
      ))}
      <Section id="guide-links" title="The integrations">
        <Bullets
          items={linked.map((g) => (
            <TextLink key={g.slug} href={`/integrations/${g.slug}`}>
              {getProviderMeta(g.id).name}
            </TextLink>
          ))}
        />
      </Section>
    </Article>
  );
}

// ---------- /verified-revenue ----------

export type VerifiedRevenuePageProps = MarketingProps;

export function VerifiedRevenuePage(props: VerifiedRevenuePageProps) {
  return (
    <Article
      page={props}
      title="Verified revenue pages and an MRR badge"
      description="Publish a product’s MRR, revenue and subscriptions, read from Stripe, Paddle, RevenueCat or the app stores and never typed in, with a badge for your site."
      trail={[['Verified revenue', '/verified-revenue']]}
      h1="Verified revenue, read from your stores."
      lead={
        <p>
          Publish a page that shows what a product makes: MRR, revenue and subscriptions, read from its payment providers
          and worked out again after every sync. Nobody types the figures in, its founder included.
        </p>
      }
      cta={{ label: 'Publish your page', next: '/share', note: 'Read-only, open source, and free to publish at any MRR.' }}
    >
      <Section id="shows-title" title="What a page shows">
        <Bullets
          items={[
            'MRR, active subscriptions, revenue over the last 30 days, and total revenue since hoomuch’s history for it starts, all in US dollars.',
            'A chart of revenue over the last 30 days. Longer views and MRR over time need a free account.',
            'The stores the figures come from, the founder, and an About section in the founder’s own words, which the page labels as theirs.',
            'Images to share the figures, and the same page as Markdown for AI assistants.',
          ]}
        />
        <p>
          See the published ones on <TextLink href="/explore">Explore</TextLink>.
        </p>
      </Section>
      <Section id="verified-how-title" title="How the figures are verified">
        <Bullets
          items={[
            'They come from the same read-only connections as the dashboard, and they’re worked out again after every sync.',
            'The owner can’t type them in or edit them. The name, description and links are theirs, and the page says so.',
            'A page needs a live key that has synced. Demo data and test-mode keys never count.',
            'If a sync hasn’t confirmed the figures for 72 hours, the badge turns grey.',
          ]}
        />
      </Section>
      <Section id="badge-title" title="The badge">
        <p>
          A badge that reads “Verified MRR” with the current figure, for a website or a README. It links to the product’s
          page, so anyone can check where the number comes from.
        </p>
      </Section>
      <Section id="explore-title" title="Explore and search engines">
        <p>
          A page is listed on Explore once it has MRR, a sync in the last 72 hours and 30 days of revenue history. Until its
          figures go back 30 days, it asks search engines not to index it, so a page made only for its links gets nothing
          from search.
        </p>
      </Section>
      {/* hoomuch.com's plan, so only where anyone can sign up (like the landing page's pricing). */}
      {props.signupOpen ? (
        <Section id="cost-title" title="Free at any MRR">
          <p>
            The page, the badge and a place on Explore cost nothing, whatever the product makes. Only the private dashboard
            is paid: free under $1,000 MRR, and $9 a month from there once the beta ends.
          </p>
        </Section>
      ) : null}
      <Section id="private-title" title="Nothing is public until you publish">
        <p>
          You pick which connections make up a product, tick a confirmation and publish. Unpublishing takes the page and the
          badge down. A founder profile is public while at least one of its products is.
        </p>
      </Section>
    </Article>
  );
}

// ---------- /self-host ----------

export type SelfHostPageProps = MarketingProps;

const SOURCE_URL = 'https://github.com/hoomuch/hoomuch';
const DEPLOY_URL = `https://deploy.workers.cloudflare.com/?url=${SOURCE_URL}`;

export function SelfHostPage(props: SelfHostPageProps) {
  return (
    <Article
      page={props}
      title="Self-host an open-source MRR dashboard"
      description="Run hoomuch on your own Cloudflare account with Workers, D1 and Queues: every feature, open source under AGPL-3.0, with a one-click deploy."
      trail={[['Self-host', '/self-host']]}
      h1="Run it on your own Cloudflare account."
      lead={
        <p>
          Every feature, on Cloudflare Workers, D1 and Queues in your own account. Open source under AGPL-3.0, so your keys
          and numbers never leave infrastructure you control.
        </p>
      }
    >
      <Section id="oneclick-title" title="Deploy in one click">
        <p>
          <TextLink href={DEPLOY_URL} external>
            Deploy to Cloudflare
          </TextLink>{' '}
          copies the repository into your GitHub or GitLab account, creates the D1 database and the sync queue, and asks
          for an encryption key. Every deploy applies pending database migrations first, and every push to your copy
          redeploys it.
        </p>
      </Section>
      <Section id="hand-title" title="Or by hand">
        <pre className="overflow-x-auto rounded-xl border bg-muted/40 p-4 font-mono text-caption leading-relaxed text-foreground">
          <code>
            {[
              'npx wrangler login',
              'npx wrangler d1 create hoomuch       # copy the database_id into wrangler.jsonc',
              'openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY',
              'npm run deploy                       # applies migrations, then deploys',
            ].join('\n')}
          </code>
        </pre>
      </Section>
      <Section id="after-title" title="After deploying">
        <Bullets
          items={[
            'Back up the encryption key. Without it, every stored provider key is unreadable and each connection has to be keyed again.',
            'Create your account, then close sign-ups (ALLOW_SIGNUP) so nobody else can make one.',
            'Use Cloudflare’s Workers Paid plan ($5 per month) in production: password hashing and syncs can go past the Free plan’s 10 ms CPU limit.',
          ]}
        />
      </Section>
      <Section id="limits-title" title="How far the Free plan goes">
        <p>
          Queues allow 10,000 operations a day on the Free plan, and a sync takes about 3, so roughly 130 connections at the
          default hourly sync.
        </p>
      </Section>
      <Section id="docs-title" title="Configuration and updates">
        <p>
          Settings, public pages, email and updating without conflicts are in the{' '}
          <TextLink href={`${SOURCE_URL}#readme`} external>
            README
          </TextLink>
          . Rather not run it?{' '}
          {props.signupOpen ? 'Use the hosted one: it’s the same code.' : 'The hosted one at hoomuch.com is the same code.'}
        </p>
      </Section>
    </Article>
  );
}

// ---------- /compare/<slug> ----------

export interface ComparePageProps extends MarketingProps {
  slug: string;
}

export function ComparePage(props: ComparePageProps) {
  const c = comparisonBySlug(props.slug) as Comparison;
  return (
    <Article
      page={props}
      title={c.title}
      description={c.description}
      trail={[[`${c.name} alternative`, `/compare/${c.slug}`]]}
      h1={c.h1}
      lead={<p>{c.summary}</p>}
    >
      <section aria-labelledby="table-title" className="mt-12 max-w-[48rem]">
        <h2 id="table-title" className={H2}>
          Side by side
        </h2>
        <div className="mt-6 overflow-x-auto rounded-2xl border">
          <table className="w-full min-w-[32rem] text-left text-body">
            <thead className="border-b bg-muted/40 text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  <span className="sr-only">What</span>
                </th>
                <th scope="col" className="px-4 py-3 font-semibold text-foreground">
                  hoomuch
                </th>
                <th scope="col" className="px-4 py-3 font-semibold text-foreground">
                  {c.name}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {c.rows.map((r) => (
                <tr key={r.label} className="align-top">
                  <th scope="row" className="px-4 py-3 font-medium text-foreground">
                    {r.label}
                  </th>
                  <td className="px-4 py-3 text-muted-foreground">{r.hoomuch}</td>
                  <td className="px-4 py-3 text-muted-foreground">{r.them}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-caption text-muted-foreground">
          {c.name}’s details are from its own website, checked {c.checked}. They may have changed since:{' '}
          <TextLink href={c.source} external>
            check {c.name}’s website
          </TextLink>
          .
        </p>
      </section>
      {c.sections.map((s, i) => (
        <Section key={s.heading} id={`compare-${i}`} title={s.heading}>
          <Paragraphs lines={s.body} />
        </Section>
      ))}
    </Article>
  );
}
