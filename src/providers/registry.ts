/**
 * Provider metadata (Lead): names, form fields, permissions, webhooks. The adapters themselves are
 * looked up in ./adapters.ts. This file imports none of them, so the pages and the browser bundle
 * can read the metadata without pulling in adapter code (.dependency-cruiser.mjs checks it).
 */

import type { ConnectionConfig, Credentials, ProviderId, ProviderMeta } from './types';

export const PROVIDERS: readonly ProviderMeta[] = [
  {
    id: 'stripe',
    name: 'Stripe',
    color: '#635BFF',
    dotClass: 'bg-[#635BFF]',
    tagline: 'Subscriptions and payments on the web',
    fields: [
      {
        name: 'apiKey',
        label: 'Restricted API key',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'rk_live_…',
        help: 'Starts with rk_. A secret key (sk_) also works, but it has full access.',
      },
    ],
    keySteps: [
      'Open Developers → API keys in your Stripe Dashboard.',
      'Click “Create restricted key” and name it “hoomuch”.',
      'Grant Read on the permissions listed below; leave everything else as None.',
      'Create the key and paste it here.',
    ],
    keyUrl: 'https://dashboard.stripe.com/apikeys/create',
    permissions: [
      'Subscriptions: Read',
      'Prices: Read',
      'Balance: Read',
      'Coupons: Read — optional, takes discounts off MRR',
      'Products: Read — optional, splits MRR by product',
    ],
    revenueHistory: 'transactions',
    // Charges carry no product name: reaching one means reading invoices, which needs a key that can
    // read customer data (SPEC §6.1). The product split comes from subscriptions instead (mrrByProduct).
    productNames: false,
    mrrByProduct: true,
    webhook: {
      steps: [
        'In Stripe, open Workbench → Webhooks and click Create an event destination.',
        'Choose Your account and the Snapshot payload format, tick the events below, then pick Webhook endpoint.',
        'Paste this URL as the Endpoint URL and save. You can ignore the whsec_ signing secret.',
      ],
      events: [
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'invoice.paid',
        'charge.succeeded',
        'charge.refunded',
      ],
      note: 'Live mode and each sandbox have their own destinations: create it where this key belongs.',
    },
  },
  {
    id: 'paddle',
    name: 'Paddle',
    // Paddle's yellow is taken (Lemon Squeezy's mustard) and fails contrast on white; this blue is
    // 3.9:1 on white and 4.9:1 on the dark page.
    color: '#2F80ED',
    dotClass: 'bg-[#2F80ED]',
    tagline: 'Merchant of record for software and SaaS',
    fields: [
      {
        name: 'apiKey',
        label: 'API key',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'pdl_live_apikey_…',
        help: 'Starts with pdl_live_apikey_ (or pdl_sdbx_apikey_ for a sandbox account). Keys created before May 2025 don’t work.',
      },
    ],
    keySteps: [
      'In your Paddle dashboard, go to Settings → Authentication and open the API keys tab.',
      'Click “New API key” and name it “hoomuch”.',
      'Grant Read on the permissions listed below and nothing else.',
      'Set an expiry date (Paddle suggests 90 days, one year at most), save, and paste the key here. Paddle shows it only once.',
    ],
    keyUrl: 'https://vendors.paddle.com/authentication-v2',
    permissions: [
      'Subscriptions: Read',
      'Transactions: Read',
      'Adjustments: Read',
      'Metrics: Read — not needed for sandbox keys',
      'Discounts: Read — optional, used when Paddle’s MRR metric isn’t available',
    ],
    warning:
      'Paddle API keys usually expire (90 days by default, one year at most), and an expired key can’t be renewed. When this one lapses, hoomuch shows an error on the connection and you can paste a new key there.',
    revenueHistory: 'transactions',
    productNames: true,
    mrrByProduct: false,
    webhook: {
      steps: [
        'In Paddle, open Events → Notifications and click New destination.',
        'Set Notification type to URL, paste this URL, set Usage type to Platform only and tick the events below.',
        'Click Save destination. hoomuch doesn’t need the secret key Paddle shows.',
      ],
      events: [
        'subscription.created',
        'subscription.updated',
        'subscription.canceled',
        'transaction.completed',
        'adjustment.created',
        'adjustment.updated',
      ],
      note: 'Sandbox and live are separate accounts: add it in the one this key belongs to.',
    },
  },
  {
    id: 'lemonsqueezy',
    name: 'Lemon Squeezy',
    // Lemon Squeezy's brand yellow (#FFC233) is 1.6:1 on white, under the 3:1 WCAG minimum for
    // chart marks. This darker mustard is 3.7:1 on white and 5.2:1 on the dark page.
    color: '#AD7D00',
    dotClass: 'bg-[#AD7D00]',
    tagline: 'Merchant of record for software',
    fields: [
      {
        name: 'apiKey',
        label: 'API key',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'eyJ0eXAiOiJKV1Qi…',
      },
      {
        name: 'storeId',
        label: 'Store ID',
        type: 'text',
        required: false,
        secret: false,
        placeholder: 'All stores',
        help: 'Optional. Leave empty to include every store this key can see.',
      },
    ],
    keySteps: [
      'Open Settings → API in your Lemon Squeezy dashboard.',
      'Create a new API key named “hoomuch”.',
      'Copy the key (it is shown only once) and paste it here.',
    ],
    keyUrl: 'https://app.lemonsqueezy.com/settings/api',
    // Lemon Squeezy keys can't be scoped, so there is no permission checklist to show.
    permissions: [],
    warning:
      'Lemon Squeezy API keys can’t be limited, so this key has full access to your account. hoomuch only reads your stores, subscriptions, prices, discounts, orders and invoices, and stores the key encrypted. Treat it like a password.',
    revenueHistory: 'transactions',
    productNames: true,
    mrrByProduct: false,
    webhook: {
      steps: [
        'In Lemon Squeezy, open Settings » Webhooks and click the plus icon.',
        'Paste this URL as the Callback URL. The Signing secret is required, but hoomuch doesn’t check it: type any 6 to 40 characters.',
        'Tick the events below and save.',
      ],
      events: [
        'order_created',
        'order_refunded',
        'subscription_created',
        'subscription_updated',
        'subscription_payment_success',
        'subscription_payment_refunded',
      ],
      note: 'Test-mode webhooks only fire for test data: add it in the mode this key belongs to.',
    },
  },
  {
    id: 'polar',
    name: 'Polar',
    color: '#0E9384',
    dotClass: 'bg-[#0E9384]',
    tagline: 'Merchant of record for developers',
    fields: [
      {
        name: 'apiKey',
        label: 'Organization access token',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'polar_oat_…',
        help: 'Starts with polar_oat_. Sandbox tokens work too: hoomuch detects which environment the token belongs to.',
      },
    ],
    keySteps: [
      'Open Settings → Access Tokens in your Polar dashboard (on sandbox.polar.sh for a sandbox organization).',
      'Create a new token and name it “hoomuch”.',
      'Set Expiration to 365 days, or “No expiration” if you don’t want to replace it.',
      'Under Scopes, select only the four read scopes listed below.',
      'Create the token, copy it (Polar shows it only once) and paste it here.',
    ],
    keyUrl: 'https://polar.sh/to/dashboard/settings/access-tokens',
    permissions: ['metrics:read', 'subscriptions:read', 'orders:read', 'refunds:read'],
    warning:
      'Polar access tokens stop working on their expiration date (the form defaults to 30 days). When this one lapses, hoomuch shows an error on the connection and you can paste a new token there.',
    revenueHistory: 'transactions',
    productNames: true,
    mrrByProduct: false,
    webhook: {
      steps: [
        'In your Polar organization, open Settings → Webhooks and click Add Endpoint.',
        'Paste this URL and choose Raw as the format. Any secret works: hoomuch doesn’t check it.',
        'Tick the events below and save.',
      ],
      events: ['subscription.created', 'subscription.updated', 'order.paid', 'order.refunded'],
      note: 'Sandbox is a separate environment: add it in the organization this token belongs to.',
    },
  },
  {
    id: 'revenuecat',
    name: 'RevenueCat',
    color: '#F2545B',
    dotClass: 'bg-[#F2545B]',
    tagline: 'In-app subscriptions on iOS and Android',
    fields: [
      {
        name: 'apiKey',
        label: 'Secret API key (v2)',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'sk_…',
      },
      {
        name: 'projectId',
        label: 'Project ID',
        type: 'text',
        required: true,
        secret: false,
        placeholder: 'proj1a2b3c4d',
        help: 'Found in your RevenueCat project settings.',
      },
    ],
    keySteps: [
      'Open Project settings → API keys in RevenueCat.',
      'Create a new secret key, API version v2.',
      'Set the permissions below to Read only and everything else to No access.',
      'Paste the key and your Project ID here.',
    ],
    keyUrl: 'https://app.revenuecat.com/',
    permissions: [
      'charts_metrics:overview:read — required',
      'charts_metrics:charts:read — optional, enables daily revenue history',
    ],
    revenueHistory: 'daily',
    dayZone: { tz: 'UTC', label: 'UTC' },
    productNames: false,
    mrrByProduct: false,
  },
  {
    id: 'chargebee',
    name: 'Chargebee',
    color: '#E8590C',
    dotClass: 'bg-[#E8590C]',
    tagline: 'Subscription billing for SaaS',
    fields: [
      {
        name: 'site',
        label: 'Site',
        type: 'text',
        required: true,
        secret: false,
        placeholder: 'acme',
        help: 'The part before .chargebee.com. Test sites end in -test. A pasted site URL works too.',
      },
      {
        name: 'apiKey',
        label: 'Read-only API key',
        type: 'password',
        required: true,
        secret: true,
        help: 'Test and live sites have different keys: use one from the site above.',
      },
    ],
    keySteps: [
      'In Chargebee, open Settings → Configure Chargebee → API Keys and Events → API keys.',
      'Click “+ Add API Key” and choose “Read-Only Key”.',
      'Pick “All”, or “Restricted” with “Allow read-only access to transactional data” ticked.',
      'Name it “hoomuch”, click “Create Key”, and paste it here with your site name.',
    ],
    keyUrl: null, // the API keys page lives on each site's own subdomain
    permissions: ['Allow read-only access to transactional data'],
    revenueHistory: 'transactions',
    productNames: false,
    mrrByProduct: false,
    webhook: {
      steps: [
        'In Chargebee, open Settings → Configure Chargebee → API Keys and Webhooks, then the Webhooks tab, and click Add Webhook.',
        'Name it, paste this URL as the Webhook URL and leave basic authentication off.',
        'Under Events to Send, pick the events below instead of All Events, and click Create.',
      ],
      events: [
        'subscription_created',
        'subscription_changed',
        'subscription_cancelled',
        'subscription_reactivated',
        'payment_succeeded',
        'payment_refunded',
      ],
      note: 'A site has at most 5 webhooks, and test and live are separate sites.',
    },
  },
  {
    id: 'dodo',
    name: 'Dodo Payments',
    color: '#4E9418',
    dotClass: 'bg-[#4E9418]',
    tagline: 'Merchant of record for digital products',
    fields: [
      {
        name: 'apiKey',
        label: 'API key',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'dodo_live_…',
        help: 'Starts with dodo_live_ (or dodo_test_ for a test mode key).',
      },
    ],
    keySteps: [
      'Open Developer → API Keys in your Dodo Payments dashboard. Turn on Live Mode in the sidebar first, or leave it off for a test key.',
      'Click “Create New Key” and name it “hoomuch”.',
      'Set Subscriptions and Balances to Read and everything else to None. Leave the IP Allowlist empty.',
      'Create the key, copy it (it is shown only once) and paste it here.',
    ],
    keyUrl: 'https://app.dodopayments.com/',
    permissions: ['Subscriptions: Read', 'Balances: Read'],
    revenueHistory: 'daily',
    dayZone: { tz: 'UTC', label: 'UTC' },
    productNames: false,
    mrrByProduct: false,
    webhook: {
      steps: [
        'In Dodo Payments, open Developer → Webhooks and click Add endpoint.',
        'Paste this URL, select the events below and click Create endpoint. You can ignore the signing secret.',
      ],
      events: [
        'subscription.active',
        'subscription.updated',
        'subscription.cancelled',
        'subscription.renewed',
        'payment.succeeded',
        'refund.succeeded',
      ],
      note: 'With no events selected Dodo sends every event, which works but is noisier. Test and live mode have their own webhooks.',
    },
  },
  {
    id: 'gumroad',
    name: 'Gumroad',
    // Gumroad's pink (#FF90E8) is 1.9:1 on white; this deeper pink keeps the hue at 4.6:1.
    color: '#DB2777',
    dotClass: 'bg-[#DB2777]',
    tagline: 'Merchant of record for creators',
    fields: [
      {
        name: 'apiKey',
        label: 'Access token',
        type: 'password',
        required: true,
        secret: true,
        help: 'From “Generate access token” on your application, not the application ID or secret.',
      },
    ],
    keySteps: [
      'Open Settings → Advanced in Gumroad and scroll to Applications.',
      'Create an application named “hoomuch”. For Redirect URI enter http://127.0.0.1; hoomuch never redirects.',
      'Click “Create application”, then “Generate access token”.',
      'Copy the access token and paste it here.',
    ],
    keyUrl: 'https://gumroad.com/settings/advanced#application-form',
    // Tokens generated in Settings carry every scope of their application, so there is nothing to tick.
    // hoomuch needs view_sales; verify names it if a token somehow lacks it.
    permissions: [],
    warning:
      'Gumroad access tokens made in Settings can’t be limited, so this token has full access to your account, including refunds. hoomuch only reads your profile name, products, subscribers and sales, and stores the token encrypted. Treat it like a password; deleting the application revokes it.',
    revenueHistory: 'transactions',
    productNames: true,
    mrrByProduct: false,
    webhook: {
      steps: [
        'In Gumroad, open Settings → Advanced and find the Ping section.',
        'Paste this URL as the Ping endpoint and save. Send test ping to URL checks it arrives.',
      ],
      events: [],
      note: 'Gumroad has one Ping URL per account, so this replaces any you use elsewhere (Zapier, for example). Pings cover sales; refunds and cancellations still arrive with the next scheduled sync.',
    },
  },
  {
    id: 'adapty',
    name: 'Adapty',
    color: '#0A86B4',
    dotClass: 'bg-[#0A86B4]',
    tagline: 'In-app subscriptions and paywalls for mobile apps',
    fields: [
      {
        name: 'apiKey',
        label: 'Secret API key',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'secret_live_…',
        help: 'Starts with secret_live_. Not the Public SDK key (public_live_…). Each Adapty app has its own key.',
      },
    ],
    keySteps: [
      'In the Adapty dashboard, select the app, then open App settings → General.',
      'Under API keys, copy the Secret key (it starts with secret_live_), not the Public SDK key.',
      'Paste it here. Each Adapty app has its own key, so add one connection per app.',
    ],
    keyUrl: 'https://app.adapty.io/settings/general',
    permissions: [],
    warning:
      'Adapty has no read-only keys: the Secret API key also opens Adapty’s server-side API (profiles, access levels, paywalls). hoomuch only uses it to read analytics, and stores it encrypted.',
    revenueHistory: 'daily',
    dayZone: { tz: 'UTC', label: 'UTC' },
    productNames: false,
    mrrByProduct: false,
  },
  {
    id: 'superwall',
    name: 'Superwall',
    color: '#858A00',
    dotClass: 'bg-[#858A00]',
    tagline: 'Paywalls and subscription revenue for mobile apps',
    fields: [
      {
        name: 'apiKey',
        label: 'Organization API key',
        type: 'password',
        required: true,
        secret: true,
        placeholder: 'sk_…',
        help: 'From Settings → API Keys. Not an app’s public key (pk_…).',
      },
      {
        name: 'organizationId',
        label: 'Organization ID',
        type: 'text',
        required: true,
        secret: false,
        placeholder: '1234',
        help: 'The number right after app.superwall.com/ in your dashboard’s address.',
      },
    ],
    keySteps: [
      'In the Superwall dashboard, open Settings → API Keys.',
      'Create an organization API key named “hoomuch” with only the scopes listed below, and Project access set to All projects.',
      'Copy the token (Superwall shows it only once) and paste it here.',
      'Copy your Organization ID from the dashboard address (app.superwall.com/1234/…).',
    ],
    keyUrl: 'https://superwall.com/select-application?pathname=/applications/:app/settings/api-keys',
    permissions: [
      'charts:read — required (MRR and active subscriptions)',
      'data:read — optional, enables daily revenue, refunds and active trials',
    ],
    warning:
      'Superwall’s data:read scope can query all of your organization’s analytics data. hoomuch only runs aggregate revenue queries, but treat this key as sensitive and give it no other scopes.',
    revenueHistory: 'daily',
    dayZone: { tz: 'UTC', label: 'UTC' },
    productNames: false,
    mrrByProduct: false,
  },
  {
    id: 'appstore',
    name: 'App Store Connect',
    color: '#007AFF',
    dotClass: 'bg-[#007AFF]',
    tagline: 'Sales and subscriptions on the App Store',
    fields: [
      {
        name: 'issuerId',
        label: 'Issuer ID',
        type: 'text',
        required: true,
        secret: false,
        placeholder: '57246542-96fe-1a63-e053-0824d011072a',
        help: 'Shown at the top of Users and Access → Integrations → App Store Connect API.',
      },
      {
        name: 'keyId',
        label: 'Key ID',
        type: 'text',
        required: true,
        secret: false,
        placeholder: '2X9R4HXF34',
        help: 'The 10-character ID in the key’s row. It’s also in the file name, AuthKey_2X9R4HXF34.p8.',
      },
      {
        name: 'privateKey',
        label: 'Private key (.p8)',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '-----BEGIN PRIVATE KEY-----…',
        help: 'Open the .p8 file in a text editor and paste all of it, including the BEGIN and END lines.',
      },
      {
        name: 'vendorNumber',
        label: 'Vendor number',
        type: 'text',
        required: true,
        secret: false,
        placeholder: '81234567',
        help: 'In Payments and Financial Reports, under your name in the top left.',
      },
    ],
    keySteps: [
      'In App Store Connect, open Users and Access → Integrations → App Store Connect API, on the Team Keys tab. Only an Admin can create team keys.',
      'Click “Generate API Key” (or +), name it “hoomuch”, and choose the Sales access role.',
      'Download the key (Apple offers the .p8 file only once), then copy the Issuer ID and the key’s Key ID from the same page.',
      'Copy your vendor number from Payments and Financial Reports, and paste all four here.',
    ],
    keyUrl: 'https://appstoreconnect.apple.com/access/integrations/api',
    permissions: ['Access: Sales (Finance or Admin also work, but can do more)'],
    warning:
      'App Store Connect team keys can’t be limited to reports: a key with the Sales role can also read your apps’ analytics, and an Admin key can manage your team. hoomuch only downloads Sales and Trends reports, and stores the .p8 key encrypted.',
    revenueHistory: 'daily',
    dayZone: { tz: 'America/Los_Angeles', label: 'Pacific Time' },
    productNames: false,
    mrrByProduct: true,
  },
  {
    id: 'googleplay',
    name: 'Google Play',
    color: '#1E8E3E',
    dotClass: 'bg-[#1E8E3E]',
    tagline: 'Sales and subscriptions on Google Play',
    fields: [
      {
        name: 'serviceAccountJson',
        label: 'Service account key (JSON)',
        type: 'password',
        required: true,
        secret: true,
        placeholder: '{"type": "service_account", …}',
        help: 'Open the downloaded .json key file in a text editor and paste all of it.',
      },
      {
        name: 'reportsBucket',
        label: 'Cloud Storage URI',
        type: 'text',
        required: true,
        secret: false,
        placeholder: 'gs://pubsite_prod_rev_01234567890987654321',
        help: 'In Play Console → Download reports → Financial, click “Copy Cloud Storage URI”.',
      },
    ],
    keySteps: [
      'In Google Cloud, pick or create a project, turn on the Google Play Android Developer API, and create a service account named “hoomuch” with no roles.',
      'On the service account’s Keys tab, choose Add key → Create new key → JSON, and keep the downloaded file.',
      'In Play Console → Users and permissions, invite the service account’s email with the account permissions listed below, for all apps.',
      'Copy the Cloud Storage URI from Download reports → Financial, and paste it here with the JSON key. New access can take up to a day to reach the reports.',
    ],
    keyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    keyUrlLabel: 'Open Google Cloud service accounts',
    permissions: [
      'View app information and download bulk reports (read-only)',
      'View financial data, orders and cancellation survey responses',
    ],
    warning:
      'A service account key doesn’t expire unless your organisation sets a limit, so treat the JSON file like a password. hoomuch only reads your report bucket and your apps’ subscription prices, and stores the key encrypted. Give the service account no permissions beyond the two read-only ones below.',
    revenueHistory: 'transactions',
    productNames: true,
    mrrByProduct: true,
  },
  {
    id: 'demo',
    name: 'Demo data',
    color: '#8A8F98',
    dotClass: 'bg-[#8A8F98]',
    tagline: 'Try hoomuch without an API key',
    fields: [],
    keySteps: [],
    keyUrl: null,
    permissions: [],
    revenueHistory: 'transactions',
    productNames: true,
    mrrByProduct: false,
  },
];

