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
 *
 * A page answers what someone comparing two tools came to find out, in the order they ask it: who
 * each fits, the facts side by side, the same job done in each, and the questions that are left.
 * `tasks` and `questions` say nothing about the other product that its row in the table doesn't.
 */

import type { ProviderId } from '../../providers/types';

/** A question someone has before choosing, with a page of ours that says more. */
export interface Question {
  q: string;
  a: string;
  /** `publicPages`: the page exists only where the instance has public pages. */
  link?: { href: string; label: string; publicPages?: boolean };
}

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
  /**
   * Which of the stores hoomuch reads the other product lists too: the logos under "Side by side".
   * It says the same as the "Stores and billing platforms" row, so change the two together.
   */
  reads: ProviderId[];
  /** Who each one fits better: the short answer, shown before the table. */
  fits: { hoomuch: string[]; them: string[] };
  /** The same job done in each: what you'd do, in a sentence or two. */
  tasks: { task: string; hoomuch: string; them: string; link?: Question['link'] }[];
  questions: Question[];
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

export const SWITCHING =
  'There’s nothing to export or migrate. Connect each store with a read-only key, and the first sync pulls 90 days of history. Both can run side by side while you decide.';

/** What hoomuch reads and adds up, for the questions about what it doesn't do. */
const DOES = 'It reads and adds up: MRR, ARR, subscriptions, trials and revenue, and how MRR moved (new, expansion, contraction and churned).';

const sameMrr = (name: string): Question => ({
  q: `Will hoomuch show the same MRR as ${name}?`,
  a: 'It can differ, because tools don’t all count trials, yearly plans and cancellations the same way. In hoomuch a yearly plan counts 1/12 of its price, trials don’t count, and a subscription set to cancel counts until it ends.',
  link: { href: '/#mrr', label: 'How hoomuch counts MRR' },
});

const STORED: Question = {
  q: 'What does hoomuch keep about my customers?',
  a: 'Nothing that names them. It keeps amounts, currencies, dates and plan names, and never your customers’ names, email addresses or card details. Your API keys are stored encrypted with AES-256-GCM.',
  link: { href: '/#store', label: 'What hoomuch keeps, and what it doesn’t' },
};

