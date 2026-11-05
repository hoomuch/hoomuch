/** Unified transactions (GET /transactions?provider=&page=). Owner: Experience (pages). */

import type { TransactionPage, TransactionRow } from '../../data/types';
import { formatMoney, normalizeCurrency } from '../../lib/money';
import { getProviderMeta } from '../../providers/registry';
import type { ProviderId } from '../../providers/types';
import { ProviderDot } from '../components/badges';
import { EmptyState } from '../components/empty-state';
import { BOX_TAB, LinkButton, PageHeader, TableScroller } from '../components/ui';
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

/** "All" is explicit (?provider=all): a bare /transactions brings back the remembered filter. */
function href(base: string, provider: ProviderId | null, page: number): string {
  const q = new URLSearchParams();
  q.set('provider', provider ?? 'all');
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
        <span class="block text-caption text-ink-3">No rate to convert to {props.currency}</span>
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

      {/* The same daisyUI segmented control as the dashboard's range tabs: one choice of several. */}
      <nav aria-label="Filter by provider" class="tabs tabs-box tabs-sm mb-6 w-fit border border-base-300">
        {filters.map((f) => (
          <a href={href(base, f.id, 1)} aria-current={f.id === p.provider ? 'page' : undefined} class={BOX_TAB}>
            {f.label}
          </a>
        ))}
      </nav>

      {p.items.length === 0 ? (
        <div class="card card-dash border-base-300 px-6 py-10 text-center text-ink-2">
          {p.page > 1 ? (
            <p>
              Nothing on this page.{' '}
              <a href={href(base, p.provider, 1)} class="link link-accent">
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
        <TableScroller labelledBy="transactions-caption" class="rounded-box border border-base-300">
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
                    <td>{t.description ?? <span class="text-ink-3">—</span>}</td>
                    <td>
                      {t.type === 'refund' ? (
                        <span class="badge badge-soft badge-sm badge-error">Refund</span>
                      ) : (
                        <span class="text-ink-2">Charge</span>
                      )}
                    </td>
                    <AmountCell row={t} currency={cur} />
                    <td class="text-right whitespace-nowrap text-ink-3 tabular-nums">
                      {showOriginal ? formatMoney(t.amount, t.originalCurrency) : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroller>
      )}

      {/* daisyUI pagination: a join of buttons. Missing ends are left out, not disabled. */}
      {p.page > 1 || p.hasMore ? (
        <nav aria-label="Pagination" class="mt-6 flex justify-center">
          <div class="join">
            {p.page > 1 ? (
              <LinkButton href={href(base, p.provider, p.page - 1)} variant="secondary" small class="join-item">
                <span aria-hidden="true">←</span> Previous<span class="sr-only"> page</span>
              </LinkButton>
            ) : null}
            <span aria-current="page" class="join-item btn btn-sm btn-outline pointer-events-none border-base-300">
              Page {p.page}
            </span>
            {p.hasMore ? (
              <LinkButton href={href(base, p.provider, p.page + 1)} variant="secondary" small class="join-item">
                Next<span class="sr-only"> page</span> <span aria-hidden="true">→</span>
              </LinkButton>
            ) : null}
          </div>
        </nav>
      ) : null}
    </Layout>
  );
}
