/**
 * Comparisons with other revenue tools: the /compare pages. Owner: Experience (pages).
 *
 * Every fact about another product comes from its own website, read on the date in `checked`, with
 * the pricing page in `source`; the page says so, and says where the other tool is the better fit.
 * Re-check them before changing a line, and drop a claim rather than guess one. hoomuch's own side
 * follows SPEC §6 and the landing page's pricing (hoomuch.com's plans).
 *
 * Copy follows design/brief.md §3: second person, short, plain verbs; "hoomuch" stays lowercase and
 * never starts a sentence; figures for numbers; no dashes.
 */

export interface Comparison {
  /** URL slug: /compare/<slug>. */
  slug: string;
  /** The other product's name. */
  name: string;
  /** <title> without " · hoomuch", within about 50 characters. */
  title: string;
  /** Meta description, within 155 characters. */
  description: string;
  h1: string;
  summary: string;
  /** The table: one row per question, hoomuch's answer, then theirs. */
  rows: { label: string; hoomuch: string; them: string }[];
  sections: { heading: string; body: string[] }[];
  /** Their pricing page, linked under the table. */
  source: string;
  /** When their details were read from their website. */
  checked: string;
}

const CHECKED = '11 November 2026';

/** hoomuch's side of the rows every comparison shares. */
const HOOMUCH = {
  price:
    'Free under $1,000 MRR, and free for everyone during the beta. After it, $9 a month for the private dashboard at $1,000 MRR and up. Verified pages and the badge are free at any MRR. Self-hosting is free.',
  stores:
    '12: Stripe, Paddle, Lemon Squeezy, Polar, RevenueCat, Chargebee, Dodo Payments, Gumroad, Adapty, Superwall, App Store Connect and Google Play.',
  access:
    'Read-only keys wherever the store offers one. Lemon Squeezy, Gumroad and Adapty keys can’t be limited, and hoomuch only reads with them.',
  openSource: 'Yes, under AGPL-3.0. Run it on your own Cloudflare account, or use hoomuch.com.',
};

const SWITCHING =
  'There’s nothing to export or migrate. Connect each store with a read-only key, and the first sync pulls 90 days of history. Both can run side by side while you decide.';

