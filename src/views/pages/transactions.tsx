/** Unified transactions (GET /transactions?provider=&page=). Owner: Experience (pages). */

import type { TransactionPage, TransactionRow } from '../../data/types';
import { formatMoney, normalizeCurrency } from '../../lib/money';
import { getProviderMeta } from '../../providers/registry';
import type { ProviderId } from '../../providers/types';
import { ProviderDot } from '../components/badges';
import { EmptyState } from '../components/empty-state';
import { LinkButton, PageHeader, TableScroller } from '../components/ui';
import { Layout, type PageChrome } from '../layout';
import { formatDateTime } from './shared';

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

const FILTER_CLASS = {
  active: 'btn btn-sm btn-active',
  idle: 'btn btn-sm btn-ghost',
} as const;

function href(base: string, provider: ProviderId | null, page: number): string {
  const q = new URLSearchParams();
  if (provider) q.set('provider', provider);
  if (page > 1) q.set('page', String(page));
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

function AmountCell(props: { row: TransactionRow; currency: string }) {
  const { row } = props;
  const refund = row.type === 'refund';
  const cls = refund ? 'text-right whitespace-nowrap tabular-nums text-error' : 'text-right whitespace-nowrap tabular-nums';
  if (row.displayAmount === null) {
    return (
      <td class={cls}>
        {formatMoney(row.amount, row.originalCurrency)}
        <span class="block text-xs text-base-content/60">No rate to convert to {props.currency}</span>
      </td>
    );
  }
  return <td class={cls}>{formatMoney(row.displayAmount, props.currency)}</td>;
}

export function TransactionsPage(props: TransactionsPageProps) {
  const base = props.basePath ?? '/transactions';
  const p = props.page;
  const cur = p.currency;

  if (!props.hasConnections) {
    return (
      <Layout {...props.chrome} title="Transactions" nav="transactions" noindex>
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

  // Page 2+ says so in the title: each page of results is a distinct page (2.4.2).
  const pageTitle = p.page > 1 ? `Transactions, page ${p.page}` : 'Transactions';

  return (
    <Layout {...props.chrome} title={pageTitle} nav="transactions" noindex>
      <PageHeader title="Transactions" description={`Charges and refunds, newest first. Amounts in ${cur}.`} />

      <nav aria-label="Filter by provider" class="mb-6 flex flex-wrap gap-2">
        {filters.map((f) => {
          const active = f.id === p.provider;
          return (
            <a
              href={href(base, f.id, 1)}
              aria-current={active ? 'page' : undefined}
              class={active ? FILTER_CLASS.active : FILTER_CLASS.idle}
            >
              {f.label}
            </a>
          );
        })}
      </nav>

      {p.items.length === 0 ? (
        <div class="rounded-box border border-dashed border-base-300 px-6 py-10 text-center text-base-content/70">
          {p.page > 1 ? (
            <p>
              Nothing on this page.{' '}
              <a href={href(base, p.provider, 1)} class="link">
                Back to the first page
              </a>
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
        <TableScroller labelledBy="transactions-caption" class="rounded-box border border-base-300 px-5 py-1">
          <table class="table">
            <caption id="transactions-caption" class="sr-only">
              Transactions, newest first, page {p.page}
            </caption>
            <thead>
              <tr>
                <th scope="col">Date (UTC)</th>
                <th scope="col">Connection</th>
                <th scope="col">Description</th>
                <th scope="col">Type</th>
                <th scope="col" class="text-right">Amount</th>
                <th scope="col" class="text-right">Original</th>
              </tr>
            </thead>
            <tbody>
              {p.items.map((t) => {
                const showOriginal = t.displayAmount !== null && normalizeCurrency(t.originalCurrency) !== normalizeCurrency(cur);
                return (
                  <tr>
                    {/* The date is the row header: it's what each row is read against. */}
                    <th scope="row" class="font-normal whitespace-nowrap tabular-nums">
                      <time datetime={new Date(t.occurredAt).toISOString()}>{formatDateTime(t.occurredAt)}</time>
                    </th>
                    <td>
                      <a href={`/connections/${t.connectionId}`} class="link link-hover inline-flex items-center gap-2">
                        <ProviderDot dotClass={t.dotClass} />
                        {t.connectionName}
                      </a>
                    </td>
                    <td>{t.description ?? <span class="text-base-content/60">—</span>}</td>
                    <td>
                      {t.type === 'refund' ? (
                        <span class="badge badge-sm badge-outline badge-error">Refund</span>
                      ) : (
                        <span class="text-base-content/70">Charge</span>
                      )}
                    </td>
                    <AmountCell row={t} currency={cur} />
                    <td class="text-right whitespace-nowrap text-base-content/60 tabular-nums">
                      {showOriginal ? formatMoney(t.amount, t.originalCurrency) : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroller>
      )}

      {p.page > 1 || p.hasMore ? (
        <nav aria-label="Pagination" class="mt-6 flex items-center justify-between gap-4">
          <div>
            {p.page > 1 ? (
              <LinkButton href={href(base, p.provider, p.page - 1)} variant="secondary" small>
                <span aria-hidden="true">←</span> Previous<span class="sr-only"> page</span>
              </LinkButton>
            ) : null}
          </div>
          <span class="text-sm text-base-content/60">Page {p.page}</span>
          <div>
            {p.hasMore ? (
              <LinkButton href={href(base, p.provider, p.page + 1)} variant="secondary" small>
                Next<span class="sr-only"> page</span> <span aria-hidden="true">→</span>
              </LinkButton>
            ) : null}
          </div>
        </nav>
      ) : null}
    </Layout>
  );
}
