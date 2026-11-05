/**
 * Connections list (GET /connections), provider picker (GET /connections/new) and the
 * add-connection form (GET /connections/new?provider=). Owner: Experience (pages).
 */

import type { ConnectionSummary } from '../../data/types';
import { getProviderMeta, PROVIDERS } from '../../providers/registry';
import type { ProviderMeta } from '../../providers/types';
import { ProviderDot, StatusBadge, TestModeBadge } from '../components/badges';
import { ConnectionForm } from '../components/connection-form';
import { EmptyState } from '../components/empty-state';
import { RelativeTime } from '../components/relative-time';
import { Button, Card, FormError, LinkButton, PageHeader, TableScroller } from '../components/ui';
import { Layout, type PageChrome } from '../layout';
import { ConnectActions } from './dashboard';
import { BackLink } from './shared';

// ---------- list ----------

export interface ConnectionsPageProps {
  chrome: PageChrome;
  connections: ConnectionSummary[];
  /** Clock for relative times (fixtures pin it). */
  now?: number;
}

export function ConnectionsPage(props: ConnectionsPageProps) {
  const hasAny = props.connections.length > 0;
  return (
    <Layout {...props.chrome} title="Connections" nav="connections" noindex>
      <PageHeader
        title="Connections"
        description="The provider accounts hoomuch reads from."
        actions={hasAny ? <LinkButton href="/connections/new">Add connection</LinkButton> : undefined}
      />
      {hasAny ? (
        <TableScroller labelledBy="connections-caption" class="rounded-box border border-base-300">
          <table class="table">
            <caption id="connections-caption" class="sr-only">
              Your connections
            </caption>
            <thead>
              <tr>
                <th scope="col">Connection</th>
                <th scope="col">Provider</th>
                <th scope="col">Status</th>
                <th scope="col">Last synced</th>
              </tr>
            </thead>
            <tbody>
              {props.connections.map((c) => (
                <tr>
                  <th scope="row" class="font-normal">
                    <a href={`/connections/${c.id}`} class="link link-hover inline-flex items-center gap-2 font-semibold">
                      <ProviderDot dotClass={c.dotClass} />
                      {c.name}
                    </a>
                    {c.lastError ? <p class="mt-1 max-w-md text-error">{c.lastError}</p> : null}
                  </th>
                  <td class="whitespace-nowrap">{getProviderMeta(c.provider).name}</td>
                  <td>
                    <span class="inline-flex flex-wrap gap-1">
                      <StatusBadge status={c.status} />
                      {c.testMode ? <TestModeBadge /> : null}
                    </span>
                  </td>
                  <td class="whitespace-nowrap">
                    <RelativeTime ms={c.lastSyncedAt} now={props.now} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      ) : (
        <EmptyState title="No connections yet." actions={<ConnectActions />}>
          Add one and hoomuch starts counting.
        </EmptyState>
      )}
    </Layout>
  );
}

// ---------- provider picker ----------

export function ProviderPickerPage(props: { chrome: PageChrome }) {
  const real = PROVIDERS.filter((p) => p.id !== 'demo');
  const demo = getProviderMeta('demo');
  return (
    <Layout {...props.chrome} title="Add a connection" nav="connections" noindex>
      <BackLink href="/connections" label="Connections" />
      <PageHeader title="Add a connection" description="Pick where your subscriptions live. hoomuch only ever reads." />
      <ul class="grid gap-4 sm:grid-cols-3">
        {real.map((p) => (
          <li>
            <a href={`/connections/new?provider=${p.id}`} class="card card-border h-full border-base-300 hover:border-field">
              <span class="card-body">
                <span class="card-title">
                  <ProviderDot dotClass={p.dotClass} size="md" />
                  {p.name}
                </span>
                <span class="text-ink-2">{p.tagline}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      <a
        href="/connections/new?provider=demo"
        class="card card-dash mt-4 border-base-300 text-ink-2 hover:text-base-content"
      >
        <span class="card-body flex-row items-center py-3">
          <ProviderDot dotClass={demo.dotClass} />
          <span>
            <span class="font-semibold">{demo.name}</span> · {demo.tagline}
          </span>
        </span>
      </a>
    </Layout>
  );
}

// ---------- add form ----------

export interface NewConnectionPageProps {
  chrome: PageChrome;
  meta: ProviderMeta;
  /** Previously submitted NON-SECRET values (name + non-secret fields). */
  values?: Record<string, string>;
  fieldErrors?: Record<string, string>;
  error?: string | null;
}

export function NewConnectionPage(props: NewConnectionPageProps) {
  const { meta } = props;
  const isDemo = meta.fields.length === 0;
  const hasError = Boolean(props.error) || Object.values(props.fieldErrors ?? {}).some(Boolean);
  const heading = isDemo ? 'Add demo data' : `Connect ${meta.name}`;
  return (
    <Layout {...props.chrome} title={hasError ? `Error: ${heading}` : heading} nav="connections" noindex>
      <BackLink href="/connections/new" label="All providers" />
      <PageHeader
        title={heading}
        description={
          <span class="inline-flex items-center gap-2">
            <ProviderDot dotClass={meta.dotClass} />
            {meta.tagline}
          </span>
        }
      />
      {isDemo ? (
        <Card>
          <FormError message={props.error} autofocus />
          <p class="text-ink-2">
            Adds a connection with sample data in 3 currencies and 90 days of history. You can delete it any time.
          </p>
          <form method="post" action="/connections/demo" class="mt-2">
            <Button>Add demo data</Button>
          </form>
        </Card>
      ) : (
        <ConnectionForm
          meta={meta}
          mode="create"
          action="/connections"
          values={props.values}
          fieldErrors={props.fieldErrors}
          error={props.error}
        />
      )}
    </Layout>
  );
}