export const COMPARISONS: readonly Comparison[] = [
  {
    slug: 'baremetrics-alternative',
    name: 'Baremetrics',
    title: 'Baremetrics alternative: open source, read-only',
    description:
      'Compare hoomuch and Baremetrics: price, which billing platforms and app stores each reads, read-only access and self-hosting.',
    h1: 'A read-only Baremetrics alternative.',
    summary:
      'Baremetrics is a subscription analytics suite for SaaS, with dunning and forecasting on top; hoomuch does one thing: it reads every store you sell in, web and mobile, and adds them up into one MRR.',
    rows: [
      {
        label: 'What it is',
        hoomuch: 'A read-only revenue dashboard across billing platforms and app stores.',
        them: 'Subscription analytics for SaaS, with payment recovery, cancellation insights and forecasting.',
      },
      {
        label: 'Price',
        hoomuch: HOOMUCH.price,
        them: 'From $75 a month billed monthly, or $49 billed yearly, up to $360K ARR. Plans step up with ARR. A free trial.',
      },
      {
        label: 'Stores and billing platforms',
        hoomuch: HOOMUCH.stores,
        them: 'Stripe, Chargebee, Braintree, Recurly, the App Store, Google Play and Paddle (in beta), among others. Lemon Squeezy, Polar, RevenueCat, Dodo Payments, Gumroad, Adapty and Superwall aren’t on its integrations page.',
      },
      {
        label: 'Access to your accounts',
        hoomuch: HOOMUCH.access,
        them: 'Its retention offers need its Stripe app to create coupons and update subscriptions.',
      },
      { label: 'Open source', hoomuch: HOOMUCH.openSource, them: 'Not that its website says. It’s a hosted service.' },
      {
        label: 'Also does',
        hoomuch: 'Verified public revenue pages and an MRR badge, if you want them.',
        them: 'Payment recovery and cancellation insights ($129 a month each), forecasting, benchmarks, and Slack, Intercom and HubSpot integrations.',
      },
    ],
    sections: [
      {
        heading: 'When hoomuch fits better',
        body: [
          'You sell in more than one place, especially through RevenueCat, Lemon Squeezy, Polar, Gumroad, Dodo Payments, Adapty or Superwall, which Baremetrics doesn’t list.',
          'You want a tool that can only read: hoomuch never creates, updates or cancels anything in your accounts.',
          'You’re under $1,000 MRR, or you’d rather run it yourself on your own Cloudflare account.',
        ],
      },
      {
        heading: 'When Baremetrics fits better',
        body: [
          'You want failed payments chased and cancellations turned around: hoomuch only reads, so it can’t retry a card or offer a coupon.',
          'You need forecasting, scenario planning or benchmarks against other SaaS companies.',
        ],
      },
      { heading: 'Switching', body: [SWITCHING] },
    ],
    source: 'https://baremetrics.com/pricing',
    checked: CHECKED,
  },
  {
    slug: 'chartmogul-alternative',
    name: 'ChartMogul',
    title: 'ChartMogul alternative for web and app revenue',
    description:
      'Compare hoomuch and ChartMogul: price, which billing platforms and app stores each reads, read-only access and an open-source, self-hosted option.',
    h1: 'A ChartMogul alternative for web and app revenue.',
    summary:
      'ChartMogul is subscription analytics and a CRM for SaaS, and hoomuch is narrower: one read-only dashboard that adds up every store you sell in, including the mobile subscription platforms.',
    rows: [
      {
        label: 'What it is',
        hoomuch: 'A read-only revenue dashboard across billing platforms and app stores.',
        them: 'Subscription analytics for SaaS, with a built-in CRM, cohorts and benchmarks.',
      },
      {
        label: 'Price',
        hoomuch: HOOMUCH.price,
        them: 'Free up to $10K MRR with one billing source. Paid plans from $69 a month, or $57 billed yearly, stepping up with ARR. A 14-day trial.',
      },
      {
        label: 'Stores and billing platforms',
        hoomuch: HOOMUCH.stores,
        them: 'Stripe, Paddle, Chargebee, App Store Connect, Google Play and about 30 more, plus import by API or CSV. Lemon Squeezy, Polar, RevenueCat, Dodo Payments, Gumroad, Adapty and Superwall aren’t on its integrations page.',
      },
      {
        label: 'Access to your accounts',
        hoomuch: HOOMUCH.access,
        them: 'Its Google Play setup grants managing orders and subscriptions as well as viewing financial data.',
      },
      {
        label: 'Open source',
        hoomuch: HOOMUCH.openSource,
        them: 'The app is a hosted service. Its API client libraries are open source.',
      },
      {
        label: 'Also does',
        hoomuch: 'Verified public revenue pages and an MRR badge, if you want them.',
        them: 'A CRM with pipelines and email sequences, cohort analysis, benchmarks and data warehouse exports.',
      },
    ],
    sections: [
      {
        heading: 'When hoomuch fits better',
        body: [
          'You sell an app through RevenueCat, Adapty or Superwall, or on the web through Lemon Squeezy, Polar, Gumroad or Dodo Payments, which ChartMogul doesn’t list.',
          'You use more than one store and don’t want to pay to see them together: every store is included on every hoomuch plan.',
          'You want it open source, or running on your own Cloudflare account.',
        ],
      },
      {
        heading: 'When ChartMogul fits better',
        body: [
          'You’re a SaaS on Stripe, Paddle or Chargebee and want cohorts, a CRM or benchmarks in the same tool.',
          'You have one billing source and up to $10K MRR: its free plan covers that.',
        ],
      },
      { heading: 'Switching', body: [SWITCHING] },
    ],
    source: 'https://chartmogul.com/pricing/',
    checked: CHECKED,
  },
  {
    slug: 'trustmrr-alternative',
    name: 'TrustMRR',
    title: 'TrustMRR alternative: a dashboard first',
    description:
      'Compare hoomuch and TrustMRR: a private revenue dashboard with an optional verified page, the providers each reads, access, price and open source.',
    h1: 'A TrustMRR alternative that starts with your dashboard.',
    summary:
      'TrustMRR is a public database of startups with verified revenue, and a marketplace to buy and sell them; hoomuch is a private dashboard for every store you sell in, and publishing a verified page from it is optional.',
    rows: [
      {
        label: 'What it is',
        hoomuch: 'A private revenue dashboard. A verified public page and badge are optional.',
        them: 'A public database of verified startup revenue, and a marketplace for selling startups.',
      },
      {
        label: 'Price',
        hoomuch: HOOMUCH.price,
        them: 'A basic verified listing is free. Listing a startup for sale costs from $29, one time, plus a fee when it sells.',
      },
      {
        label: 'Stores and billing platforms',
        hoomuch: HOOMUCH.stores,
        them: 'Stripe, Paddle, Lemon Squeezy, Polar, RevenueCat, Dodo Payments, Superwall and the App Store, plus Creem, Whop and Shopify. Chargebee, Gumroad, Adapty and Google Play aren’t listed.',
      },
      {
        label: 'Access to your accounts',
        hoomuch: HOOMUCH.access,
        them: 'Read-only for most providers; its Lemon Squeezy and Whop connections use broader permissions.',
      },
      {
        label: 'Public page',
        hoomuch: 'MRR, subscriptions, revenue over 30 days and in total, a badge, and the same page as Markdown.',
        them: 'Total revenue, revenue over 30 days, MRR, customers and subscriptions, and a badge.',
      },
      { label: 'Open source', hoomuch: HOOMUCH.openSource, them: 'Not that its website says. It offers a public API.' },
    ],
    sections: [
      {
        heading: 'When hoomuch fits better',
        body: [
          'You want to see every store together every day, privately: MRR movement, each day’s revenue and every charge, with a public page only if you choose one.',
          'You sell through Google Play, Chargebee, Gumroad or Adapty, which TrustMRR doesn’t list.',
          'You want the code open, or running on your own Cloudflare account.',
        ],
      },
      {
        heading: 'When TrustMRR fits better',
        body: [
          'You want to sell your startup, or be found by people buying one.',
          'You want to be in a large public directory of verified startups.',
        ],
      },
      { heading: 'Switching', body: [SWITCHING] },
    ],
    source: 'https://trustmrr.com/faq',
    checked: CHECKED,
  },
];
