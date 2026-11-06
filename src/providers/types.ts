/**
 * PROVIDER ADAPTER CONTRACT. Owner: Lead — changes need Lead approval (SPEC.md §9.1).
 *
 * An adapter is a pure translation layer between one billing provider's API and
 * hoomuch's normalized model. Adapters:
 *   - never touch D1, env or the clock directly (use ctx.now / ctx.fetch),
 *   - return money as integer minor units + ISO 4217 code,
 *   - never return or log end-customer PII (emails, names, addresses),
 *   - throw ProviderError for every expected failure.
 */

import type { MoneyMap } from '../lib/money';

export type ProviderId =
  | 'stripe'
  | 'paddle'
  | 'lemonsqueezy'
  | 'polar'
  | 'revenuecat'
  | 'chargebee'
  | 'dodo'
  | 'gumroad'
  | 'adapty'
  | 'superwall'
  | 'appstore'
  | 'googleplay'
  | 'demo';

/** Every id the app accepts. The database no longer checks this (migration 0003): this list is the guard. */
export const PROVIDER_IDS: readonly ProviderId[] = [
  'stripe',
  'paddle',
  'lemonsqueezy',
  'polar',
  'revenuecat',
  'chargebee',
  'dodo',
  'gumroad',
  'adapty',
  'superwall',
  'appstore',
  'googleplay',
  'demo',
];

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v);
}

// ---------- metadata (drives the "add connection" UI) ----------

export interface CredentialField {
  /** Form field name and key inside credentials/config. */
  name: string;
  label: string;
  type: 'password' | 'text';
  required: boolean;
  /** true → stored encrypted in `credentials`; false → stored in plain `config`. */
  secret: boolean;
  placeholder?: string;
  help?: string;
}

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  /** Brand hex, for SVG fill/stroke attributes (charts). */
  color: string;
  /** Literal Tailwind class for the brand dot, e.g. "bg-[#635BFF]" (CSP forbids inline styles). */
  dotClass: string;
  tagline: string;
  fields: CredentialField[];
  /** Short, ordered steps to create a key. */
  keySteps: string[];
  /** Deep link to where the key is created, if any. */
  keyUrl: string | null;
  /** Link text when `keyUrl` isn't the provider's own dashboard (default "Open <name>"). */
  keyUrlLabel?: string;
  /** Read permissions the key needs, shown as a checklist. */
  permissions: string[];
  /** Shown prominently on the form, e.g. "Lemon Squeezy keys have full account access." */
  warning?: string;
  /** How revenue history is sourced (SPEC §6). */
  revenueHistory: 'transactions' | 'daily' | 'none';
  /**
   * Its revenue events carry a product or plan name (`RevenueEvent.description`), so the dashboard
   * can split revenue by product. False for providers that report daily totals only.
   */
  productNames: boolean;
  /**
   * Its snapshots can split MRR by product (`MetricsSnapshot.mrrByProduct`), when the key allows
   * reading product names. The dashboard's "By product" card shows that split.
   */
  mrrByProduct: boolean;
}

// ---------- runtime ----------

export interface ProviderContext {
  /** Injected so tests can replay fixtures. */
  fetch: typeof fetch;
  /** Epoch ms. */
  now: () => number;
  /** Structured log. Never pass secrets or customer PII. */
  log: (event: string, data?: Record<string, unknown>) => void;
  /** Max upstream HTTP requests for this call. Stop and return a cursor when exhausted. */
  pageBudget: number;
}

/** Secret fields (decrypted). */
export type Credentials = Record<string, string>;
/** Non-secret fields + adapter-discovered config (e.g. store currencies). */
export type ConnectionConfig = Record<string, string>;

export interface ConnectionInput {
  credentials: Credentials;
  config: ConnectionConfig;
}

export type VerifyResult =
  | {
      ok: true;
      /** Human label for the account, e.g. "Acme Inc." or "Store: Acme (EUR)". */
      accountLabel: string;
      /** Config to persist (merged over the user's non-secret fields). */
      config: ConnectionConfig;
      testMode: boolean;
      /** Non-fatal notes, e.g. "Full-access secret key — prefer a restricted key." */
      warnings: string[];
    }
  | {
      ok: false;
      error: string;
      /** Form field the error belongs to, if any. */
      field?: string;
    };