export function getProviderMeta(id: ProviderId): ProviderMeta {
  const meta = PROVIDERS.find((p) => p.id === id);
  if (!meta) throw new Error(`Unknown provider: ${id}`);
  return meta;
}

/**
 * Key formats that unmistakably belong to one provider. A secret pasted into another provider's
 * form is refused before anything is sent: a live Stripe key must never reach, say, Chargebee's
 * servers just because it was pasted in the wrong box (several adapters accept opaque keys).
 */
const KEY_OWNERS: ReadonlyArray<readonly [RegExp, ProviderId]> = [
  [/^(sk|rk)_(live|test)_[A-Za-z0-9]{20,}$/, 'stripe'],
  [/^pdl_(live|sdbx)_apikey_/, 'paddle'],
  [/^polar_(oat|pat)_/, 'polar'],
  [/^dodo_(live|test)_/, 'dodo'],
  [/^secret_(live|test)_/, 'adapty'],
  // A Google service-account file, and a bare PEM key (App Store Connect's .p8 is one). Both are private
  // keys: pasted into another provider's box, they must not be sent there.
  [/"type"\s*:\s*"service_account"/, 'googleplay'],
  [/^-----BEGIN (EC )?PRIVATE KEY-----/, 'appstore'],
];

/** "a" or "an" before a provider name ("a Stripe key", "an App Store Connect key"). */
export function article(name: string): 'a' | 'an' {
  return /^[AEIOU]/i.test(name) ? 'an' : 'a';
}

