/**
 * Adapter lookup: provider id → adapter. Only the sync engine and the connection services call
 * adapters; pages, read models and the browser bundle read ./registry.ts, which imports none of them.
 */

import type { ProviderAdapter, ProviderId } from './types';
import { stripeAdapter } from './stripe';
import { lemonSqueezyAdapter } from './lemonsqueezy';
import { revenueCatAdapter } from './revenuecat';
import { paddleAdapter } from './paddle';
import { polarAdapter } from './polar';
import { chargebeeAdapter } from './chargebee';
import { dodoAdapter } from './dodo';
import { gumroadAdapter } from './gumroad';
import { adaptyAdapter } from './adapty';
import { superwallAdapter } from './superwall';
import { appStoreAdapter } from './appstore';
import { googlePlayAdapter } from './googleplay';
import { demoAdapter } from './demo';

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  stripe: stripeAdapter,
  paddle: paddleAdapter,
  lemonsqueezy: lemonSqueezyAdapter,
  polar: polarAdapter,
  revenuecat: revenueCatAdapter,
  chargebee: chargebeeAdapter,
  dodo: dodoAdapter,
  gumroad: gumroadAdapter,
  adapty: adaptyAdapter,
  superwall: superwallAdapter,
  appstore: appStoreAdapter,
  googleplay: googlePlayAdapter,
  demo: demoAdapter,
};

export function getAdapter(id: ProviderId): ProviderAdapter {
  return ADAPTERS[id];
}
