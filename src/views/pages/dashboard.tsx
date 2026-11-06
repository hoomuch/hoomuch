/**
 * Dashboard (GET /dashboard?range=). Owner: Experience (pages). Layout and copy: design/system.md §5.1.
 *
 * Order follows the question "how much am I making?": the MRR with its change and trend, whether
 * that number can be trusted (freshness, and a line for anything missing or out of date), the
 * other figures, where the money comes from, then cash per day. A warning sits next to the
 * figure it affects; nothing is left at the bottom of the page.
 */

import { Info, TriangleAlert, X } from 'lucide-react';
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from 'motion/react';
import { type ReactNode, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button as CossButton } from '@/components/ui/button';
import { Card as CossCard, CardPanel } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { CalendarMonth, ConnectionSummary, DashboardData, MrrDay } from '../../data/types';
import { formatMoney, formatNumber, toMinor } from '../../lib/money';
import { addDays, dayKey, HOUR, MINUTE } from '../../lib/time';
import { cn } from '../../lib/utils';
import { MrrChart } from '../charts/mrr-chart';
import { RevenueChart } from '../charts/revenue-chart';
import { BreakdownTable } from '../components/breakdown-table';
import { CalendarCard } from '../components/calendar-card';
import { EmptyState } from '../components/empty-state';
import { FLAT, KpiStat } from '../components/kpi';
import { Owl, type OwlPose } from '../components/mascot';
import { ProductMrrTable, ProductTable } from '../components/product-table';
import { RangeTabs } from '../components/range-tabs';
import { RelativeTime } from '../components/relative-time';
import { Alert, Button, Card, LinkButton, LinkSubmit, PageHeader, TextLink } from '../components/ui';
import { Layout, type PageChrome } from '../layout';
import { useNow } from '../page-root';
import { formatDay, formatWhen, listNames, SyncNotice, type SyncState } from './shared';

export interface DashboardPageProps {
  chrome: PageChrome;
  data: DashboardData;
  /** The user's connections; empty → the "connect your first account" state. */
  connections: ConnectionSummary[];
  /** Non-null while a connection is waiting for its first sync. */
  sync: SyncState | null;
  /** Range tab links; defaults to "/dashboard". */
  basePath?: string;
  /** How often connections sync, in words ("every hour"). */
  cadence?: string;
  /** A healthy connection whose last sync is older than this reads as stale. Default: 120. */
  staleAfterMinutes?: number;
  /** Clock for relative times (fixtures pin it). Defaults to the request's clock. */
  now?: number;
  /**
   * The first sync just finished: show the one-time "There it is" strip. `dismissHref` is the
   * same dashboard without the trigger, so dismissing is a plain link before hydration (no stored
   * state); after hydration it animates out and replaces the URL.
   */
  celebrate?: { dismissHref: string } | null;
  /** The first real connection just replaced demo data: the notice or the strip says so. */
  demoRemoved?: boolean;
  /** The display currency was just picked from the user's numbers (once): say so, and where to change it. */
  currencyInferred?: string | null;
  /** One month, day by day (?month=, ?day=). Absent on the landing demo and in older fixtures. */
  calendar?: CalendarMonth | null;
  /** The calendar day picked in the URL (?day=), opened on first paint. */
  calendarDay?: string | null;
}

const DEMO_REMOVED = 'Demo data removed, so your totals are real.';

/** Shared "connect / try demo" actions (also used by other empty states). */
export function ConnectActions() {
  return (
    <>
      <LinkButton href="/connections/new">Add connection</LinkButton>
      <form method="post" action="/connections/demo">
        <Button variant="secondary">Try demo data</Button>
      </form>
    </>
  );
}

// ---------- milestones ----------

/** A milestone stays on the dashboard this many days after it's crossed. */
const MILESTONE_DAYS = 7;

/** The highest milestone at or below `major`: 1k, 2.5k, 5k, 10k, then every 10k. */
export function milestoneAtOrBelow(major: number): number | null {
  if (!(major >= 1000)) return null;
  if (major < 2500) return 1000;
  if (major < 5000) return 2500;
  if (major < 10_000) return 5000;
  return Math.floor(major / 10_000) * 10_000;
}

/**
 * The highest milestone (major units of the display currency) that MRR crossed in the last
 * MILESTONE_DAYS days and still holds today, or null. A crossing needs the day before it in the
 * series, so one on the window's first day, or an account that started above it, isn't claimed.
 */