/** The provider a secret visibly belongs to, when that isn't `self`. */
export function foreignKeyOwner(self: ProviderId, secret: string): ProviderId | null {
  return KEY_OWNERS.find(([re, id]) => id !== self && re.test(secret))?.[1] ?? null;
}

/**
 * Splits raw form input into encrypted credentials vs plain config, trimming values
 * and checking required fields. Unknown keys are ignored.
 */
export function splitInput(
  meta: ProviderMeta,
  raw: Record<string, string | undefined>,
): { credentials: Credentials; config: ConnectionConfig; errors: Record<string, string> } {
  const credentials: Credentials = {};
  const config: ConnectionConfig = {};
  const errors: Record<string, string> = {};
  for (const f of meta.fields) {
    const v = (raw[f.name] ?? '').trim();
    if (!v) {
      if (f.required) errors[f.name] = `${f.label} is required.`;
      continue;
    }
    if (v.length > 4096) {
      errors[f.name] = `${f.label} is too long.`;
      continue;
    }
    const owner = f.secret ? foreignKeyOwner(meta.id, v) : null;
    if (owner) {
      const ownerName = getProviderMeta(owner).name;
      errors[f.name] = `That looks like ${article(ownerName)} ${ownerName} key. Paste your ${meta.name} key here.`;
      continue;
    }
    (f.secret ? credentials : config)[f.name] = v;
  }
  return { credentials, config, errors };
}
