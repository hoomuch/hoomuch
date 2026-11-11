/**
 * Integration guides: what hoomuch reads from each provider and how it counts it, in plain words.
 * Owner: Experience (pages). The source of the /integrations pages.
 *
 * SPEC.md §6 is the source of truth for every rule here; when it changes, change this file with it.
 * The key steps, read permissions and webhook steps aren't repeated: the pages render them from the
 * provider registry (`getProviderMeta(id)`), so there's one copy of each.
 *
 * Copy follows design/brief.md §3: second person, short, plain verbs; "hoomuch" stays lowercase and
 * never starts a sentence; figures for numbers.
 */

import type { ProviderId } from '../../providers/types';

type IntegrationId = Exclude<ProviderId, 'demo'>;

export interface IntegrationGuide {
  id: IntegrationId;
  /** URL slug: /integrations/<slug>. Lowercase, hyphenated, e.g. 'stripe', 'lemon-squeezy', 'app-store-connect'. */
  slug: string;
  /** <title> without " · hoomuch", ≤ 60 chars with the suffix, e.g. "Stripe MRR dashboard: read-only, open source". */
  title: string;
  /** Meta description, ≤ 155 chars. */
  description: string;
  /** One or two sentences under the H1: what hoomuch reads from it and what you get. */
  summary: string;
  /** How MRR, active subscriptions and trials are counted for this provider. 2–5 short sentences. */
  mrr: string[];
  /** How revenue is counted: refunds, tax (merchant of record or not), fees, store commission, the day boundary. 1–4 sentences. */
  revenue: string[];
  /** What's worth knowing before connecting: limits, estimates, warnings the dashboard can show, history depth. 1–5 items. */
  limits: string[];
}

export interface PairGuide {
  slug: string;
  title: string;
  description: string;
  summary: string;
  sections: { heading: string; body: string[] }[];
}

/** The line every provider whose API lists subscriptions one by one shares (SPEC §6 "MRR hareketi"). */
const movement = (name: string) =>
  `The MRR movement card covers ${name} from your first sync on: new, expansion, contraction and churned MRR.`;

/** Providers that report daily totals only (README "Exporting transactions"). */
const dailyOnly = (name: string) =>
  `${name} reports daily totals only, so its sales don’t show in Transactions or the CSV export, and it isn’t in the MRR movement card.`;

const LOCAL_DAYS = 'Days run midnight to midnight in your time zone.';