export function recentMilestone(series: MrrDay[], currency: string, today: string): number | null {
  const latest = series.at(-1);
  if (!latest) return null;
  const unit = toMinor(1, currency);
  const since = addDays(today, -(MILESTONE_DAYS - 1));
  let best: number | null = null;
  for (let k = series.length - 1; k >= 1; k--) {
    const cur = series[k]!;
    if (cur.day < since) break;
    const m = milestoneAtOrBelow(cur.total / unit);
    if (m !== null && series[k - 1]!.total < m * unit && latest.total >= m * unit && (best === null || m > best)) best = m;
  }
  return best;
}

// ---------- trust: freshness and completeness ----------

export interface Freshness {
  /** fresh/stale: the oldest healthy sync · down: every connection failing · never: no sync yet. */
  kind: 'fresh' | 'stale' | 'down' | 'never';
  ms: number | null;
}

/** How fresh the numbers are: the oldest successful sync among connections that aren't failing. */
export function freshness(connections: ConnectionSummary[], now: number, staleAfterMs: number): Freshness {
  const healthy = connections.filter((c) => c.status !== 'error' && c.lastSyncedAt !== null).map((c) => c.lastSyncedAt!);
  if (healthy.length > 0) {
    const ms = Math.min(...healthy);
    return { kind: now - ms > staleAfterMs ? 'stale' : 'fresh', ms };
  }
  const any = connections.filter((c) => c.lastSyncedAt !== null).map((c) => c.lastSyncedAt!);
  return any.length > 0 ? { kind: 'down', ms: Math.max(...any) } : { kind: 'never', ms: null };
}

function FreshnessLabel(props: { freshness: Freshness; now: number }) {
  const f = props.freshness;
  if (f.kind === 'never' || f.ms === null) return <p className="text-body text-muted-foreground">Not synced yet</p>;
  const warn = f.kind !== 'fresh';
  return (
    <p className={cn('flex items-center gap-1.5 text-body', warn ? 'text-warning-foreground' : 'text-muted-foreground')}>
      {warn ? <TriangleAlert className="size-4 shrink-0" /> : null}
      <span>
        {f.kind === 'down' ? 'Last updated' : 'Updated'} <RelativeTime ms={f.ms} now={props.now} />
      </span>
    </p>
  );
}

export interface DashboardNote {
  tone: 'warning' | 'info';
  text: string;
  link?: { href: string; label: string };
  /** A one-click fix posted from the note itself (reversible ones only; the result offers Undo). */
  form?: { action: string; label: string; fields?: Record<string, string> };
}

/** At most this many lines; past it, the rest fold into one "need a look" line. */
const MAX_NOTES = 3;

/**
 * What the MRR leaves out or shows out of date, one sentence each (design/system.md §5.1).
 * `firstSyncShown`: the sync notice already says a first sync is running, so don't repeat it.
 */
