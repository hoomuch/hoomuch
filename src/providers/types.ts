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

export type ProviderId = 'stripe' | 'lemonsqueezy' | 'revenuecat' | 'demo';

export const PROVIDER_IDS: readonly ProviderId[] = ['stripe', 'lemonsqueezy', 'revenuecat', 'demo'];

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
  /** Read permissions the key needs, shown as a checklist. */
  permissions: string[];
  /** Shown prominently on the form, e.g. "Lemon Squeezy keys have full account access." */
  warning?: string;
  /** How revenue history is sourced (SPEC §6). */
  revenueHistory: 'transactions' | 'daily' | 'none';
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
  /** Live, read-only check of the credentials. Should cost at most ~3 requests. */
  verify(input: ConnectionInput, ctx: ProviderContext): Promise<VerifyResult>;
  /** Current MRR / subscriptions / trials. */
  fetchSnapshot(input: ConnectionInput, ctx: ProviderContext): Promise<MetricsSnapshot>;
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