export const INTEGRATION_GUIDES: readonly IntegrationGuide[] = [
  {
    id: 'stripe',
    slug: 'stripe',
    title: 'Stripe MRR dashboard: read-only, open source',
    description:
      'See Stripe MRR, subscriptions, trials and revenue next to Paddle, RevenueCat and the app stores, in one currency. Uses a read-only restricted key.',
    summary:
      'Connect a restricted Stripe key and see MRR, active subscriptions, trials and revenue next to your other stores, in one currency. It only reads, and your customers’ names and emails are never stored.',
    mrr: [
      'MRR adds up every active and past_due subscription, normalized to a month: a yearly price counts as a twelfth. Subscriptions set to cancel at the end of their period count until then.',
      'Metered items and items still in a free trial offer are left out. Tiered prices are worked out tier by tier, and coupons come off when the key can read them.',
      'Tax-inclusive tax rates are taken out of the price. With Stripe Tax turned on, Stripe doesn’t say the rate, so those prices stay tax-inclusive.',
      'Active subscriptions are the ones with MRR above 0, so free plans, 100% discounts and metered-only subscriptions don’t count. Stripe’s own dashboard counts customers; hoomuch counts subscriptions.',
      'Trials are trialing subscriptions, plus each item still in a trial offer.',
    ],
    revenue: [
      'Revenue comes from your balance transactions: charges as collected, tax included, and refunds, in your balance currency. The CSV export shows Stripe’s fee and the net for each charge.',
      LOCAL_DAYS,
    ],
    limits: [
      'Payments carry no product name, so Stripe is split by product on MRR only, not on revenue.',
      'Customer-level discounts aren’t applied: reading them would need access to customer details.',
      'A sync reads up to about 35,000 active subscriptions.',
      movement('Stripe'),
    ],
  },
  {
    id: 'paddle',
    slug: 'paddle',
    title: 'Paddle MRR and revenue dashboard, read-only',
    description:
      'See Paddle MRR, subscriptions, trials and revenue without tax, next to Stripe, RevenueCat and the app stores. Uses a read-only Paddle Billing API key.',
    summary:
      'Connect a read-only Paddle API key and see MRR, subscriptions, trials and revenue with the rest of your stores. Paddle is the merchant of record, so revenue leaves out the tax it collects.',
    mrr: [
      'On a live account, MRR is Paddle’s own figure from its Metrics API: in your balance currency, one-time payments left out, refreshed by Paddle once a day.',
      'In a sandbox, or when the key can’t read metrics, MRR is estimated from active and past_due subscriptions, normalized to a month, with discounts taken off when the key can read them.',
      'On a live account, active subscriptions are Paddle’s count of active and past_due subscriptions, free and 100% discounted ones included.',
      'Trials are your trialing subscriptions.',
    ],
    revenue: [
      'Revenue is each completed transaction minus its tax, dated when it was paid. The CSV export shows Paddle’s fee and the net.',
      'Refunds and chargebacks come from Paddle’s adjustments, and a refund is dated when it was approved. Credit added to a customer’s balance isn’t a refund.',
      LOCAL_DAYS,
    ],
    limits: [
      'Paddle API keys expire: after 90 days by default, a year at most. When one does, the connection shows an error until you paste a new key.',
      'Keys made before May 6, 2025 can’t be limited to read permissions, so they aren’t accepted. Paddle Classic isn’t supported.',
      'With tax-inclusive prices, the estimated MRR includes tax.',
      'Paddle reports MRR as a total, so it isn’t in the MRR movement card.',
    ],
  },
  {
    id: 'lemonsqueezy',
    slug: 'lemon-squeezy',
    title: 'Lemon Squeezy MRR and revenue dashboard',
    description:
      'See Lemon Squeezy MRR, subscriptions, trials and revenue without tax, next to Stripe, Paddle, RevenueCat and the app stores, on one dashboard.',
    summary:
      'Connect a Lemon Squeezy API key and see MRR, subscriptions, trials and revenue next to your other stores. Lemon Squeezy is the merchant of record, so revenue leaves out the tax it collects.',
    mrr: [
      'MRR adds up active and past_due subscriptions, plus canceled ones until they end, each priced from its plan and normalized to a month. Package, volume and graduated prices are worked out from their tiers.',
      'Forever and repeating discounts come off, repeating ones until their months run out. One-time discounts don’t change MRR.',
      'Usage-based prices can’t be priced ahead, so those subscriptions count as active but add nothing to MRR.',
      'Trials are on_trial subscriptions, plus canceled ones that never left their trial. MRR is in each store’s currency.',
    ],
    revenue: [
      'Revenue is each paid order and renewal invoice minus its tax. A subscription’s first invoice isn’t counted again when its checkout order already was.',
      'Refunds are counted in proportion to the refunded amount, without tax. Each sync looks back 30 days for refunds that came in late.',
      LOCAL_DAYS,
    ],
    limits: [
      'Refunds issued more than about 30 days after the purchase are missed, and several partial refunds on one order show as one.',
      'For currencies without 2 decimals, hoomuch assumes ISO 4217 units, because Lemon Squeezy’s docs don’t say.',
      'If a store has more subscriptions than one sync can read, the connection says so instead of showing a partial MRR. If discounts don’t fit in one sync, MRR is shown without them.',
      movement('Lemon Squeezy'),
    ],
  },
  {
    id: 'polar',
    slug: 'polar',
    title: 'Polar MRR dashboard: subscriptions and revenue',
    description:
      'See Polar MRR, subscriptions, trials and revenue before tax, next to Stripe, Paddle, RevenueCat and the app stores. Uses an organization access token.',
    summary:
      'Connect a Polar organization access token and see MRR, subscriptions, trials and revenue with the rest of your stores. Polar is the merchant of record, so revenue leaves out tax.',
    mrr: [
      'MRR is Polar’s own dashboard figure: after discounts, with VAT taken out of tax-inclusive prices, normalized to a month, trials left out and past_due subscriptions included.',
      'Polar converts MRR to US dollars, so it always arrives in USD.',
      'Polar also counts paused subscriptions in MRR, and its API doesn’t give their amounts, so they can’t be taken out.',
      'Active subscriptions are active and past_due subscriptions with an amount above 0. Trials are trialing subscriptions.',
    ],
    revenue: [
      'Revenue is each paid order after discounts and before tax. The CSV export shows Polar’s platform fee when it’s in the order’s currency. Refunds count before tax; tax-only refunds don’t count.',
      'Polar retries a failed renewal for up to 21 days, so each sync looks back 30 days for late orders and refunds.',
      LOCAL_DAYS,
    ],
    limits: [
      'Polar reports MRR as a total, so it isn’t in the MRR movement card.',
      'Polar’s API version is pinned to 2026-10, which Polar retires in April 2027: a self-hosted copy needs an update before then.',
    ],
  },
  {
    id: 'revenuecat',
    slug: 'revenuecat',
    title: 'RevenueCat MRR next to Stripe and Paddle',
    description:
      'See RevenueCat MRR, subscriptions, trials and revenue next to Stripe, Paddle and your other stores, in one currency. Uses a read-only v2 secret key.',
    summary:
      'Connect a RevenueCat secret key and see your apps’ MRR, subscriptions, trials and revenue next to Stripe, Paddle and the rest. The figures are RevenueCat’s own, for the whole project.',
    mrr: [
      'MRR, active subscriptions and active trials are RevenueCat’s overview metrics for the project, in USD.',
      'They cover every store the project tracks, so one RevenueCat connection can stand for several stores.',
      'RevenueCat reports totals, not single subscriptions, so it isn’t in the MRR movement card.',
    ],
    revenue: [
      'With the optional charts permission, revenue comes in daily from RevenueCat’s revenue and refunds charts. Without it, the dashboard shows RevenueCat’s last 28 days of revenue and says so.',
      'Revenue is what the stores report: what customers paid, tax and store commission included, in USD, on UTC days.',
    ],
    limits: [
      'If your RevenueCat project also tracks Stripe or the app stores, don’t connect those separately for the same apps: their sales would count twice.',
      'RevenueCat reports daily totals only, so its sales don’t show in Transactions or the CSV export.',
      'Test mode can’t be detected through RevenueCat’s API.',
    ],
  },
  {
    id: 'chargebee',
    slug: 'chargebee',
    title: 'Chargebee MRR dashboard: read-only, open source',
    description:
      'See Chargebee MRR, subscriptions, trials and revenue next to Stripe, Paddle, RevenueCat and the app stores. Uses a read-only Chargebee API key.',
    summary:
      'Connect a read-only Chargebee key and see MRR, subscriptions, trials and revenue next to your other stores, with the same MRR your Chargebee dashboard shows.',
    mrr: [
      'MRR is the sum of Chargebee’s own MRR for each active and non-renewing subscription: tax, setup fees and one-time charges left out, discounts as your site’s MRR settings say. So it matches your Chargebee dashboard.',
      'Chargebee has no past_due status: a subscription in dunning stays active and still counts.',
      'Subscriptions with 0 MRR, like a $0 plan or a 100% discount, count neither in MRR nor as active. Trials are in_trial subscriptions.',
    ],
    revenue: [
      'Chargebee isn’t a merchant of record, so revenue is what was collected, tax included, in each transaction’s currency. Its API doesn’t give the gateway’s fee.',
      'Successful payments are charges; refunds and payment reversals are refunds, and a payment that fails late is reversed on the day it failed. Direct debits that settle days later are picked up when they do.',
      LOCAL_DAYS,
    ],
    limits: [
      'Starter plans and test sites allow 150 API requests a minute, shared with your own integrations, so a sync reads up to about 9,000 subscriptions and trials per site.',
      'If a subscription has no MRR of its own in Chargebee, it’s worked out from its plan and add-on items, without discounts.',
      movement('Chargebee'),
    ],
  },
  {
    id: 'dodo',
    slug: 'dodo-payments',
    title: 'Dodo Payments MRR and revenue dashboard',
    description:
      'See Dodo Payments MRR, subscriptions, trials and revenue without tax, next to Stripe, Paddle, RevenueCat and the app stores. Uses a read-only key.',
    summary:
      'Connect a read-only Dodo Payments key and see MRR, subscriptions, trials and revenue next to your other stores. Dodo Payments is the merchant of record, so revenue leaves out tax.',
    mrr: [
      'MRR adds up active and past_due subscriptions at their recurring amount before tax, normalized to how often they bill. A subscription set to cancel at its next billing date counts until then.',
      'On hold, paused, pending, canceled, failed and expired subscriptions don’t count, and neither do $0 or on-demand ones.',
      'Tax-inclusive subscriptions are counted as they are, tax included, because the API gives no rate.',
      'Dodo Payments has no trialing status, so a subscription counts as a trial while its next billing date is still within its trial period.',
    ],
    revenue: [
      'Revenue comes from your balance ledger as daily totals per wallet currency: payments minus tax, with refunds and disputes taken off. Fees, payouts and adjustments aren’t revenue.',
      'Days are UTC, as Dodo Payments reports them.',
    ],
    limits: [
      'Dodo Payments reports revenue as daily totals, so its sales don’t show in Transactions or the CSV export.',
      'Keys with an IP allowlist don’t work, because Cloudflare Workers have no fixed IP address.',
      'Dodo Payments’ rate limit is shared by all your keys, so a sync reads up to about 16,000 subscriptions.',
      movement('Dodo Payments'),
    ],
  },
  {
    id: 'gumroad',
    slug: 'gumroad',
    title: 'Gumroad MRR dashboard for memberships',
    description:
      'See Gumroad membership MRR, subscribers, trials and sales next to Stripe, Paddle, RevenueCat and the app stores, in one currency, on one dashboard.',
    summary:
      'Connect a Gumroad access token and see membership MRR, subscribers, trials and sales next to your other stores. Gumroad is the merchant of record, so sales leave out the tax it adds.',
    mrr: [
      'MRR is an estimate, because Gumroad’s API doesn’t say what each subscriber pays. Each paying subscriber is priced at their latest charge, or at their tier’s list price when no charge is found.',
      'Prices are normalized to a month: quarterly ÷3, every 6 months ÷6, yearly ÷12, every 2 years ÷24.',
      'Active subscribers are live ones, those canceling at the end of their period, and those whose renewal is being retried or needs a new card, with an amount above 0. Free tiers don’t count.',
      'Trials are subscribers whose free trial hasn’t ended.',
    ],
    revenue: [
      'Gumroad reports every amount in US dollars, so sales are in USD, without the tax Gumroad adds. The CSV export shows Gumroad’s fee and the net.',
      'Gumroad doesn’t date refunds, so a refund lands on the day of its sale. Each sync looks back 30 days for late ones.',
      '$0 sales, like free products and trial sign-ups, and gift copies are skipped.',
    ],
    limits: [
      'A latest charge can carry a one-time discount, a tip or a pending price change, and a list price misses discounts, so MRR can be a little off.',
      'There’s no sandbox: test purchases don’t appear in Gumroad’s API.',
      'Partial refunds are read only for products listed in USD.',
      movement('Gumroad'),
    ],
  },
  {
    id: 'adapty',
    slug: 'adapty',
    title: 'Adapty MRR next to your web revenue',
    description:
      'See Adapty MRR, subscriptions, trials and revenue next to Stripe, Paddle and your other stores, in one currency. Starts with up to 90 days of history.',
    summary:
      'Connect an Adapty app’s secret key and see its MRR, subscriptions, trials and revenue next to your web stores. Each Adapty app is its own connection.',
    mrr: [
      'MRR, active subscriptions and active trials are Adapty’s own metrics, in USD. MRR leaves out trials and one-time purchases.',
      'Adapty’s active count also leaves out subscriptions with renewal turned off, which other providers count until they end.',
      'When you connect, up to 90 days of MRR, subscription and trial history come with it, so the trend starts filled in.',
    ],
    revenue: [
      'Revenue comes in daily from Adapty’s revenue and refund charts, in USD, on UTC days: what customers paid, tax and store commission included, with refunds on the day they were processed.',
      'If the key can’t read the revenue chart, you’re warned when you connect, and the dashboard shows Adapty’s last 30 days of revenue instead.',
    ],
    limits: [
      'Sandbox purchases never reach Adapty’s charts, so there’s no test mode.',
      dailyOnly('Adapty'),
      'If you also connect App Store Connect or Google Play for the same app, its sales count twice.',
    ],
  },
  {
    id: 'superwall',
    slug: 'superwall',
    title: 'Superwall MRR and revenue in one dashboard',
    description:
      'See Superwall MRR, subscriptions, trials and revenue next to Stripe, Paddle and your other stores, in one currency. Starts with up to 90 days of history.',
    summary:
      'Connect a Superwall organization key and see MRR, subscriptions, trials and revenue for your paywalled apps next to your other stores.',
    mrr: [
      'MRR and active subscriptions are Superwall’s own charts for the whole organization, production only, in USD. Active subscriptions are unexpired, paid ones, so trials don’t count.',
      'Trials need the optional data permission: they’re subscriptions whose current period is a trial that hasn’t ended. Without it, trials show as unknown.',
      'When you connect, up to 90 days of MRR and subscription history come with it, so the trend starts filled in.',
    ],
    revenue: [
      'With the data permission, revenue comes in daily, in USD, on UTC days: sales including VAT and store commission, with refunds on the day they happened.',
      'A store purchase that reaches Superwall more than once, from the store, RevenueCat and the SDK, counts once. Sandbox, Family Sharing and RevenueCat’s copies of Stripe purchases are left out.',
    ],
    limits: [
      'If the store and RevenueCat don’t carry the same transaction id, one purchase can count twice.',
      'Without the data permission, there’s no daily revenue and no trial count.',
      dailyOnly('Superwall'),
      'There’s no test mode: sandbox purchases are left out.',
    ],
  },
  {
    id: 'appstore',
    slug: 'app-store-connect',
    title: 'App Store subscription MRR dashboard',
    description:
      'See App Store subscription MRR, trials and revenue from Apple’s own reports, next to Stripe, Paddle and RevenueCat. Uses a team API key, Sales role.',
    summary:
      'Connect a team API key with the Sales role and see your App Store subscriptions’ MRR, trials and revenue next to your web stores, straight from Apple’s reports.',
    mrr: [
      'Figures come from Apple’s daily Subscription report, the latest one Apple has published.',
      'MRR counts standard-price subscriptions at their customer price, normalized to a month.',
      'Subscribers on a paid introductory, promotional, offer code or win-back price count as active but add nothing to MRR, because the report doesn’t say what they pay.',
      'Trials are the report’s free trial columns. Subscriptions in billing retry or a grace period don’t count.',
    ],
    revenue: [
      'Revenue comes from the daily Sales report: what customers paid, tax included, before Apple’s commission, in each buyer’s currency. Refunds come in as negative rows.',
      'Days are Apple’s Pacific Time days. Each sync reads the last 3 days again, since Apple publishes each day the next morning.',
    ],
    limits: [
      'Numbers run a day behind, because Apple publishes each day’s reports the next morning, Pacific Time.',
      'Sandbox purchases aren’t in Sales and Trends, so there’s no test mode.',
      dailyOnly('App Store Connect'),
      'If RevenueCat or Adapty also tracks the same app, connect one of them, not both: the app’s sales would count twice.',
    ],
  },
  {
    id: 'googleplay',
    slug: 'google-play',
    title: 'Google Play subscription MRR dashboard',
    description:
      'See Google Play subscription MRR and revenue from Play Console’s own reports, next to Stripe, Paddle and RevenueCat. Uses a read-only service account.',
    summary:
      'Connect a service account and see your Google Play subscriptions’ MRR and revenue next to your web stores. Google has no revenue API, so hoomuch reads the reports Play Console exports to your Cloud Storage bucket.',
    mrr: [
      'Active subscriptions are Google’s own count, from this month’s subscription reports.',
      'MRR prices each of those subscriptions at its base plan’s current price in that country, normalized to a month. Prepaid plans count as active but add nothing to MRR.',
      'Google doesn’t say who is in a free trial, on an offer or on an older price, so they’re counted at the current base plan price, and trials show as unknown.',
    ],
    revenue: [
      'Revenue comes order by order from the estimated sales report: what the buyer was charged, tax included, before Google’s fee, in the currency of the sale. Refunds and chargebacks come in as negative rows.',
      LOCAL_DAYS,
    ],
    limits: [
      'Google’s reports run a few days behind.',
      'A newly invited service account can take up to a day to see the reports.',
      'License testers’ purchases aren’t in the financial reports, so there’s no test mode.',
      'Google Play reports totals, so it isn’t in the MRR movement card.',
      'If RevenueCat or Adapty also tracks the same app, connect one of them, not both: the app’s sales would count twice.',
    ],
  },
];

