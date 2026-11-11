/**
 * BreakdownTable: per-connection MRR, share, subscriptions, trials, revenue in the window.
 * Owner: Experience (design). CONTRACT: props are fixed.
 *
 * A coss table. Figures are right-aligned tabular numbers, in whole units like the rest of the
 * dashboard. Share gets a thin neutral bar drawn as an SVG <rect width="NN%">; the provider dot
 * carries identity, the bar only magnitude.
 */

import { useContext } from 'react';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { rangeSpan, type BreakdownRow, type RangeDays } from '../../data/types';
import { formatMoney, formatNumber } from '../../lib/money';
import { ProviderDot, TestModeBadge } from './badges';
import { NotAvailable, PreviewContext, ScrollTable, TableRowHeader } from './ui';

const NUM = 'text-right tabular-nums';
const CAPTION_ID = 'breakdown-caption';

export function shareLabel(pct: number): string {
  if (pct <= 0) return '0%';
  if (pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

export function ShareBar(props: { pct: number }) {
  const w = Math.max(0, Math.min(100, props.pct));
  return (
    <svg width="48" height="4" viewBox="0 0 48 4" aria-hidden="true" className="hidden shrink-0 sm:block">
      <rect width="48" height="4" rx="2" className="fill-border" />
      {w > 0 ? <rect width={`${w.toFixed(1)}%`} height="4" rx="2" className="fill-faint" /> : null}
    </svg>
  );
}

export function BreakdownTable(props: { rows: BreakdownRow[]; currency: string; rangeDays: RangeDays }) {
  const preview = useContext(PreviewContext);
  return (
    <ScrollTable labelledBy={CAPTION_ID}>
      {/* Rows arrive sorted by MRR (data/dashboard.ts); say so, since it isn't visible. */}
      <caption id={CAPTION_ID} className="sr-only">
        MRR by connection, highest first
      </caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Connection</TableHead>
          <TableHead scope="col" className="text-right">
            MRR
          </TableHead>
          <TableHead scope="col" className="text-right">
            Share
          </TableHead>
          <TableHead scope="col" className="text-right">
            Subscriptions
          </TableHead>
          <TableHead scope="col" className="text-right">
            Trials
          </TableHead>
          <TableHead scope="col" className="text-right">
            Revenue <span className="font-normal">({rangeSpan(props.rangeDays)})</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.rows.map((r) => (
          <TableRow key={r.id}>
            <TableRowHeader>
              <span className="flex min-w-0 items-center gap-2">
                <ProviderDot dotClass={r.dotClass} />
                {preview ? (
                  <span className="max-w-56 truncate font-medium leading-5">{r.name}</span>
                ) : (
                  <a href={`/connections/${r.id}`} className="max-w-56 truncate font-medium leading-5 hover:underline">
                    {r.name}
                  </a>
                )}
                {r.testMode ? <TestModeBadge /> : null}
              </span>
            </TableRowHeader>
            <TableCell className={NUM}>{formatMoney(r.mrr, props.currency, { whole: true })}</TableCell>
            <TableCell className={NUM}>
              {/* Label first in the DOM so the row's text baseline comes from it; reversed visually. */}
              <span className="inline-flex flex-row-reverse items-center gap-2.5">
                <span className="w-9">{shareLabel(r.sharePct)}</span>
                <ShareBar pct={r.sharePct} />
              </span>
            </TableCell>
            <TableCell className={NUM}>{formatNumber(r.activeSubscriptions)}</TableCell>
            <TableCell className={NUM}>{r.activeTrials === null ? <NotAvailable /> : formatNumber(r.activeTrials)}</TableCell>
            <TableCell className={NUM}>
              {r.revenue === null ? <NotAvailable /> : formatMoney(r.revenue, props.currency, { whole: true })}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </ScrollTable>
  );
}
