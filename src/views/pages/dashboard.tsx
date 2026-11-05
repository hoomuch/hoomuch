/** Dashboard (GET /dashboard?range=). Owner: Experience (pages). */

import type { ConnectionSummary, DashboardData, MrrDay } from '../../data/types';
import { formatMoney, formatNumber } from '../../lib/money';
import { MrrChart } from '../charts/mrr-chart';
import { RevenueChart } from '../charts/revenue-chart';
import { BreakdownTable } from '../components/breakdown-table';
import { EmptyState } from '../components/empty-state';
import { KpiStat } from '../components/kpi';
import { Owl } from '../components/mascot';
import { RangeTabs } from '../components/range-tabs';
import { Alert, Button, Card, cx, LinkButton, PageHeader } from '../components/ui';
import { Layout, type PageChrome } from '../layout';
import { formatDay, SyncNotice, type SyncState } from './shared';

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
  /**
   * The first sync just finished: show the one-time "There it is" strip. `dismissHref` is the
   * same dashboard without the trigger, so dismissing is a plain link (zero JS, no stored state).
   */
  celebrate?: { dismissHref: string } | null;
}

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

/** Fewer days than this and a "highest" claim means little, so the badge stays hidden. */
const HIGH_MIN_DAYS = 14;

/** Today's MRR beats every earlier day in the window (strictly), with enough days to matter. */
export function isRangeHigh(series: MrrDay[]): boolean {
  if (series.length < HIGH_MIN_DAYS) return false;
  const last = series.at(-1)!.total;
  return last > 0 && series.slice(0, -1).every((d) => d.total < last);
}

/** The KPI strip: MRR hero + ARR, subscriptions, trials, revenue. Shared with the landing demo. */
export function KpiStrip(props: { data: DashboardData; class?: string }) {
  const { data } = props;
  const cur = data.currency;
  const k = data.kpis;
  const days = data.rangeDays;
  const sinceStart = `vs. ${days} days ago`;
  const vsPrevious = `vs. previous ${days} days`;
  return (
    <section aria-label="Key metrics" class={cx('rounded-box border border-base-300 p-5', props.class)}>
      <KpiStat
        hero
        label="MRR"
        value={formatMoney(k.mrr.value, cur, { whole: true })}
        deltaPct={k.mrr.deltaPct}
        deltaLabel={sinceStart}
        hint={isRangeHigh(data.mrrSeries) ? <span class="badge badge-sm mt-2">Highest in {days} days</span> : undefined}
      />
      <div class="mt-5 grid grid-cols-2 gap-6 border-t border-base-300 pt-5 md:grid-cols-4">
        <KpiStat
          label="ARR"
          value={formatMoney(k.arr.value, cur, { whole: true })}
          deltaPct={k.arr.deltaPct}
          deltaLabel={sinceStart}
        />
        <KpiStat
          label="Active subscriptions"
          value={formatNumber(k.activeSubscriptions.value)}
          deltaPct={k.activeSubscriptions.deltaPct}
          deltaLabel={sinceStart}
        />
        <KpiStat
          label="Active trials"
          value={formatNumber(k.activeTrials.value)}
          deltaPct={k.activeTrials.deltaPct}
          deltaLabel={sinceStart}
        />
        <KpiStat
          label={`Revenue, ${days} days`}
          value={formatMoney(k.revenue.value, cur, { whole: true })}
          deltaPct={k.revenue.deltaPct}
          deltaLabel={vsPrevious}
        />
      </div>
    </section>
  );
}

/** Reward moment after the first sync. Live numbers only, never a sample figure. */
function FirstNumbers(props: { data: DashboardData; cadence: string; dismissHref: string }) {
  const { data } = props;
  const rows = data.breakdown;
  const from = rows.length === 1 ? `from ${rows[0]!.name}` : `across ${formatNumber(rows.length)} connections`;
  const headline =
    data.kpis.mrr.value > 0
      ? `There it is: ${formatMoney(data.kpis.mrr.value, data.currency, { whole: true })} MRR ${from}.`
      : `There it is: your first numbers, ${from}.`;
  return (
    <section
      aria-labelledby="first-numbers"
      class="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-box border border-base-300 p-4 sm:flex-nowrap sm:p-5"
    >
      <Owl pose="cheer" eager />
      <div class="min-w-0 flex-1 basis-48">
        <h2 id="first-numbers" class="font-semibold wrap-break-word">
          {headline} <span aria-hidden="true">🎉</span>
        </h2>
        <p class="mt-1 text-sm text-base-content/70">It updates {props.cadence}. You can stop checking now.</p>
      </div>
      <LinkButton href={props.dismissHref} variant="secondary" small>
        Dismiss
      </LinkButton>
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
  const cur = data.currency;
  const days = data.rangeDays;

  return (
    <Layout {...props.chrome} title="Dashboard" nav="dashboard" noindex refresh={props.sync?.refresh ?? undefined}>
      <PageHeader title="Dashboard" actions={<RangeTabs current={days} basePath={props.basePath} />} />

      {props.sync ? (
        <div class="mb-6">
          <SyncNotice sync={props.sync} />
        </div>
      ) : props.celebrate && data.breakdown.length > 0 ? (
        <FirstNumbers data={data} cadence={props.cadence ?? 'every hour'} dismissHref={props.celebrate.dismissHref} />
      ) : null}

      <KpiStrip data={data} class="mb-6" />

      <div class="grid gap-6">
        <Card title="Revenue" description={`Charges minus refunds per day, before fees. Last ${days} days.`}>
          <RevenueChart series={data.revenueSeries} connections={data.breakdown} currency={cur} />
        </Card>

        <Card title="MRR trend">
          <MrrChart series={data.mrrSeries} windowDays={data.revenueSeries.map((d) => d.day)} currency={cur} />
        </Card>

        <Card title="By connection">
          {data.breakdown.length > 0 ? (
            <BreakdownTable rows={data.breakdown} currency={cur} rangeDays={days} />
          ) : (
            <p class="text-sm text-base-content/70">No numbers yet. They appear after the first sync.</p>
          )}
        </Card>

        {data.warnings.map((w) => (
          <Alert tone="warning">{w}</Alert>
        ))}

        {/* fx.missing is reported once, inside data.warnings (Data Plane). */}

        {data.fx.asOf ? (
          <p class="text-sm text-base-content/60">
            Converted to {cur} at ECB rates from {formatDay(data.fx.asOf)}, past days included.
          </p>
        ) : null}
      </div>
    </Layout>
  );
}
