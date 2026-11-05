/**
 * Provider metadata (Lead) + adapter lookup. Adapters live in ./<provider>.ts (Data Plane).
 */

import type { ConnectionConfig, Credentials, ProviderAdapter, ProviderId, ProviderMeta } from './types';
import { stripeAdapter } from './stripe';
import { lemonSqueezyAdapter } from './lemonsqueezy';
import { revenueCatAdapter } from './revenuecat';
import { demoAdapter } from './demo';

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
    permissions: ['Subscriptions: Read', 'Prices: Read', 'Coupons: Read', 'Balance: Read'],
    revenueHistory: 'transactions',
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
      'Lemon Squeezy API keys can’t be limited, so this key has full access to your account. hoomuch only reads stores, subscriptions, orders and invoices, and stores the key encrypted. Treat it like a password.',
    revenueHistory: 'transactions',
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
  },
];

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  stripe: stripeAdapter,
  lemonsqueezy: lemonSqueezyAdapter,
  revenuecat: revenueCatAdapter,
  demo: demoAdapter,
};

export function getProviderMeta(id: ProviderId): ProviderMeta {
  const meta = PROVIDERS.find((p) => p.id === id);
  if (!meta) throw new Error(`Unknown provider: ${id}`);
  return meta;
}

export function getAdapter(id: ProviderId): ProviderAdapter {
  return ADAPTERS[id];
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
    (f.secret ? credentials : config)[f.name] = v;
  }
  return { credentials, config, errors };
}
