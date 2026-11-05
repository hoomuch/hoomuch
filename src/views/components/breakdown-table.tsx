/**
 * BreakdownTable: per-connection MRR, share, subscriptions, trials, revenue in the window.
 * Owner: Experience (design). CONTRACT: props are fixed.
 *
 * Figures are right-aligned tabular numbers, in whole units like the rest of the dashboard.
 * Share gets a thin neutral bar drawn as an SVG
 * <rect width="NN%"> (an attribute, not style="", so it passes the CSP); the provider dot
 * carries identity, the bar only magnitude.
 */

import type { BreakdownRow, RangeDays } from '../../data/types';
import { formatMoney, formatNumber } from '../../lib/money';
import { ProviderDot, TestModeBadge } from './badges';
import { NotAvailable, TableScroller } from './ui';

const NUM = 'text-right whitespace-nowrap tabular-nums';
const CAPTION_ID = 'breakdown-caption';

function shareLabel(pct: number): string {
  if (pct <= 0) return '0%';
  if (pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

function ShareBar(props: { pct: number }) {
  const w = Math.max(0, Math.min(100, props.pct));
  return (
    <svg width="48" height="4" viewBox="0 0 48 4" aria-hidden="true" class="hidden shrink-0 sm:block">
      <rect width="48" height="4" rx="2" class="fill-base-300" />
      {w > 0 ? <rect width={`${w.toFixed(1)}%`} height="4" rx="2" class="fill-ink-3" /> : null}
    </svg>
  );
}

export function BreakdownTable(props: { rows: BreakdownRow[]; currency: string; rangeDays: RangeDays }) {
  return (
    <TableScroller labelledBy={CAPTION_ID}>
      <table class="table">
        {/* Rows arrive sorted by MRR (data/dashboard.ts); say so, since it isn't visible. */}
        <caption id={CAPTION_ID} class="sr-only">
          MRR by connection, highest first
        </caption>
        <thead>
          <tr>
            <th scope="col">Connection</th>
            <th scope="col" class="text-right">MRR</th>
            <th scope="col" class="text-right">Share</th>
            <th scope="col" class="text-right">Subscriptions</th>
            <th scope="col" class="text-right">Trials</th>
            <th scope="col" class="text-right whitespace-nowrap">
              Revenue <span class="font-normal">({props.rangeDays} days)</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr>
              <th scope="row" class="font-normal">
                <span class="flex min-w-0 items-center gap-2">
                  <ProviderDot dotClass={r.dotClass} />
                  <a href={`/connections/${r.id}`} class="max-w-56 truncate font-semibold hover:underline">
                    {r.name}
                  </a>
                  {r.testMode ? <TestModeBadge /> : null}
                </span>
              </th>
              <td class={NUM}>{formatMoney(r.mrr, props.currency, { whole: true })}</td>
              <td class={NUM}>
                {/* Label first in the DOM so the row's text baseline comes from it; reversed visually. */}
                <span class="inline-flex flex-row-reverse items-center gap-2.5">
                  <span class="w-9">{shareLabel(r.sharePct)}</span>
                  <ShareBar pct={r.sharePct} />
                </span>
              </td>
              <td class={NUM}>{formatNumber(r.activeSubscriptions)}</td>
              <td class={NUM}>{r.activeTrials === null ? <NotAvailable /> : formatNumber(r.activeTrials)}</td>
              <td class={NUM}>{r.revenue === null ? <NotAvailable /> : formatMoney(r.revenue, props.currency, { whole: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroller>
  );
}