export function completenessNotes(input: {
  connections: ConnectionSummary[];
  fxMissing: string[];
  /** DashboardData.warnings: anything the structured fields don't cover. */
  extra?: string[];
  now: number;
  staleAfterMs: number;
  firstSyncShown?: boolean;
}): DashboardNote[] {
  const cs = input.connections;
  const when = (ms: number) => formatWhen(ms, input.now);
  const notes: DashboardNote[] = [];
  const toConnections = { href: '/connections', label: 'See connections' };

  const failed = cs.filter((c) => c.status === 'error');
  if (cs.length > 1 && failed.length === cs.length) {
    const last = Math.max(0, ...failed.map((c) => c.lastSyncedAt ?? 0));
    notes.push({
      tone: 'warning',
      text:
        last > 0
          ? `None of your connections has synced since ${when(last)}.`
          : 'None of your connections has synced yet. Their first syncs failed.',
      link: toConnections,
    });
  } else if (failed.length === 1) {
    const c = failed[0]!;
    notes.push({
      tone: 'warning',
      text:
        c.lastSyncedAt !== null
          ? `${c.name} is showing numbers from ${when(c.lastSyncedAt)}. Its last sync failed.`
          : `${c.name} isn’t counted. Its first sync failed.`,
      link: { href: `/connections/${c.id}`, label: 'Fix it' },
    });
  } else if (failed.length > 1) {
    notes.push({
      tone: 'warning',
      text: `${failed.length} connections are behind: ${listNames(failed.map((c) => c.name))}. Their last syncs failed.`,
      link: toConnections,
    });
  }

  const stale = cs.filter((c) => c.status !== 'error' && c.lastSyncedAt !== null && input.now - c.lastSyncedAt > input.staleAfterMs);
  if (stale.length === 1) {
    const c = stale[0]!;
    notes.push({
      tone: 'warning',
      text: `${c.name} hasn’t synced since ${when(c.lastSyncedAt!)}.`,
      link: { href: `/connections/${c.id}`, label: 'See why' },
    });
  } else if (stale.length > 1) {
    const hours = Math.round(input.staleAfterMs / HOUR);
    notes.push({
      tone: 'warning',
      text: `${listNames(stale.map((c) => c.name))} haven’t synced for more than ${hours} ${hours === 1 ? 'hour' : 'hours'}.`,
      link: toConnections,
    });
  }

  if (!input.firstSyncShown) {
    const pending = cs.filter((c) => (c.status === 'pending' || c.status === 'syncing') && c.lastSyncedAt === null);
    if (pending.length === 1) {
      notes.push({ tone: 'info', text: `${pending[0]!.name} isn’t counted yet. Its first sync is running.` });
    } else if (pending.length > 1) {
      notes.push({ tone: 'info', text: `${listNames(pending.map((c) => c.name))} aren’t counted yet. Their first syncs are running.` });
    }
  }

  const fx = input.fxMissing;
  if (fx.length === 1) {
    notes.push({ tone: 'warning', text: `${fx[0]} amounts aren’t included. There’s no exchange rate for ${fx[0]} yet.` });
  } else if (fx.length > 1) {
    notes.push({ tone: 'warning', text: `${listNames(fx)} amounts aren’t included. There are no exchange rates for them yet.` });
  }

  const demo = cs.find((c) => c.provider === 'demo');
  if (demo && cs.some((c) => c.provider !== 'demo')) {
    notes.push({
      tone: 'warning',
      text: 'Includes demo data, so these totals aren’t all real.',
      form: { action: `/connections/${demo.id}/delete`, label: 'Remove demo data', fields: { back: '/dashboard' } },
    });
  }

  for (const w of input.extra ?? []) notes.push({ tone: 'warning', text: w });

  if (notes.length <= MAX_NOTES) return notes;
  const rest = notes.length - (MAX_NOTES - 1);
  return [...notes.slice(0, MAX_NOTES - 1), { tone: 'warning', text: `${rest} more things need a look.`, link: toConnections }];
}

