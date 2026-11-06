/** Unified transactions (GET /transactions?provider=&page=&day=). Owner: Experience (pages). */

import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card as CossCard } from '@/components/ui/card';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { TransactionPage, TransactionRow } from '../../data/types';
import { formatMoney, normalizeCurrency } from '../../lib/money';
import { getProviderMeta } from '../../providers/registry';
import type { ProviderId } from '../../providers/types';
import { ProviderDot } from '../components/badges';
import { EmptyState } from '../components/empty-state';
import { LinkButton, PageHeader, ScrollTable, SegmentedLinks, TableRowHeader, TextLink } from '../components/ui';
import { Layout, type PageChrome } from '../layout';
import { formatDateTime, formatDay, zoneName } from './shared';
import { useTimeZone } from '../page-root';

export interface TransactionsPageProps {
  chrome: PageChrome;
  page: TransactionPage;
  /** False → "connect an account" empty state instead of the table. */
  hasConnections: boolean;
  /** Providers offered as filters, in display order. */
  filterProviders: readonly ProviderId[];
  /** Filter and pagination links; defaults to "/transactions". */
  basePath?: string;
}

/**
 * "All" is explicit (?provider=all): a bare /transactions brings back the remembered filter.
 * `day` (one of the user's local days, from the dashboard calendar) is kept across filters and pages.
 */
