/**
 * Product tables: revenue in the window per product (ProductTable), or MRR now per product
 * (ProductMrrTable), then the rest folded into "N more products" and "No product name". Owner:
 * Experience (design). Columns follow BreakdownTable: the main figure right after the name, then its
 * share, then the count.
 *
 * Built like BreakdownTable: right-aligned tabular figures in whole units, the share as a thin
 * neutral bar. The dot is the connection a product sells through; its name is only spelled out
 * when products come from more than one connection.
 */

import type { ReactNode } from 'react';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { rangeSpan, type ProductBreakdown, type ProductMrrBreakdown, type RangeDays } from '../../data/types';
import { formatMoney, formatNumber } from '../../lib/money';
import { ProviderDot } from './badges';
import { ShareBar, shareLabel } from './breakdown-table';
import { NotAvailable, ScrollTable, TableRowHeader } from './ui';

const NUM = 'text-right tabular-nums';

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

interface SplitRow {
  name: string;
  connectionId: string;
  connectionName: string;
  dotClass: string;
  value: number;
  count: number;
  sharePct: number;
}

/** The table both splits share: product rows, "N more products", "No product name". */
function SplitTable(props: {
  captionId: string;
  caption: string;
  valueHead: ReactNode;
  countHead: string;
  rows: SplitRow[];
  more: { count: number; value: number; total: number; sharePct: number } | null;
  unnamed: { value: number; sharePct: number };
  currency: string;
}) {
  const money = (v: number) => formatMoney(v, props.currency, { whole: true });
  const manyConnections = new Set(props.rows.map((r) => r.connectionId)).size > 1;
  const { more, unnamed } = props;
  return (
    <ScrollTable labelledBy={props.captionId}>
      <caption id={props.captionId} className="sr-only">
        {props.caption}
      </caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Product</TableHead>
          {/* The figure first: on a phone it's the column still in view. Fixed widths line the
              figures up when both tables share the card. */}
          <TableHead scope="col" className="w-40 text-right">
            {props.valueHead}
          </TableHead>
          <TableHead scope="col" className="w-36 text-right">
            Share
          </TableHead>
          <TableHead scope="col" className="w-32 text-right">
            {props.countHead}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.rows.map((r) => (
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
            <TableCell className={NUM}>{money(r.value)}</TableCell>
            <ShareCell pct={r.sharePct} />
            <TableCell className={NUM}>{formatNumber(r.count)}</TableCell>
          </TableRow>
        ))}
        {more ? (
          <TableRow>
            <RestLabel>{`${formatNumber(more.count)} more products`}</RestLabel>
            <TableCell className={NUM}>{money(more.value)}</TableCell>
            <ShareCell pct={more.sharePct} />
            <TableCell className={NUM}>{formatNumber(more.total)}</TableCell>
          </TableRow>
        ) : null}
        {unnamed.value !== 0 ? (
          <TableRow>
            <RestLabel>No product name</RestLabel>
            <TableCell className={NUM}>{money(unnamed.value)}</TableCell>
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

export function ProductTable(props: { products: ProductBreakdown; currency: string; rangeDays: RangeDays }) {
  const { rows, more, unnamed } = props.products;
  return (
    <SplitTable
      captionId="products-caption"
      caption="Revenue by product, highest first"
      valueHead={
        <>
          Revenue <span className="font-normal">({rangeSpan(props.rangeDays)})</span>
        </>
      }
      countHead="Charges"
      rows={rows.map((r) => ({ ...r, value: r.revenue, count: r.charges }))}
      more={more ? { count: more.count, value: more.revenue, total: more.charges, sharePct: more.sharePct } : null}
      unnamed={{ value: unnamed.revenue, sharePct: unnamed.sharePct }}
      currency={props.currency}
    />
  );
}

export function ProductMrrTable(props: { products: ProductMrrBreakdown; currency: string }) {
  const { rows, more, unnamed } = props.products;
  return (
    <SplitTable
      captionId="product-mrr-caption"
      caption="MRR by product, highest first"
      valueHead="MRR"
      countHead="Subscriptions"
      rows={rows.map((r) => ({ ...r, value: r.mrr, count: r.subscriptions }))}
      more={more ? { count: more.count, value: more.mrr, total: more.subscriptions, sharePct: more.sharePct } : null}
      unnamed={{ value: unnamed.mrr, sharePct: unnamed.sharePct }}
      currency={props.currency}
    />
  );
}
