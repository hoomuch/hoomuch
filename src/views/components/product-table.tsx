/**
 * ProductTable: revenue in the window per product, then the rest folded into "N more products"
 * and "No product name". Owner: Experience (design). Columns follow BreakdownTable: the main figure
 * right after the name, then its share, then the count.
 *
 * Built like BreakdownTable: right-aligned tabular figures in whole units, the share as a thin
 * neutral bar. The dot is the connection a product sells through; its name is only spelled out
 * when products come from more than one connection.
 */

import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ProductBreakdown, RangeDays } from '../../data/types';
import { formatMoney, formatNumber } from '../../lib/money';
import { ProviderDot } from './badges';
import { ShareBar, shareLabel } from './breakdown-table';
import { NotAvailable, ScrollTable, TableRowHeader } from './ui';

const NUM = 'text-right tabular-nums';
const CAPTION_ID = 'products-caption';

function ShareCell(props: { pct: number }) {
  return (
    <TableCell className={NUM}>
      {/* Label first in the DOM so the row's text baseline comes from it; reversed visually. */}
      <span className="inline-flex flex-row-reverse items-center gap-2.5">
        <span className="w-9">{shareLabel(props.pct)}</span>
        <ShareBar pct={props.pct} />
      </span>
    </TableCell>
  );
}

/** A row that isn't one product: no dot (a gap keeps it in line), muted label. */
function RestLabel(props: { children: string }) {
  return (
    <TableRowHeader>
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className="size-2 shrink-0" />
        <span className="leading-5 text-muted-foreground">{props.children}</span>
      </span>
    </TableRowHeader>
  );
}

export function ProductTable(props: { products: ProductBreakdown; currency: string; rangeDays: RangeDays }) {
  const { rows, more, unnamed } = props.products;
  const money = (v: number) => formatMoney(v, props.currency, { whole: true });
  const manyConnections = new Set(rows.map((r) => r.connectionId)).size > 1;
  return (
    <ScrollTable labelledBy={CAPTION_ID}>
      <caption id={CAPTION_ID} className="sr-only">
        Revenue by product, highest first
      </caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Product</TableHead>
          {/* Revenue first: on a phone it's the column still in view. */}
          <TableHead scope="col" className="text-right">
            Revenue <span className="font-normal">({props.rangeDays} days)</span>
          </TableHead>
          <TableHead scope="col" className="text-right">
            Share
          </TableHead>
          <TableHead scope="col" className="text-right">
            Charges
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={`${r.connectionId}:${r.name}`}>
            <TableRowHeader>
              <span className="flex min-w-0 items-center gap-2">
                <ProviderDot dotClass={r.dotClass} />
                <span className="max-w-64 truncate font-medium leading-5" title={r.name}>
                  {r.name}
                </span>
                {manyConnections ? (
                  <span className="max-w-40 truncate leading-5 text-muted-foreground">{r.connectionName}</span>
                ) : (
                  <span className="sr-only">{`, ${r.connectionName}`}</span>
                )}
              </span>
            </TableRowHeader>
            <TableCell className={NUM}>{money(r.revenue)}</TableCell>
            <ShareCell pct={r.sharePct} />
            <TableCell className={NUM}>{formatNumber(r.charges)}</TableCell>
          </TableRow>
        ))}
        {more ? (
          <TableRow>
            <RestLabel>{`${formatNumber(more.count)} more products`}</RestLabel>
            <TableCell className={NUM}>{money(more.revenue)}</TableCell>
            <ShareCell pct={more.sharePct} />
            <TableCell className={NUM}>{formatNumber(more.charges)}</TableCell>
          </TableRow>
        ) : null}
        {unnamed.revenue !== 0 ? (
          <TableRow>
            <RestLabel>No product name</RestLabel>
            <TableCell className={NUM}>{money(unnamed.revenue)}</TableCell>
            <ShareCell pct={unnamed.sharePct} />
            <TableCell className={NUM}>
              <NotAvailable />
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </ScrollTable>
  );
}