function href(
  base: string,
  provider: ProviderId | null,
  page: number,
  day: string | null = null,
  cursor: { before?: string | null; after?: string | null } = {},
): string {
  const q = new URLSearchParams();
  q.set('provider', provider ?? 'all');
  if (day) q.set('day', day);
  if (page > 1) q.set('page', String(page));
  // Where the page starts, so a deep page reads as fast as the first (data/transactions.ts).
  // Page 1 needs none.
  if (page > 1 && cursor.before) q.set('before', cursor.before);
  else if (page > 1 && cursor.after) q.set('after', cursor.after);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

function AmountCell(props: { row: TransactionRow; currency: string }) {
  const { row } = props;
  const refund = row.type === 'refund';
  const cls = refund ? 'text-right tabular-nums text-destructive-foreground' : 'text-right tabular-nums';
  if (row.displayAmount === null) {
    return (
      <TableCell className={cls}>
        {formatMoney(row.amount, row.originalCurrency)}
        <span className="mt-1 block text-caption text-faint">No rate to convert to {props.currency}</span>
      </TableCell>
    );
  }
  return <TableCell className={cls}>{formatMoney(row.displayAmount, props.currency)}</TableCell>;
}

export function TransactionsPage(props: TransactionsPageProps) {
  const tz = useTimeZone();
  const base = props.basePath ?? '/transactions';
  const p = props.page;
  const cur = p.currency;
  const day = p.day ?? null;

  if (!props.hasConnections) {
    return (
      <Layout {...props.chrome} title="Transactions" nav="transactions" noindex backdrop>
        <PageHeader title="Transactions" />
        <EmptyState
          title="No transactions yet."
          plain
          actions={<LinkButton href="/connections/new">Add connection</LinkButton>}
        >
          Charges and refunds appear here after the first sync.
        </EmptyState>
      </Layout>
    );
  }

  const filters: { id: ProviderId | null; label: string }[] = [
    { id: null, label: 'All' },
    ...props.filterProviders.map((id) => ({ id, label: getProviderMeta(id).name })),
  ];

  // Page 2+ says so in the title: each page of results is a distinct page (2.4.2). So does a day.
  const dayLabel = day ? formatDay(day) : null;
  const pageTitle = [`Transactions${dayLabel ? ` on ${dayLabel}` : ''}`, p.page > 1 ? `page ${p.page}` : null]
    .filter(Boolean)
    .join(', ');

  return (
    <Layout {...props.chrome} title={pageTitle} nav="transactions" noindex backdrop>
      <PageHeader
        title="Transactions"
        description={
          dayLabel ? (
            <>
              Charges and refunds on {dayLabel} ({zoneName(tz)}), newest first. Amounts in {cur}.{' '}
              <TextLink href={href(base, p.provider, 1)}>Show all days</TextLink>
            </>
          ) : (
            `Charges and refunds, newest first. Amounts in ${cur}.`
          )
        }
      />

      {/* The same coss segmented control as the dashboard's range tabs: one choice of several. */}
      <SegmentedLinks
        label="Filter by provider"
        className="mb-6"
        items={filters.map((f) => ({ key: f.id ?? 'all', href: href(base, f.id, 1, day), current: f.id === p.provider, label: f.label }))}
      />

      {p.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed px-6 py-10 text-center text-muted-foreground">
          {p.page > 1 ? (
            <p>
              Nothing on this page. <TextLink href={href(base, p.provider, 1, day)}>Back to the first page</TextLink>
            </p>
          ) : dayLabel ? (
            <p>
              No {p.provider ? `${getProviderMeta(p.provider).name} ` : ''}transactions on {dayLabel}.{' '}
              <TextLink href={href(base, p.provider, 1)}>Show all days</TextLink>
            </p>
          ) : p.provider ? (
            getProviderMeta(p.provider).revenueHistory === 'daily' ? (
              <p>
                {getProviderMeta(p.provider).name} reports daily totals only, so there are no transactions to list. Its
                revenue is on the dashboard.
              </p>
            ) : (
              <p>No {getProviderMeta(p.provider).name} transactions yet.</p>
            )
          ) : (
            <p>No transactions yet. They appear after the first sync.</p>
          )}
        </div>
      ) : (
        <CossCard className="overflow-hidden">
          <ScrollTable labelledBy="transactions-caption" className="px-2 py-1 sm:px-3">
            <caption id="transactions-caption" className="sr-only">
              Transactions{dayLabel ? ` on ${dayLabel}` : ''}, newest first, page {p.page}
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Date ({zoneName(tz)})</TableHead>
                <TableHead scope="col">Connection</TableHead>
                <TableHead scope="col">Description</TableHead>
                <TableHead scope="col">Type</TableHead>
                <TableHead scope="col" className="text-right">
                  Amount
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Original
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {p.items.map((t) => {
                const showOriginal = t.displayAmount !== null && normalizeCurrency(t.originalCurrency) !== normalizeCurrency(cur);
                return (
                  <TableRow key={`${t.connectionId}:${t.externalId}`}>
                    {/* The date is the row header: it's what each row is read against. */}
                    <TableRowHeader className="tabular-nums text-muted-foreground">
                      <time dateTime={new Date(t.occurredAt).toISOString()}>{formatDateTime(t.occurredAt, tz)}</time>
                    </TableRowHeader>
                    <TableCell>
                      <a href={`/connections/${t.connectionId}`} className="inline-flex items-center gap-2 hover:underline">
                        <ProviderDot dotClass={t.dotClass} />
                        {t.connectionName}
                      </a>
                    </TableCell>
                    <TableCell className="whitespace-normal leading-5">{t.description ?? <span className="text-faint">—</span>}</TableCell>
                    <TableCell>
                      {t.type === 'refund' ? <Badge variant="error">Refund</Badge> : <span className="text-muted-foreground">Charge</span>}
                    </TableCell>
                    <AmountCell row={t} currency={cur} />
                    <TableCell className="text-right text-faint tabular-nums">
                      {showOriginal ? formatMoney(t.amount, t.originalCurrency) : ''}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </ScrollTable>
        </CossCard>
      )}

      {/* coss pagination. Missing ends are left out, not disabled. */}
      {p.page > 1 || p.hasMore ? (
        <Pagination aria-label="Pagination" className="mt-6">
          <PaginationContent>
            {p.page > 1 ? (
              <PaginationItem>
                <PaginationPrevious href={href(base, p.provider, p.page - 1, day, { after: p.prevCursor })} aria-label="Previous page" />
              </PaginationItem>
            ) : null}
            <PaginationItem>
              <span aria-current="page" className={buttonVariants({ variant: 'outline', className: 'pointer-events-none' })}>
                Page {p.page}
              </span>
            </PaginationItem>
            {p.hasMore ? (
              <PaginationItem>
                <PaginationNext href={href(base, p.provider, p.page + 1, day, { before: p.nextCursor })} aria-label="Next page" />
              </PaginationItem>
            ) : null}
          </PaginationContent>
        </Pagination>
      ) : null}
    </Layout>
  );
}
