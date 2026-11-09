/**
 * Shared helpers for route handlers. Owner: Experience (routes).
 * Handlers stay thin: parse + validate input here, call lib/data/services, render a page or PRG.
 */

import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { ConnectionSummary } from '../data/types';
import type { AppEnv } from '../env';
import { publicPagesEnabled } from '../lib/public-pages';
import type { PageChrome } from '../views/layout';
import type { SyncState } from '../views/pages/shared';

export type AppContext = Context<AppEnv>;

/** The request-derived bits every page needs. */
export function chrome(c: AppContext): PageChrome {
  const chrome: PageChrome = { user: c.get('user') ?? null, flash: c.get('flash') ?? null };
  // Only when set, so every other page's payload stays exactly as it was.
  if (c.get('celebrate')) chrome.celebrate = true;
  if (publicPagesEnabled(c.env)) {
    if (chrome.user) chrome.share = true;
    else chrome.explore = true;
  }
  return chrome;
}

// ---------- forms ----------

/** Forms are tiny; anything bigger than this is not a browser submitting one of our forms. */
export const formLimit = bodyLimit({
  maxSize: 32 * 1024,
  onError: (c) => c.text('Request body too large.', 413),
});

export interface FormFields {
  /** Trimmed string value, capped at `max` characters ('' when absent or a File). The last one if repeated. */
  text(name: string, max?: number): string;
  /** Untrimmed value (passwords, API keys), capped at `max` characters. */
  secret(name: string, max?: number): string;
  /** Every value posted under `name` (checkbox groups), trimmed, at most `limit` of them. */
  all(name: string, max?: number, limit?: number): string[];
}

/**
 * Parses urlencoded / multipart bodies, keeping only string values (File parts are ignored).
 * A malformed body is the client's fault: 400, not a logged 500.
 */
export async function readForm(c: AppContext): Promise<FormFields> {
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch {
    throw new HTTPException(400, { message: 'Malformed form body.' });
  }
  const values = new Map<string, string[]>();
  for (const [k, v] of Object.entries(body)) {
    const list = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');
    if (list.length > 0) values.set(k, list);
  }
  const last = (name: string) => values.get(name)?.at(-1) ?? '';
  return {
    text: (name, max = 256) => last(name).trim().slice(0, max),
    secret: (name, max = 1024) => last(name).slice(0, max),
    all: (name, max = 256, limit = 50) => (values.get(name) ?? []).slice(0, limit).map((v) => v.trim().slice(0, max)),
  };
}

// ---------- params ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Connection ids are lowercase UUIDs (crypto.randomUUID). Anything else is a 404. */
export function isUuid(v: string | undefined): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

const MAX_PAGE = 10_000;

/** Positive integer page number; junk → 1, capped at MAX_PAGE. */
export function parsePage(v: string | undefined): number {
  if (!v || !/^\d{1,6}$/.test(v)) return 1;
  return Math.min(Math.max(Number(v), 1), MAX_PAGE);
}

// ---------- first-sync polling (zero JS, bounded) ----------

export const POLL_SECONDS = 5;
/**
 * Refreshes before the page stops polling: 5 minutes, past the longest a sync can run
 * (sync/engine.ts: SYNC_DEADLINE_MS + HARD_STOP_GRACE_MS) and the moment the queue takes to start it.
 */
export const MAX_POLLS = 60;
/** `?poll=` value meaning "the user turned automatic refresh off" (WCAG 2.2.1 Timing Adjustable). */
export const POLL_STOPPED = MAX_POLLS + 1;

export function parsePoll(v: string | undefined): number {
  if (!v || !/^\d{1,3}$/.test(v)) return 0;
  return Math.min(Number(v), POLL_STOPPED);
}

/** Pending or syncing, and has never finished a sync. */
export function awaitingFirstSync(c: Pick<ConnectionSummary, 'status' | 'lastSyncedAt'>): boolean {
  return (c.status === 'pending' || c.status === 'syncing') && c.lastSyncedAt === null;
}

/**
 * Builds the page's SyncState: refresh to `urlFor(poll + 1)` every POLL_SECONDS until
 * MAX_POLLS is reached, then keep the notice but stop refreshing. While it refreshes, the page
 * offers `urlFor(POLL_STOPPED)` as a "stop refreshing" link; that URL never refreshes.
 */
export function syncState(active: boolean, poll: number, urlFor: (nextPoll: number) => string): SyncState | null {
  if (!active) return null;
  if (poll >= POLL_STOPPED) return { refresh: null, stopped: true };
  if (poll >= MAX_POLLS) return { refresh: null };
  return { refresh: { seconds: POLL_SECONDS, url: urlFor(poll + 1), stopUrl: urlFor(POLL_STOPPED) } };
}
