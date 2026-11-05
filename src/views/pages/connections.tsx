/**
 * Connections list (GET /connections), provider picker (GET /connections/new) and the
 * add-connection form (GET /connections/new?provider=). Owner: Experience (pages).
 */

import { ArrowRight } from 'lucide-react';
import { Card as CossCard } from '@/components/ui/card';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ConnectionSummary } from '../../data/types';
import { getProviderMeta, PROVIDERS } from '../../providers/registry';
import type { ProviderMeta } from '../../providers/types';
import { ProviderDot, StatusBadge, TestModeBadge } from '../components/badges';
import { ConnectionForm } from '../components/connection-form';
import { ProviderLogo } from '../components/provider-logos';
import { EmptyState } from '../components/empty-state';
import { RelativeTime } from '../components/relative-time';
import { Button, Card, FormError, LinkButton, PageHeader, ScrollTable, TableRowHeader } from '../components/ui';
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
    <Layout {...props.chrome} title="Connections" nav="connections" noindex backdrop>
      <PageHeader
        title="Connections"
        description="The provider accounts hoomuch reads from."
        actions={hasAny ? <LinkButton href="/connections/new">Add connection</LinkButton> : undefined}
      />
      {hasAny ? (
        <CossCard className="overflow-hidden">
          <ScrollTable labelledBy="connections-caption" className="px-2 py-1 sm:px-3">
            <caption id="connections-caption" className="sr-only">
              Your connections
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Connection</TableHead>
                <TableHead scope="col">Provider</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Last synced</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.connections.map((c) => (
                <TableRow key={c.id}>
                  <TableRowHeader className="py-3 whitespace-normal">
                    <a href={`/connections/${c.id}`} className="inline-flex items-center gap-2 font-medium leading-5 hover:underline">
                      <ProviderDot dotClass={c.dotClass} />
                      {c.name}
                    </a>
                    {c.lastError ? <p className="mt-1 max-w-md leading-5 text-destructive-foreground">{c.lastError}</p> : null}
                  </TableRowHeader>
                  <TableCell>
                    <span className="inline-flex items-center gap-2">
                      <ProviderLogo provider={c.provider} />
                      {getProviderMeta(c.provider).name}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex flex-wrap gap-1">
                      <StatusBadge status={c.status} />
                      {c.testMode ? <TestModeBadge /> : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <RelativeTime ms={c.lastSyncedAt} now={props.now} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ScrollTable>
        </CossCard>
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
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {real.map((p) => (
          <li key={p.id}>
            <CossCard
              render={<a href={`/connections/new?provider=${p.id}`} />}
              className="group h-full p-5 transition-[border-color,box-shadow,scale] duration-150 ease-out hover:border-input hover:shadow-sm/5 motion-safe:active:scale-[0.99]"
            >
              <span className="flex items-center justify-between">
                <ProviderLogo provider={p.id} size="lg" />
                <ArrowRight className="size-4 shrink-0 text-faint transition-transform duration-150 ease-out motion-safe:group-hover:translate-x-0.5" />
              </span>
              <span className="mt-3 font-semibold">{p.name}</span>
              <span className="mt-0.5 text-muted-foreground">{p.tagline}</span>
            </CossCard>
          </li>
        ))}
      </ul>
      <a
        href="/connections/new?provider=demo"
        className="mt-4 flex items-center gap-2 rounded-2xl border border-dashed px-5 py-3 text-muted-foreground transition-[border-color,color,scale] duration-150 ease-out hover:border-input hover:text-foreground motion-safe:active:scale-[0.99]"
      >
        <ProviderLogo provider="demo" />
        <span>
          <span className="font-semibold">{demo.name}</span> · {demo.tagline}
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
          <span className="inline-flex items-center gap-2">
            <ProviderLogo provider={meta.id} />
            {meta.tagline}
          </span>
        }
      />
      {isDemo ? (
        <Card>
          <FormError message={props.error} autoFocus />
          <p className="text-muted-foreground">
            Adds a connection with sample data in 3 currencies and 90 days of history. You can delete it any time.
          </p>
          <form method="post" action="/connections/demo" className="mt-4">
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
