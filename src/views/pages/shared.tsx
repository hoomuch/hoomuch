/**
 * Small helpers shared by page components. Owner: Experience (pages).
 * Pure: formatting and tiny presentational pieces only, no data access.
 */

import { ArrowLeft } from 'lucide-react';
import { zoneLabel } from '../../lib/time';
import type { ProviderMeta } from '../../providers/types';
import { Alert, TextLink } from '../components/ui';

/** Meta-refresh polling state for a first sync. `null` on a page means "nothing is syncing". */
export interface SyncState {
  /**
   * Meta-refresh target while polling; null once the poll budget is spent or the user stopped it.
   * `stopUrl` is the same page with refreshing turned off (WCAG 2.2.1: the user can turn it off).
   */
  refresh: { seconds: number; url: string; stopUrl?: string } | null;
  /** The user followed `stopUrl`: still syncing, but this page no longer reloads itself. */
  stopped?: boolean;
}

/** The effective sync interval in minutes: SYNC_INTERVAL_MINUTES rounded up to a 30-minute cron tick. */
export function syncIntervalMinutes(intervalMinutes: string | undefined): number {
  const n = Number(intervalMinutes);
  return Math.max(30, Math.ceil((Number.isFinite(n) && n > 0 ? n : 60) / 30) * 30);
}

/**
 * How often a connection syncs, in words: "every hour", "every 30 minutes", "every 2 hours".
 * The cron ticks every 30 minutes, so the effective cadence is SYNC_INTERVAL_MINUTES rounded up
 * to a tick (the engine subtracts a small grace, so 60 really is hourly).
 */
export function syncCadence(intervalMinutes: string | undefined): string {
  const minutes = syncIntervalMinutes(intervalMinutes);
  if (minutes % 60 !== 0) return `every ${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? 'every hour' : `every ${hours} hours`;
}

/** "A", "A and B", "A, B and C". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The first-sync notice. Right after connecting it is the confirmation (there's no "Connected."
 * flash on top), so it names what was connected. `note` adds one plain sentence.
 */
export function SyncNotice(props: {
  sync: SyncState;
  /** Connections waiting for their first sync, by name. */
  connected?: string[];
  /** e.g. "Demo data removed, so your totals are real." */
  note?: string;
}) {
  const { refresh } = props.sync;
  const names = props.connected ?? [];
  const lead = names.length > 0 ? `Connected to ${listNames(names)}. ` : '';
  const whose = names.length > 1 ? 'their' : names.length === 1 ? 'its' : 'your';
  const note = props.note ? ` ${props.note}` : '';
  return (
    <Alert tone="info" title="Syncing…" role="status">
      {refresh ? (
        <>
          {lead}Adding up {whose} first 90 days, usually in a few seconds.{note} This page refreshes on its own.
          {refresh.stopUrl ? (
            <>
              {' '}
              <TextLink href={refresh.stopUrl}>Stop refreshing</TextLink>
            </>
          ) : null}
        </>
      ) : props.sync.stopped ? (
        `${lead}Automatic refresh is off. Reload the page to check on it.${note}`
      ) : (
        `${lead}This is taking longer than usual. Reload the page in a minute.${note}`
      )}
    </Alert>
  );
}

/** A quiet "← Back" link above a page header. The arrow is decoration, not part of the name. */
export function BackLink(props: { href: string; label: string }) {
  return (
    <p className="mb-4 text-body">
      <a href={props.href} className="inline-flex items-center gap-1 rounded-md text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-3.5 shrink-0" />
        {props.label}
      </a>
    </p>
  );
}

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const whenFormats = new Map<string, Intl.DateTimeFormat>();
const yearFormats = new Map<string, Intl.DateTimeFormat>();

function cached(cache: Map<string, Intl.DateTimeFormat>, tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = cache.get(tz);
  if (!f) cache.set(tz, (f = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts })));
  return f;
}

const DAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });

/** "Nov 5, 2026, 10:23" in `tz` (the user's zone; UTC by default). */
export function formatDateTime(ms: number, tz: string = 'UTC'): string {
  return cached(dateTimeFormats, tz, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(ms),
  );
}

/** "UTC", or the zone's name for a label: "Europe/Istanbul", "America/New York". */
export function zoneName(tz: string): string {
  return zoneLabel(tz);
}

/**
 * "Nov 4, 09:14 UTC" (or "… Europe/Istanbul"); the year is added when it isn't the current one
 * ("Dec 30, 2025, 09:14 UTC").
 */
export function formatWhen(ms: number, now: number = Date.now(), tz: string = 'UTC'): string {
  const year = cached(yearFormats, tz, { year: 'numeric' });
  if (year.format(new Date(ms)) !== year.format(new Date(now))) return `${formatDateTime(ms, tz)} ${zoneName(tz)}`;
  return `${cached(whenFormats, tz, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms))} ${zoneName(tz)}`;
}

/** 'YYYY-MM-DD' → "Nov 5, 2026". */
export function formatDay(day: string): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(ms) ? day : DAY_FMT.format(new Date(ms));
}

/** "<1 s", "2.3 s", "48 s", "2 min 5 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1 s';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** Label for a stored config key: the provider's field label if it has one, else "storeId" → "Store id". */
function configLabel(meta: ProviderMeta, key: string): string {
  const field = meta.fields.find((f) => f.name === key);
  if (field) return field.label;
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Config keys that are internal or already shown elsewhere (test mode has its own badge). */
const HIDDEN_CONFIG_KEYS = new Set(['testMode', 'seed', 'anchor']);

/** `storeCurrencies` is a JSON map of store id → currency; show the distinct currencies. */
function storeCurrencies(json: string): string | null {
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== 'object') return null;
    const cur = [...new Set(Object.values(v as Record<string, unknown>).filter((x): x is string => typeof x === 'string'))];
    return cur.length > 0 ? cur.sort().join(', ') : null;
  } catch {
    return null;
  }
}

/**
 * Human-readable, non-secret config rows for the connection page. Secret fields are dropped
 * defensively; adapter-written keys get friendly labels and values; demo config is internal.
 */
export function describeConfig(meta: ProviderMeta, config: Record<string, string>): { label: string; value: string }[] {
  if (meta.id === 'demo') return [];
  const secret = new Set(meta.fields.filter((f) => f.secret).map((f) => f.name));
  const rows: { label: string; value: string }[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (secret.has(key) || HIDDEN_CONFIG_KEYS.has(key) || !value) continue;
    if (key === 'storeCurrencies') {
      const cur = storeCurrencies(value);
      if (cur) rows.push({ label: cur.includes(',') ? 'Store currencies' : 'Store currency', value: cur });
    } else if (key === 'revenueHistory') {
      // 'none': the key can't read the provider's daily history (RevenueCat Charts, Adapty, Superwall data:read).
      rows.push({ label: 'Revenue history', value: value === 'daily' ? 'Daily' : 'No daily history with this key' });
    } else {
      rows.push({ label: configLabel(meta, key), value });
    }
  }
  return rows;
}