function NoteList(props: { notes: DashboardNote[] }) {
  return (
    <ul className="mt-5 space-y-2 border-t pt-4">
      {props.notes.map((n) => (
        <li key={n.text} className="flex items-start gap-2 text-body">
          {n.tone === 'warning' ? (
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0 text-info" />
          )}
          <span>
            <span className="sr-only">{n.tone === 'warning' ? 'Warning: ' : 'Note: '}</span>
            {n.text}
            {n.link ? (
              <>
                {' '}
                <TextLink href={n.link.href}>{n.link.label}</TextLink>
              </>
            ) : null}
            {n.form ? (
              <>
                {' '}
                <form method="post" action={n.form.action} className="inline">
                  {Object.entries(n.form.fields ?? {}).map(([k, v]) => (
                    <input key={k} type="hidden" name={k} value={v} />
                  ))}
                  <LinkSubmit>{n.form.label}</LinkSubmit>
                </form>
              </>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------- the figures ----------

/**
 * The owl under the MRR (design/brief.md §2): a flag while a milestone holds, pleased when MRR is
 * up, otherwise perched. None when the card carries a warning: the owl never sits next to
 * something that needs fixing, and never cheers numbers that may be out of date.
 */
export function mrrOwl(input: { milestone: number | null; deltaPct: number | null; notes: DashboardNote[] }): OwlPose | null {
  if (input.notes.some((n) => n.tone === 'warning')) return null;
  if (input.milestone !== null) return 'flag';
  if (input.deltaPct !== null && input.deltaPct >= FLAT) return 'proud';
  return 'perched';
}

/**
 * Where the owl stands in a figure column: at its foot, from md up (on a phone the column has no
 * spare room). The negative margins take back the canvas's empty edge, so its feet sit on the
 * column's last line and its body lines up with the text above.
 */
const OWL_FOOT = 'mt-auto hidden pt-4 -mb-4 -ml-[19px] md:block';

/**
 * MRR, its change, ARR, a milestone, and its trend in one card. Shared with the landing demo.
 * `owl`: the dashboard's mood owl (`mrrOwl`); the landing demo leaves it out, its owl sits on the frame.
 */
export function MrrCard(props: { data: DashboardData; notes?: DashboardNote[]; owl?: boolean; className?: string }) {
  const { data } = props;
  const cur = data.currency;
  const k = data.kpis;
  const days = data.rangeDays;
  const milestone = recentMilestone(data.mrrSeries, cur, dayKey(data.generatedAt));
  const owl = props.owl ? mrrOwl({ milestone, deltaPct: k.mrr.deltaPct, notes: props.notes ?? [] }) : null;
  return (
    <CossCard render={<section aria-label="MRR" />} className={cn('min-w-0', props.className)}>
      <CardPanel className="p-5 sm:p-6">
        <div className="grid gap-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:gap-8">
          <div className="flex min-w-0 flex-col">
            <KpiStat
              hero
              label="MRR"
              value={formatMoney(k.mrr.value, cur, { whole: true })}
              deltaPct={k.mrr.deltaPct}
              deltaLabel={`vs. ${days} days ago`}
              hint={`${formatMoney(k.arr.value, cur, { whole: true })} ARR`}
            />
            {milestone !== null ? (
              <p className="mt-3">
                <Badge variant="success" size="lg">
                  Passed {formatMoney(toMinor(milestone, cur), cur, { whole: true })} MRR
                </Badge>
              </p>
            ) : null}
            {owl ? <Owl pose={owl} className={OWL_FOOT} /> : null}
          </div>
          <MrrChart
            series={data.mrrSeries}
            windowDays={data.revenueSeries.map((d) => d.day)}
            currency={cur}
            title={`MRR, last ${days} days`}
          />
        </div>
        {props.notes && props.notes.length > 0 ? <NoteList notes={props.notes} /> : null}
      </CardPanel>
    </CossCard>
  );
}

/** Subscriptions, trials, revenue: three figures in one card (stacked on a phone), the comparison said once underneath. */
export function SecondaryStats(props: { data: DashboardData; className?: string }) {
  const { data } = props;
  const cur = data.currency;
  const k = data.kpis;
  const days = data.rangeDays;
  return (
    <section aria-label="Subscriptions, trials and revenue" className={props.className}>
      <CossCard className="grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <KpiStat
          inlineDelta
          label="Active subscriptions"
          value={formatNumber(k.activeSubscriptions.value)}
          deltaPct={k.activeSubscriptions.deltaPct}
          deltaLabel={`vs. ${days} days ago`}
        />
        <KpiStat
          inlineDelta
          neutralDelta
          label="Active trials"
          value={formatNumber(k.activeTrials.value)}
          deltaPct={k.activeTrials.deltaPct}
          deltaLabel={`vs. ${days} days ago`}
        />
        <KpiStat
          inlineDelta
          label={`Revenue, ${days} days`}
          value={formatMoney(k.revenue.value, cur, { whole: true })}
          deltaPct={k.revenue.deltaPct}
          deltaLabel={`vs. the previous ${days} days`}
        />
      </CossCard>
      {/* Each delta already speaks its comparison; this is the visual version of the same. */}
      <p aria-hidden="true" className="mt-2 text-caption text-muted-foreground">
        Changes compare with {days} days ago. Revenue compares with the {days} days before.
      </p>
    </section>
  );
}

/**
 * Providers that only report a trailing total, said inside the card they're missing from.
 * `where` finishes the sentence: the Revenue card by default, the calendar passes its own.
 */
function revenueNotes(data: DashboardData, where = 'in these bars or in Revenue above'): DashboardNote[] {
  return data.breakdown
    .filter((b) => b.periodRevenue)
    .map((b) => {
      const p = b.periodRevenue!;
      return {
        tone: 'info' as const,
        text:
          p.amount !== null
            ? `${b.name} reports a ${p.days}-day total only (${formatMoney(p.amount, data.currency, { whole: true })}), so it isn’t ${where}.`
            : `${b.name} has no daily revenue history, so it isn’t ${where}.`,
      };
    });
}

/** Revenue per day, the card. Shared with the landing demo. */
export function RevenueCard(props: { data: DashboardData; className?: string }) {
  const { data } = props;
  const notes = revenueNotes(data);
  return (
    <Card
      title="Revenue per day"
      description={`Charges minus refunds, before fees. Last ${data.rangeDays} days.`}
      className={props.className}
    >
      <RevenueChart series={data.revenueSeries} connections={data.breakdown} currency={data.currency} />
      {notes.length > 0 ? <NoteList notes={notes} /> : null}
    </Card>
  );
}

/**
 * By product, the card: MRR now per product from the providers whose snapshots split it (Stripe),
 * then revenue in the window per product from those that name what was sold. Each part shows only
 * when there's something to split; a sentence says why the rest isn't. Headings only when both show.
 */
export function ProductCard(props: { data: DashboardData }) {
  const { data } = props;
  const { products, productMrr } = data;
  const notes = revenueNotes(data, 'split by product here');
  const text = 'px-3 text-body text-muted-foreground';
  const names = listNames(products.unnamedProviders);

  let mrr: ReactNode = null;
  if (productMrr.split) {
    const empty = productMrr.rows.length === 0 && productMrr.unnamed.mrr === 0;
    mrr = empty ? <p className={text}>No MRR to split by product.</p> : <ProductMrrTable products={productMrr} currency={data.currency} />;
  }

  let revenue: ReactNode = null;
  if (!products.named && products.unnamedProviders.length > 0) {
    if (mrr) notes.unshift({ tone: 'info', text: `Revenue from ${names} comes without product names, so only MRR is split here.` });
    else revenue = <p className={text}>Revenue from {names} comes without product names, so it can’t be split by product.</p>;
  } else if (products.rows.length === 0 && products.unnamed.revenue === 0) {
    // With nothing counted at all (28-day totals only), the notes below say why.
    const counted = data.breakdown.some((b) => b.revenue !== null);
    revenue = <p className={text}>{counted ? `No sales in the last ${data.rangeDays} days.` : 'No revenue to split by product.'}</p>;
  } else {
    revenue = <ProductTable products={products} currency={data.currency} rangeDays={data.rangeDays} />;
    if (products.unnamedProviders.length > 0) {
      notes.unshift({ tone: 'info', text: `Revenue from ${names} comes without product names, so it’s under “No product name”.` });
    }
  }

  if (mrr && productMrr.unnamedProviders.length > 0) {
    notes.push({
      tone: 'info',
      text: `MRR from ${listNames(productMrr.unnamedProviders)} isn’t split by product, so it’s under “No product name”.`,
    });
  }
  const waiting = productMrr.needsPermission;
  if (waiting.length > 0) {
    notes.push({
      tone: 'info',
      text: `${listNames(waiting)} can split MRR by product once ${waiting.length > 1 ? 'their Stripe keys have' : 'its Stripe key has'} Products: Read.`,
    });
  }

  const both = Boolean(mrr && revenue);
  return (
    <Card title="By product" bodyClassName="px-2 pb-3 sm:px-3 sm:pb-4">
      {mrr ? (
        <div>
          {both ? <h3 className="px-3 pb-2 font-semibold">MRR now</h3> : null}
          {mrr}
        </div>
      ) : null}
      {revenue ? (
        <div className={both ? 'mt-6' : undefined}>
          {both ? <h3 className="px-3 pb-2 font-semibold">{`Revenue, last ${data.rangeDays} days`}</h3> : null}
          {revenue}
        </div>
      ) : null}
      {notes.length > 0 ? (
        <div className="px-3">
          <NoteList notes={notes} />
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Reward moment after the first real sync. Live numbers only, never a sample figure. It drops in
 * once with CSS and the owl hops with it (`owl-hop`, CSS too: it plays from the first paint, so
 * nothing jumps when hydration lands, and stays smooth while the page is still busy). Once the
 * page is interactive, Dismiss folds the strip away, faster than it came, and drops the trigger
 * from the URL instead of reloading. Under reduced motion it simply fades in and out.
 */
function FirstNumbers(props: { data: DashboardData; cadence: string; dismissHref: string; note?: string }) {
  const { data } = props;
  const [open, setOpen] = useState(true);
  // Only read in the exit, after hydration, so the server and browser render the same.
  const reduce = useReducedMotion();

  const rows = data.breakdown;
  const from = rows.length === 1 ? `from ${rows[0]!.name}` : `across ${formatNumber(rows.length)} connections`;
  const headline =
    data.kpis.mrr.value > 0
      ? `There it is: ${formatMoney(data.kpis.mrr.value, data.currency, { whole: true })} MRR ${from}.`
      : `There it is: your first numbers, ${from}.`;
  return (
    // Motion follows the OS setting for transforms and height, but not margin, so the reduced
    // exit is spelled out: fade only, nothing slides.
    <MotionConfig reducedMotion="user">
      <AnimatePresence initial={false} onExitComplete={() => window.history.replaceState(window.history.state, '', props.dismissHref)}>
        {open ? (
          <motion.section
            key="first-numbers"
            aria-labelledby="first-numbers"
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            className="fade-in mb-6 overflow-hidden rounded-2xl border border-brand/24 bg-[radial-gradient(40rem_12rem_at_0%_0%,--alpha(var(--color-brand)/12%),transparent_70%)]"
          >
            <div className="flex flex-col items-start gap-4 p-5 sm:flex-row sm:items-center sm:p-6">
              <div className="owl-hop">
                <Owl pose="cheer" eager />
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="first-numbers" className="font-semibold wrap-break-word">
                  {headline} <span aria-hidden="true">🎉</span>
                </h2>
                <p className="mt-1 text-muted-foreground">
                  It updates {props.cadence}. You can stop checking now.{props.note ? ` ${props.note}` : ''}
                </p>
              </div>
              <CossButton
                render={
                  <a
                    href={props.dismissHref}
                    onClick={(e) => {
                      e.preventDefault();
                      setOpen(false);
                    }}
                  />
                }
                variant="outline"
                size="sm"
              >
                <X />
                Dismiss
              </CossButton>
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </MotionConfig>
  );
}

/**
 * While the first sync runs: coss skeleton blocks the size of what's coming, in the same cards,
 * so nothing reads as $0, and the counting owl where the MRR card's owl will stand. animate-none! (important: tailwind-merge doesn't know coss's
 * animate-skeleton, so both classes survive and the shimmer would win): no idle loops, §3.6.
 * Hidden from screen readers, which hear one sentence instead.
 */
function DashboardSkeleton() {
  const block = 'animate-none!';
  return (
    <div aria-busy="true">
      <p className="sr-only">Your first numbers are on their way.</p>
      <div aria-hidden="true">
        <CossCard className="mb-6">
          <CardPanel className="grid gap-6 p-5 sm:p-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:gap-8">
            <div className="flex flex-col">
              <Skeleton className={`h-4 w-10 ${block}`} />
              <Skeleton className={`mt-2 h-10 w-40 sm:h-12 ${block}`} />
              <Skeleton className={`mt-3 h-5 w-36 ${block}`} />
              <Skeleton className={`mt-1 h-5 w-24 ${block}`} />
              {/* Where the mood owl will stand, adding up the first numbers meanwhile. */}
              <Owl pose="counting" eager className={OWL_FOOT} />
            </div>
            <Skeleton className={`h-40 ${block}`} />
          </CardPanel>
        </CossCard>
        <CossCard className="grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {[0, 1, 2].map((i) => (
            <div key={i} className="px-5 py-4 sm:px-6">
              <Skeleton className={`h-4 w-28 ${block}`} />
              <Skeleton className={`mt-2 h-7 w-20 ${block}`} />
            </div>
          ))}
        </CossCard>
      </div>
    </div>
  );
}

/** No connection has ever synced and none is syncing: say why there's no number, never "$0". */
function NoNumbers(props: { notes: DashboardNote[] }) {
  return (
    <CossCard render={<section aria-labelledby="no-numbers" />}>
      <CardPanel className="p-5 sm:p-6">
        <h2 id="no-numbers" className="text-base font-semibold">
          No numbers yet
        </h2>
        <p className="mt-1 text-muted-foreground">They show up after a connection’s first successful sync.</p>
        {props.notes.length > 0 ? <NoteList notes={props.notes} /> : null}
      </CardPanel>
    </CossCard>
  );
}

export function DashboardPage(props: DashboardPageProps) {
  const requestNow = useNow();
  if (props.connections.length === 0) {
    return (
      <Layout {...props.chrome} title="Dashboard" nav="dashboard" noindex backdrop>
        <PageHeader title="Dashboard" />
        <EmptyState title="Nothing to add up yet." actions={<ConnectActions />}>
          Connect Stripe, Lemon Squeezy or RevenueCat and your MRR shows up here. No key handy? Try it with demo data
          first.
        </EmptyState>
      </Layout>
    );
  }

  const { data } = props;
  const now = props.now ?? requestNow;
  const staleAfterMs = (props.staleAfterMinutes ?? 120) * MINUTE;
  const notes = completenessNotes({
    connections: props.connections,
    fxMissing: data.fx.missing,
    extra: data.warnings,
    now,
    staleAfterMs,
    firstSyncShown: Boolean(props.sync),
  });

  // Nothing has ever synced: a skeleton while the first sync runs, an explanation if it failed.
  const hasNumbers = props.connections.some((c) => c.lastSyncedAt !== null);
  const note = props.demoRemoved ? DEMO_REMOVED : undefined;
  const currencyNote = props.currencyInferred ? (
    <Alert tone="info" role="status" className="mb-6">
      Amounts are in {props.currencyInferred}, the currency most of your MRR is in.{' '}
      <TextLink href="/settings#display-currency">Change it in Settings</TextLink>
    </Alert>
  ) : null;
  const syncNotice = props.sync ? (
    <div className="mb-6">
      <SyncNotice
        sync={props.sync}
        connected={props.connections.filter((c) => c.lastSyncedAt === null && c.status !== 'error').map((c) => c.name)}
        note={note}
      />
    </div>
  ) : null;

  if (!hasNumbers) {
    return (
      <Layout {...props.chrome} title="Dashboard" nav="dashboard" noindex backdrop refresh={props.sync?.refresh ?? undefined}>
        <PageHeader title="Dashboard" />
        {syncNotice}
        {props.sync ? <DashboardSkeleton /> : <NoNumbers notes={notes} />}
      </Layout>
    );
  }

  return (
    <Layout {...props.chrome} title="Dashboard" nav="dashboard" noindex backdrop refresh={props.sync?.refresh ?? undefined}>
      <PageHeader
        title="Dashboard"
        actions={
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <FreshnessLabel freshness={freshness(props.connections, now, staleAfterMs)} now={now} />
            <RangeTabs current={data.rangeDays} basePath={props.basePath} />
          </div>
        }
      />

      {currencyNote}
      {syncNotice ??
        (props.celebrate && data.breakdown.length > 0 ? (
          <FirstNumbers
            data={data}
            cadence={props.cadence ?? 'every hour'}
            dismissHref={props.celebrate.dismissHref}
            note={note}
          />
        ) : null)}

      <MrrCard data={data} notes={notes} owl className="mb-6" />
      <SecondaryStats data={data} className="mb-6" />

      <div className="grid gap-6">
        <Card title="By connection" bodyClassName="px-2 pb-3 sm:px-3 sm:pb-4">
          {data.breakdown.length > 0 ? (
            <BreakdownTable rows={data.breakdown} currency={data.currency} rangeDays={data.rangeDays} />
          ) : (
            <p className="px-3 text-body text-muted-foreground">No numbers yet. They appear after the first sync.</p>
          )}
        </Card>

        <ProductCard data={data} />

        <RevenueCard data={data} />

        {props.calendar ? (
          <CalendarCard
            calendar={props.calendar}
            connections={props.connections}
            selected={props.calendarDay}
            basePath={props.basePath}
            notes={(() => {
              const notes = revenueNotes(data, 'in this calendar');
              return notes.length > 0 ? <NoteList notes={notes} /> : null;
            })()}
          />
        ) : null}

        {data.fx.asOf || data.fx.daily ? (
          <p className="text-caption text-muted-foreground">
            {data.fx.asOf && data.fx.daily
              ? `Converted to ${data.currency}: revenue at each day’s exchange rate, MRR at rates from ${formatDay(data.fx.asOf)}.`
              : data.fx.asOf
                ? `MRR converted to ${data.currency} at exchange rates from ${formatDay(data.fx.asOf)}.`
                : `Revenue converted to ${data.currency} at each day’s exchange rate.`}
          </p>
        ) : null}
      </div>
    </Layout>
  );
}