export interface MetricsSnapshot {
  mrr: MoneyMap;
  activeSubscriptions: number;
  activeTrials: number | null;
  /** Provider-reported trailing revenue (gross − refunds), if available. */
  revenuePeriod: MoneyMap | null;
  /** Window of `revenuePeriod` in days (30; RevenueCat reports 28). */
  revenuePeriodDays: number | null;
  newCustomers: number | null;
  /**
   * `mrr` split by product, for providers whose meta sets `mrrByProduct`. Absent or null when the
   * provider doesn't split it or couldn't this time (e.g. the key can't read product names).
   */
  mrrByProduct?: ProductMrr[] | null;
}

export interface SnapshotHistoryRequest {
  /** How many days before today to return at most. Today itself comes from `fetchSnapshot`. */
  days: number;
}

/** One past day's snapshot, as `fetchSnapshot` would have reported it at the end of that day. */
export interface SnapshotHistoryPoint {
  /** 'YYYY-MM-DD', before today. */
  day: string;
  snapshot: MetricsSnapshot;
}

/** One product's part of a snapshot's MRR. */
export interface ProductMrr {
  /** Product or plan name as the provider shows it. Never customer PII. Null if it couldn't be read. */
  name: string | null;
  /** Same rules as `MetricsSnapshot.mrr`. Across a snapshot's entries these add up to it. */
  mrr: MoneyMap;
  /** Subscriptions counted in `activeSubscriptions` that include this product. */
  subscriptions: number;
}

export interface RevenueEvent {
  /** Stable, unique within the connection (used for idempotent upserts). */
  externalId: string;
  /** Epoch ms. */
  occurredAt: number;
  type: 'charge' | 'refund';
  /** Signed minor units: charges > 0, refunds < 0. */
  amount: number;
  currency: string;
  /** Provider fee in the same currency, if known. */
  fee: number | null;
  /** Product / plan name. Never customer PII. */
  description: string | null;
}

export interface DailyRevenuePoint {
  /** 'YYYY-MM-DD' UTC. */
  day: string;
  currency: string;
  /** Minor units, >= 0. */
  gross: number;
  /** Minor units, >= 0 (positive number). */
  refunds: number;
  count: number;
}

export interface RevenueRequest {
  /** Fetch revenue that occurred at or after this epoch ms. */
  since: number;
  /** Opaque cursor returned by a previous call that ran out of pageBudget. */
  cursor: string | null;
}

export interface RevenuePage {
  /** For revenueHistory = 'transactions'. */
  events: RevenueEvent[];
  /** For revenueHistory = 'daily' (pre-aggregated by the provider). */
  daily: DailyRevenuePoint[];
  /** Non-null when pageBudget ran out; pass it back to continue. */
  nextCursor: string | null;
  /** True when everything since `since` has been returned. */
  done: boolean;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  /** Live, read-only check of the credentials. Should cost at most ~4 requests (one probe per permission). */
  verify(input: ConnectionInput, ctx: ProviderContext): Promise<VerifyResult>;
  /** Current MRR / subscriptions / trials. */
  fetchSnapshot(input: ConnectionInput, ctx: ProviderContext): Promise<MetricsSnapshot>;
  /**
   * Optional: snapshots for days before today, so a new connection's MRR trend starts with
   * history instead of a single point. Called once, on the connection's first successful sync,
   * right after `fetchSnapshot` and with the same context (and what's left of its budget).
   * Oldest first. Days that already have a snapshot keep it; a failure here doesn't fail the sync.
   */
  fetchSnapshotHistory?(
    input: ConnectionInput,
    req: SnapshotHistoryRequest,
    ctx: ProviderContext,
  ): Promise<SnapshotHistoryPoint[]>;
  /** Revenue since `req.since`, resumable via cursor. */
  fetchRevenue(input: ConnectionInput, req: RevenueRequest, ctx: ProviderContext): Promise<RevenuePage>;
}

// ---------- errors ----------

export type ProviderErrorKind =
  | 'auth' // invalid / revoked key
  | 'permission' // key lacks a required scope
  | 'rate_limit'
  | 'upstream' // 5xx, network, unexpected payload
  | 'invalid_input' // bad field value (e.g. wrong key prefix)
  | 'not_found'; // project / store id doesn't exist

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  readonly field: string | undefined;

  constructor(kind: ProviderErrorKind, message: string, opts: { status?: number; field?: string } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = opts.status;
    this.field = opts.field;
  }
}