const SELF_HOST: Question = {
  q: 'Can I run hoomuch myself?',
  a: 'Yes, on your own Cloudflare account, with every feature. The code is open source under AGPL-3.0.',
  link: { href: '/self-host', label: 'How to self-host' },
};

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
      { label: 'Open source', hoomuch: HOOMUCH.openSource, them: 'Not that its website says. It’s a hosted service.' },
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
      {
        label: 'Also does',
        hoomuch: 'Verified public revenue pages and an MRR badge, if you want them.',
        them: 'Payment recovery and cancellation insights ($129 a month each), forecasting, benchmarks, and Slack, Intercom and HubSpot integrations.',
      },
    ],
    reads: ['stripe', 'paddle', 'chargebee', 'appstore', 'googleplay'],
    fits: {
      hoomuch: [
        'You sell in more than one place, especially through RevenueCat, Lemon Squeezy, Polar, Gumroad, Dodo Payments, Adapty or Superwall, which Baremetrics doesn’t list.',
        'You want a tool that can only read: hoomuch never creates, updates or cancels anything in your accounts.',
        'You’re under $1,000 MRR, or you’d rather run it yourself on your own Cloudflare account.',
      ],
      them: [
        'You want failed payments chased and cancellations turned around: hoomuch only reads, so it can’t retry a card or offer a coupon.',
        'You need forecasting, scenario planning or benchmarks against other SaaS companies.',
      ],
    },
    tasks: [
      {
        task: 'See web and app subscriptions as one MRR',
        hoomuch:
          'Connect Stripe and RevenueCat with one key each. Both land in one MRR, in one currency, with a row for each under By connection. If your RevenueCat project already tracks that Stripe account, connect one of the two so nothing counts twice.',
        them: 'Connect Stripe, and the App Store and Google Play directly. RevenueCat, Adapty and Superwall aren’t on its integrations page.',
        link: { href: '/guides/revenuecat-and-stripe', label: 'RevenueCat and Stripe without double counting' },
      },
      {
        task: 'A customer’s card fails',
        hoomuch:
          'Nothing is sent or retried from hoomuch, because it only reads. If the store ends the subscription, it shows as churned under MRR movement.',
        them: 'Its payment recovery, at $129 a month, chases the failed payment for you.',
      },
    ],
    questions: [
      {
        q: 'Can I use hoomuch and Baremetrics at the same time?',
        a: 'Yes. It only reads, so connecting it changes nothing in your stores, and Baremetrics keeps working as it does today.',
      },
      {
        q: 'Does hoomuch recover failed payments or forecast revenue?',
        a: `No. ${DOES} If you want failed payments chased or revenue forecast, Baremetrics is the better fit.`,
      },
      sameMrr('Baremetrics'),
      STORED,
      SELF_HOST,
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
        label: 'Open source',
        hoomuch: HOOMUCH.openSource,
        them: 'The app is a hosted service. Its API client libraries are open source.',
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
        label: 'Also does',
        hoomuch: 'Verified public revenue pages and an MRR badge, if you want them.',
        them: 'A CRM with pipelines and email sequences, cohort analysis, benchmarks and data warehouse exports.',
      },
    ],
    reads: ['stripe', 'paddle', 'chargebee', 'appstore', 'googleplay'],
    fits: {
      hoomuch: [
        'You sell an app through RevenueCat, Adapty or Superwall, or on the web through Lemon Squeezy, Polar, Gumroad or Dodo Payments, which ChartMogul doesn’t list.',
        'You use more than one store and don’t want to pay to see them together: every store is included on every hoomuch plan.',
        'You want it open source, or running on your own Cloudflare account.',
      ],
      them: [
        'You’re a SaaS on Stripe, Paddle or Chargebee and want cohorts, a CRM or benchmarks in the same tool.',
        'You have one billing source and up to $10K MRR: its free plan covers that.',
      ],
    },
    tasks: [
      {
        task: 'Add a second store',
        hoomuch: 'Add another connection with its own key. Every store is included on every plan, and they all add up into the same MRR.',
        them: 'Its free plan covers one billing source, up to $10K MRR. Paid plans start at $69 a month.',
      },
      {
        task: 'Connect Google Play',
        hoomuch:
          'Invite a service account with two view-only permissions, one for app information and reports and one for financial data. It reads your report bucket and your apps’ subscription prices.',
        them: 'Its Google Play setup grants managing orders and subscriptions as well as viewing financial data.',
        link: { href: '/integrations/google-play', label: 'How hoomuch reads Google Play' },
      },
    ],
    questions: [
      {
        q: 'Can I use hoomuch and ChartMogul at the same time?',
        a: 'Yes. It only reads, so connecting it changes nothing in your stores, and ChartMogul keeps working as it does today.',
      },
      {
        q: 'Does hoomuch read mobile subscription platforms?',
        a: 'Yes: RevenueCat, Adapty and Superwall, and App Store Connect and Google Play directly. Each store should reach hoomuch through one connection only, so its subscriptions count once.',
        link: { href: '/guides/revenuecat-and-stripe', label: 'Picking one source for each store' },
      },
      {
        q: 'Does hoomuch have cohorts or a CRM?',
        a: `No. ${DOES} If you want cohort analysis or a CRM in the same tool, ChartMogul is the better fit.`,
      },
      sameMrr('ChartMogul'),
      STORED,
      SELF_HOST,
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
      { label: 'Open source', hoomuch: HOOMUCH.openSource, them: 'Not that its website says. It offers a public API.' },
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
    ],
    reads: ['stripe', 'paddle', 'lemonsqueezy', 'polar', 'revenuecat', 'dodo', 'superwall', 'appstore'],
    fits: {
      hoomuch: [
        'You want to see every store together every day, privately: MRR movement, each day’s revenue and every charge, with a public page only if you choose one.',
        'You sell through Google Play, Chargebee, Gumroad or Adapty, which TrustMRR doesn’t list.',
        'You want the code open, or running on your own Cloudflare account.',
      ],
      them: [
        'You want to sell your startup, or be found by people buying one.',
        'You want to be in a large public directory of verified startups.',
      ],
    },
    tasks: [
      {
        task: 'Check how the month is going',
        hoomuch:
          'Open your dashboard: MRR and how it moved, each day’s revenue on a calendar, and every charge and refund, store by store. Only you see it.',
        them: 'Its page for your startup is public, and shows total revenue, revenue over 30 days, MRR, customers and subscriptions.',
        link: { href: '/#demo', label: 'See the dashboard with demo data' },
      },
      {
        task: 'Put a verified number on your site',
        hoomuch:
          'Publish a page for a product, choosing which connections make it up, then paste the badge into your site or README. Unpublishing takes both down.',
        them: 'Add your startup for a basic verified listing, which is free and comes with a badge.',
        link: { href: '/verified-revenue', label: 'How verified pages work', publicPages: true },
      },
      {
        task: 'Sell the company',
        hoomuch: 'Not something hoomuch does: it has no marketplace.',
        them: 'List it for sale on its marketplace, from $29 one time, plus a fee when it sells.',
      },
    ],
    questions: [
      {
        q: 'Do I have to make my revenue public to use hoomuch?',
        a: 'No. The dashboard is private, and nothing is public until you publish a page. You pick which connections make up a product, and unpublishing takes the page and the badge down.',
        link: { href: '/verified-revenue', label: 'How verified pages work', publicPages: true },
      },
      {
        q: 'Can I be on TrustMRR and use hoomuch too?',
        a: 'Yes. It only reads, so connecting it changes nothing in your stores or on your TrustMRR listing.',
      },
      sameMrr('TrustMRR'),
      STORED,
      SELF_HOST,
    ],
    source: 'https://trustmrr.com/faq',
    checked: CHECKED,
  },
];