export const PAIR_GUIDES: readonly PairGuide[] = [
  {
    slug: 'revenuecat-and-stripe',
    title: 'RevenueCat and Stripe MRR without double counting',
    description:
      'RevenueCat can already count your Stripe subscriptions. How to combine RevenueCat, Stripe and the app stores in one MRR so every sale counts once.',
    summary:
      'Every connection you add is summed into one MRR. If your RevenueCat project also tracks your Stripe purchases, connecting both counts those subscriptions twice. Here’s how to set it up so each sale counts once.',
    sections: [
      {
        heading: 'Does connecting both count a sale twice?',
        body: [
          'It can. The dashboard adds up the MRR, subscriptions, trials and revenue of every connection, and shows each one under By connection.',
          'Subscriptions aren’t matched across connections: hoomuch keeps no customer details, so there’s nothing to match them on.',
          'RevenueCat reports one set of figures for the whole project, covering every store it tracks. If you’ve connected Stripe to that RevenueCat project, those Stripe subscriptions are already in RevenueCat’s MRR and revenue. Connect the same Stripe account too, and they count twice.',
        ],
      },
      {
        heading: 'Pick one source for each store',
        body: [
          'Each store’s subscriptions should reach hoomuch through one connection only. Two setups do that.',
          'Through RevenueCat: connect RevenueCat, and leave out the Stripe account it already tracks. For the same reason, leave out App Store Connect and Google Play for the apps RevenueCat tracks.',
          'Store by store: connect Stripe, App Store Connect and Google Play directly, and leave RevenueCat out.',
          'If your Stripe account also sells things RevenueCat doesn’t track, like a web plan, use the store-by-store setup: it’s the one that counts everything once.',
          'The same goes for Adapty and Superwall. They report store purchases too, so connect them instead of the stores they cover, not next to them.',
        ],
      },
      {
        heading: 'What each setup gives you',
        body: [
          'Through RevenueCat, figures arrive as RevenueCat’s totals, in USD, on UTC days. There’s no transaction list and no MRR movement for them, and revenue is the stores’ gross: tax and store commission included.',
          'Store by store, Stripe adds each charge and refund, MRR movement, and MRR by product when the key can read products. App Store Connect runs a day behind and Google Play a few days, and Google doesn’t say who is in a free trial, so trials show as unknown.',
        ],
      },
      {
        heading: 'Several Stripe accounts',
        body: [
          'Add one connection per Stripe account, each with its own key. The dashboard adds them up and shows each one under By connection.',
          'Don’t connect the same account twice: two keys for one account count every subscription twice.',
        ],
      },
    ],
  },
];
