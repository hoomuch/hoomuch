/**
 * Dashboard (GET /dashboard?range=). Owner: Experience (pages). Layout and copy: design/system.md §5.1.
 *
 * Order follows the question "how much am I making?": the MRR with its change and trend, whether
 * that number can be trusted (freshness, and a line for anything missing or out of date), the
 * other figures, where the money comes from, then cash per day. A warning sits next to the
 * figure it affects; nothing is left at the bottom of the page.
 */

import type { ConnectionSummary, DashboardData, MrrDay } from '../../data/types';
import { formatMoney, formatNumber, toMinor } from '../../lib/money';
import { addDays, dayKey, HOUR, MINUTE } from '../../lib/time';
import { MrrChart } from '../charts/mrr-chart';
import { RevenueChart } from '../charts/revenue-chart';
import { BreakdownTable } from '../components/breakdown-table';
import { EmptyState } from '../components/empty-state';
import { IconInfoCircle, IconWarning } from '../components/icons';
import { KpiStat } from '../components/kpi';
import { Owl } from '../components/mascot';
import { RangeTabs } from '../components/range-tabs';
import { RelativeTime } from '../components/relative-time';
import { Alert, Button, Card, cx, LinkButton, PageHeader } from '../components/ui';
import { Layout, type PageChrome } from '../layout';
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
  /** Clock for relative times (fixtures pin it). */
  now?: number;
  /**
   * The first sync just finished: show the one-time "There it is" strip. `dismissHref` is the
   * same dashboard without the trigger, so dismissing is a plain link (zero JS, no stored state).
   */
  celebrate?: { dismissHref: string } | null;
  /** The first real connection just replaced demo data: the notice or the strip says so. */
  demoRemoved?: boolean;
  /** The display currency was just picked from the user's numbers (once): say so, and where to change it. */
  currencyInferred?: string | null;
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
  if (f.kind === 'never' || f.ms === null) return <p class="text-body text-ink-2">Not synced yet</p>;
  const warn = f.kind !== 'fresh';
  return (
    <p class={cx('flex items-center gap-1.5 text-body', warn ? 'text-warning' : 'text-ink-2')}>
      {warn ? <IconWarning class="size-4 shrink-0" /> : null}
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
    <ul class="mt-5 space-y-2 border-t border-base-300 pt-4">
      {props.notes.map((n) => (
        <li class="flex items-start gap-2 text-body">
          {n.tone === 'warning' ? (
            <IconWarning class="mt-0.5 size-4 shrink-0 text-warning" />
          ) : (
            <IconInfoCircle class="mt-0.5 size-4 shrink-0 text-info" />
          )}
          <span>
            <span class="sr-only">{n.tone === 'warning' ? 'Warning: ' : 'Note: '}</span>
            {n.text}
            {n.link ? (
              <>
                {' '}
                <a href={n.link.href} class="link link-accent">
                  {n.link.label}
                </a>
              </>
            ) : null}
            {n.form ? (
              <>
                {' '}
                <form method="post" action={n.form.action} class="inline">
                  {Object.entries(n.form.fields ?? {}).map(([k, v]) => (
                    <input type="hidden" name={k} value={v} />
                  ))}
                  <button type="submit" class="link link-accent">
                    {n.form.label}
                  </button>
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

/** MRR, its change, ARR, a milestone, and its trend in one card. Shared with the landing demo. */
export function MrrCard(props: { data: DashboardData; notes?: DashboardNote[]; class?: string }) {
  const { data } = props;
  const cur = data.currency;
  const k = data.kpis;
  const days = data.rangeDays;
  const milestone = recentMilestone(data.mrrSeries, cur, dayKey(data.generatedAt));
  return (
    <section aria-label="MRR" class={cx('card card-border border-base-300', props.class)}>
      <div class="card-body">
        <div class="grid gap-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:gap-8">
          <div class="min-w-0">
            <KpiStat
              hero
              class="p-0"
              label="MRR"
              value={formatMoney(k.mrr.value, cur, { whole: true })}
              deltaPct={k.mrr.deltaPct}
              deltaLabel={`vs. ${days} days ago`}
              hint={`${formatMoney(k.arr.value, cur, { whole: true })} ARR`}
            />
            {milestone !== null ? (
              <p class="mt-3">
                <span class="badge badge-soft">Passed {formatMoney(toMinor(milestone, cur), cur, { whole: true })} MRR</span>
              </p>
            ) : null}
          </div>
          <MrrChart
            series={data.mrrSeries}
            windowDays={data.revenueSeries.map((d) => d.day)}
            currency={cur}
            title={`MRR, last ${days} days`}
          />
        </div>
        {props.notes && props.notes.length > 0 ? <NoteList notes={props.notes} /> : null}
      </div>
    </section>
  );
}

/** Subscriptions, trials, revenue: daisyUI stats in one row (stacked on a phone), the comparison said once underneath. */
export function SecondaryStats(props: { data: DashboardData; class?: string }) {
  const { data } = props;
  const cur = data.currency;
  const k = data.kpis;
  const days = data.rangeDays;
  return (
    <section aria-label="Subscriptions, trials and revenue" class={props.class}>
      <div class="stats stats-vertical w-full border border-base-300 bg-base-100 sm:stats-horizontal sm:grid-cols-3">
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
      </div>
      {/* Each delta already speaks its comparison; this is the visual version of the same. */}
      <p aria-hidden="true" class="mt-2 text-caption text-ink-2">
        Changes compare with {days} days ago. Revenue compares with the {days} days before.
      </p>
    </section>
  );
}

/** Providers that only report a trailing total, said inside the Revenue card they're missing from. */
function revenueNotes(data: DashboardData): DashboardNote[] {
  return data.breakdown
    .filter((b) => b.periodRevenue)
    .map((b) => {
      const p = b.periodRevenue!;
      return {
        tone: 'info' as const,
        text:
          p.amount !== null
            ? `${b.name} reports a ${p.days}-day total only (${formatMoney(p.amount, data.currency, { whole: true })}), so it isn’t in these bars or in Revenue above.`
            : `${b.name} has no daily revenue history, so it isn’t in these bars or in Revenue above.`,
      };
    });
}

/** Revenue per day, the card. Shared with the landing demo. */
export function RevenueCard(props: { data: DashboardData; class?: string }) {
  const { data } = props;
  const notes = revenueNotes(data);
  return (
    <Card
      title="Revenue per day"
      description={`Charges minus refunds, before fees. Last ${data.rangeDays} days.`}
      class={props.class}
    >
      <RevenueChart series={data.revenueSeries} connections={data.breakdown} currency={data.currency} />
      {notes.length > 0 ? <NoteList notes={notes} /> : null}
    </Card>
  );
}

/**
 * Reward moment after the first real sync, as a daisyUI alert with its action. Live numbers only,
 * never a sample figure. It fades in once (the page loads once); under reduced motion it simply appears.
 */
function FirstNumbers(props: { data: DashboardData; cadence: string; dismissHref: string; note?: string }) {
  const { data } = props;
  const rows = data.breakdown;
  const from = rows.length === 1 ? `from ${rows[0]!.name}` : `across ${formatNumber(rows.length)} connections`;
  const headline =
    data.kpis.mrr.value > 0
      ? `There it is: ${formatMoney(data.kpis.mrr.value, data.currency, { whole: true })} MRR ${from}.`
      : `There it is: your first numbers, ${from}.`;
  return (
    <section aria-labelledby="first-numbers" class="alert alert-vertical fade-in mb-6 sm:alert-horizontal">
      <Owl pose="cheer" eager />
      <div class="min-w-0">
        <h2 id="first-numbers" class="font-semibold wrap-break-word">
          {headline} <span aria-hidden="true">🎉</span>
        </h2>
        <p class="mt-1 text-ink-2">
          It updates {props.cadence}. You can stop checking now.{props.note ? ` ${props.note}` : ''}
        </p>
      </div>
      <LinkButton href={props.dismissHref} variant="secondary" small>
        Dismiss
      </LinkButton>
    </section>
  );
}

/**
 * While the first sync runs: daisyUI skeleton blocks the size of what's coming, in the same card
 * and stats, so nothing reads as $0. animate-none: no shimmer (no idle loops). Hidden from screen
 * readers, which hear one sentence instead.
 */
function DashboardSkeleton() {
  const block = 'skeleton animate-none';
  return (
    <div aria-busy="true">
      <p class="sr-only">Your first numbers are on their way.</p>
      <div aria-hidden="true">
        <div class="card card-border mb-6 border-base-300">
          <div class="card-body grid gap-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:gap-8">
            <div>
              <div class={`h-4 w-10 ${block}`} />
              <div class={`mt-2 h-10 w-40 sm:h-12 ${block}`} />
              <div class={`mt-3 h-5 w-36 ${block}`} />
              <div class={`mt-1 h-5 w-24 ${block}`} />
            </div>
            <div class={`h-40 ${block}`} />
          </div>
        </div>
        <div class="stats stats-vertical w-full border border-base-300 sm:stats-horizontal sm:grid-cols-3">
          {[0, 1, 2].map(() => (
            <div class="stat">
              <div class={`h-4 w-28 ${block}`} />
              <div class={`mt-2 h-7 w-20 ${block}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** No connection has ever synced and none is syncing: say why there's no number, never "$0". */
function NoNumbers(props: { notes: DashboardNote[] }) {
  return (
    <section aria-labelledby="no-numbers" class="card card-border border-base-300">
      <div class="card-body">
        <h2 id="no-numbers" class="card-title">
          No numbers yet
        </h2>
        <p class="text-ink-2">They show up after a connection’s first successful sync.</p>
        {props.notes.length > 0 ? <NoteList notes={props.notes} /> : null}
      </div>
    </section>
  );
}

export function DashboardPage(props: DashboardPageProps) {
  if (props.connections.length === 0) {
    return (
      <Layout {...props.chrome} title="Dashboard" nav="dashboard" noindex>
        <PageHeader title="Dashboard" />
        <EmptyState title="Nothing to add up yet." actions={<ConnectActions />}>
          Connect Stripe, Lemon Squeezy or RevenueCat and your MRR shows up here. No key handy? Try it with demo data
          first.
        </EmptyState>
      </Layout>
    );
  }

  const { data } = props;
  const now = props.now ?? Date.now();
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
    <Alert tone="info" role="status" class="mb-6">
      Amounts are in {props.currencyInferred}, the currency most of your MRR is in.{' '}
      <a href="/settings#display-currency" class="link link-accent">
        Change it in Settings
      </a>
    </Alert>
  ) : null;
  const syncNotice = props.sync ? (
    <div class="mb-6">
      <SyncNotice
        sync={props.sync}
        connected={props.connections.filter((c) => c.lastSyncedAt === null && c.status !== 'error').map((c) => c.name)}
        note={note}
      />
    </div>
  ) : null;

  if (!hasNumbers) {
    return (
      <Layout {...props.chrome} title="Dashboard" nav="dashboard" noindex refresh={props.sync?.refresh ?? undefined}>
        <PageHeader title="Dashboard" />
        {syncNotice}
        {props.sync ? <DashboardSkeleton /> : <NoNumbers notes={notes} />}
      </Layout>
    );
  }

  return (
    <Layout {...props.chrome} title="Dashboard" nav="dashboard" noindex refresh={props.sync?.refresh ?? undefined}>
      <PageHeader
        title="Dashboard"
        actions={
          <div class="flex flex-wrap items-center gap-x-5 gap-y-3">
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

      <MrrCard data={data} notes={notes} class="mb-6" />
      <SecondaryStats data={data} class="mb-6" />

      <div class="grid gap-6">
        <Card title="By connection">
          {data.breakdown.length > 0 ? (
            <BreakdownTable rows={data.breakdown} currency={data.currency} rangeDays={data.rangeDays} />
          ) : (
            <p class="text-body text-ink-2">No numbers yet. They appear after the first sync.</p>
          )}
        </Card>

        <RevenueCard data={data} />

        {data.fx.asOf ? (
          <p class="text-caption text-ink-2">
            Converted to {data.currency} at ECB rates from {formatDay(data.fx.asOf)}, past days included.
          </p>
        ) : null}
      </div>
    </Layout>
  );
}
