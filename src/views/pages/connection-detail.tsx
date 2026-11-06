/**
 * Connection detail (GET /connections/:id). Owner: Experience (pages). Spec: design/system.md §9.
 *
 * Status and numbers first; everything that changes the connection (rename, replace key, delete)
 * waits in one Manage section, closed unless it's needed. The header holds the one primary
 * action: Sync now, or Replace key once a sync has failed. Syncs run in the background and the
 * page follows them, so no button ever holds the page.
 */

import { ChevronDown } from 'lucide-react';
import { Button as CossButton } from '@/components/ui/button';
import { Card as CossCard } from '@/components/ui/card';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ConnectionDetail, SyncRunRow } from '../../data/types';
import { formatMoney, formatNumber } from '../../lib/money';
import { getProviderMeta } from '../../providers/registry';
import { StatusBadge, TestModeBadge } from '../components/badges';
import { ProviderLogo } from '../components/provider-logos';
import { ConnectionForm } from '../components/connection-form';
import { DangerZone } from '../components/danger-zone';
import { RelativeTime } from '../components/relative-time';
import {
  Alert,
  Button,
  Card,
  ConfirmCheckbox,
  Disclosure,
  Field,
  LinkButton,
  NotAvailable,
  PageHeader,
  ScrollTable,
  TableRowHeader,
  TextLink,
} from '../components/ui';
import { Layout, type PageChrome } from '../layout';
import { Fragment, useEffect, useState } from 'react';
import type { ProviderWebhookSetup } from '../../providers/types';
import type { WebhookAction } from '../../services/webhooks';
import { BackLink, describeConfig, formatDay, formatDuration, SyncNotice, type SyncState } from './shared';

/** A sync the user started from this page: still running (the page refreshes), or finished. */
export type ManualSyncState =
  | { state: 'running'; why: 'sync' | 'key'; sync: SyncState }
  | { state: 'done'; why: 'sync' | 'key'; run: SyncRunRow };

export interface ConnectionDetailPageProps {
  chrome: PageChrome;
  detail: ConnectionDetail;
  /** Non-null while the connection waits for its first sync. */
  sync: SyncState | null;
  /** A sync started with Sync now or Replace key. */
  manual?: ManualSyncState | null;
  /** Open the Manage section (a form in it just failed). */
  manageOpen?: boolean;
  /** Errors + re-filled NON-SECRET values after a failed key replacement. */
  rotate?: { error?: string | null; fieldErrors?: Record<string, string>; values?: Record<string, string> };
  /** Clock for relative times (fixtures pin it). */
  now?: number;
  /** Origin the page was served from, for the webhook URL (e.g. "https://hoomuch.example.com"). */
  origin?: string;
}

const RUN_KIND: Record<SyncRunRow['kind'], string> = {
  cron: 'Scheduled',
  manual: 'Manual',
  initial: 'Initial',
  webhook: 'Webhook',
};

function runResult(run: SyncRunRow) {
  if (run.ok === null) return <span className="text-muted-foreground">Running</span>;
  return run.ok ? <span>OK</span> : <span className="text-destructive-foreground">Failed</span>;
}

/** The running notice, or the result once the run is done (a failure shows as "Last sync failed"). */
function ManualSyncNotice(props: { manual: ManualSyncState; hasError: boolean }) {
  const m = props.manual;
  const key = m.why === 'key';
  if (m.state === 'running') {
    const { refresh } = m.sync;
    return (
      <Alert tone="info" title="Syncing…" role="status">
        {key ? 'Key replaced. Syncing with the new key' : 'Syncing now'}
        {refresh ? (
          <>
            , usually in a few seconds. This page refreshes on its own.
            {refresh.stopUrl ? (
              <>
                {' '}
                <TextLink href={refresh.stopUrl}>Stop refreshing</TextLink>
              </>
            ) : null}
          </>
        ) : m.sync.stopped ? (
          '. Automatic refresh is off. Reload the page to check on it.'
        ) : (
          '. This is taking longer than usual. Reload the page in a minute.'
        )}
      </Alert>
    );
  }
  const n = m.run.events;
  const events = `${formatNumber(n)} revenue ${n === 1 ? 'event' : 'events'} processed.`;
  if (m.run.ok) {
    return (
      <Alert tone="success" role="status" className="fade-in">
        {key ? 'Key replaced and synced.' : 'Synced.'} {events}
      </Alert>
    );
  }
  // The "Last sync failed" alert already gives the reason when the connection is in error.
  if (props.hasError) return null;
  return (
    <Alert tone="error" title="Sync didn’t finish" role="status">
      {m.run.message ?? 'Try again in a minute.'}
    </Alert>
  );
}

export function ConnectionDetailPage(props: ConnectionDetailPageProps) {
  const d = props.detail;
  const meta = getProviderMeta(d.provider);
  const isDemo = d.provider === 'demo';
  const base = `/connections/${d.id}`;
  const config = describeConfig(meta, d.config);
  const nonSecretFields = meta.fields.filter((f) => !f.secret).map((f) => f.name);
  const rotateValues =
    props.rotate?.values ??
    Object.fromEntries(nonSecretFields.filter((k) => d.config[k]).map((k) => [k, d.config[k]!]));
  const rotateFailed = Boolean(props.rotate?.error) || Object.values(props.rotate?.fieldErrors ?? {}).some(Boolean);
  const failing = d.status === 'error';
  const syncing = d.status === 'syncing' || props.manual?.state === 'running' || Boolean(props.sync);
  const manageOpen = Boolean(props.manageOpen) || rotateFailed || (failing && meta.fields.length > 0);
  const refresh = props.sync?.refresh ?? (props.manual?.state === 'running' ? props.manual.sync.refresh : null);

  // One primary action. A sync button that can't do anything says why instead of being clicked.
  const syncButton = (variant: 'primary' | 'secondary') =>
    syncing ? (
      <Button variant={variant} disabled>
        Syncing…
      </Button>
    ) : (
      <form method="post" action={`${base}/sync`}>
        <Button variant={variant}>Sync now</Button>
      </form>
    );
  const actions = isDemo ? (
    <form method="post" action={`${base}/delete`}>
      <Button variant="secondary">Remove demo data</Button>
    </form>
  ) : failing && meta.fields.length > 0 ? (
    <>
      {syncButton('secondary')}
      <LinkButton href="#replace-key">Replace key</LinkButton>
    </>
  ) : (
    syncButton('primary')
  );

  return (
    <Layout {...props.chrome} title={rotateFailed ? `Error: ${d.name}` : d.name} nav="connections" noindex refresh={refresh ?? undefined}>
      <BackLink href="/connections" label="Connections" />
      <PageHeader
        title={d.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <ProviderLogo provider={d.provider} size="md" />
            {meta.name}
            <StatusBadge status={d.status} />
            {d.testMode ? <TestModeBadge /> : null}
          </span>
        }
        actions={actions}
      />

      <div className="grid gap-6">
        {props.sync ? <SyncNotice sync={props.sync} connected={[d.name]} /> : null}
        {props.manual ? <ManualSyncNotice manual={props.manual} hasError={Boolean(d.lastError)} /> : null}

        {d.lastError ? (
          <Alert tone="error" title="Last sync failed">
            {d.lastError}
          </Alert>
        ) : null}

        {d.warnings.length > 0 ? (
          <Alert tone="warning" title={d.warnings.length === 1 ? 'One thing the last sync couldn’t count' : 'What the last sync couldn’t count'}>
            {d.warnings.length === 1 ? (
              d.warnings[0]
            ) : (
              <ul className="grid list-disc gap-1 pl-5">
                {d.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </Alert>
        ) : null}

        <Card title="Details">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-body">
            <dt className="text-faint">Last synced</dt>
            <dd>
              <RelativeTime ms={d.lastSyncedAt} now={props.now} />
            </dd>
            <dt className="text-faint">Connected</dt>
            <dd>
              <RelativeTime ms={d.createdAt} now={props.now} />
            </dd>
            {d.keyHint ? (
              <>
                <dt className="text-faint">Key</dt>
                <dd className="font-mono">{d.keyHint}</dd>
              </>
            ) : null}
            {config.map((row) => (
              <Fragment key={row.label}>
                <dt className="text-faint">{row.label}</dt>
                <dd className="break-all">{row.value}</dd>
              </Fragment>
            ))}
          </dl>
        </Card>

        <Card title="Recent snapshots" description={`Daily figures, amounts in ${d.currency}.`}>
          {d.snapshots.length > 0 ? (
            <>
              <SnapshotTable
                id="recent-snapshots"
                rows={d.snapshots.slice(0, RECENT_SNAPSHOTS)}
                currency={d.currency}
                caption="Recent daily snapshots, newest first"
              />
              {d.snapshots.length > RECENT_SNAPSHOTS ? (
                <Disclosure summary={`Show ${d.snapshots.length - RECENT_SNAPSHOTS} earlier days`} className="mt-3">
                  <SnapshotTable
                    id="earlier-snapshots"
                    rows={d.snapshots.slice(RECENT_SNAPSHOTS)}
                    currency={d.currency}
                    caption="Earlier daily snapshots, newest first"
                  />
                </Disclosure>
              ) : null}
            </>
          ) : (
            <p className="text-body text-muted-foreground">No snapshots yet. The first one is taken on the first sync.</p>
          )}
        </Card>

        <Card title="Sync history">
          {d.recentRuns.length > 0 ? (
            <Disclosure summary={`Show the last ${d.recentRuns.length === 1 ? 'sync' : `${formatNumber(d.recentRuns.length)} syncs`}`}>
              <SyncRunTable runs={d.recentRuns} now={props.now} />
            </Disclosure>
          ) : (
            <p className="text-body text-muted-foreground">No syncs yet.</p>
          )}
        </Card>

        {d.webhook && meta.webhook ? (
          <RealtimeCard
            base={base}
            providerName={meta.name}
            setup={meta.webhook}
            webhook={d.webhook}
            origin={props.origin ?? ''}
            now={props.now}
          />
        ) : null}

        {isDemo ? null : (
          // A coss Collapsible: open by default when it's needed (a form in it failed, or the key does).
          <Collapsible defaultOpen={manageOpen} render={<CossCard id="manage" render={<section aria-labelledby="manage-title" />} />}>
            <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 rounded-2xl px-5 py-4 text-left sm:px-6">
              <span className="min-w-0 flex-1">
                <h2 id="manage-title" className="inline font-semibold">
                  Manage
                </h2>
                <span className="text-muted-foreground"> · Rename, replace the key or delete</span>
              </span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-data-panel-open:rotate-180 motion-reduce:transition-none" />
            </CollapsibleTrigger>
            <CollapsiblePanel keepMounted hiddenUntilFound>
              <div className="grid gap-8 border-t p-5 sm:p-6">
                <section aria-labelledby="rename-title">
                  <h3 id="rename-title" className="font-semibold">
                    Rename
                  </h3>
                  <form method="post" action={`${base}/rename`} className="mt-4 max-w-sm">
                    <Field name="name" label="Name" value={d.name} required maxLength={60} autoComplete="off" />
                    <Button variant="secondary">Save name</Button>
                  </form>
                </section>

                {meta.fields.length > 0 ? (
                  <section id="replace-key" aria-labelledby="replace-key-title" className="scroll-mt-6 border-t pt-8">
                    <h3 id="replace-key-title" className="font-semibold">
                      Replace key
                    </h3>
                    <p className="mt-1 mb-4 text-body text-muted-foreground">
                      The current key stays in use until {meta.name} accepts the new one.
                    </p>
                    <ConnectionForm
                      meta={meta}
                      mode="rotate"
                      action={`${base}/rotate`}
                      values={rotateValues}
                      fieldErrors={props.rotate?.fieldErrors}
                      error={props.rotate?.error}
                    />
                  </section>
                ) : null}

                <DangerZone
                  title="Delete connection"
                  description={`Deletes the stored key and all snapshots, transactions and sync history for this connection. This can’t be undone. The key stays active in ${meta.name}; revoke it there if you no longer need it.`}
                >
                  <form method="post" action={`${base}/delete`}>
                    <ConfirmCheckbox label={<>Yes, delete “{d.name}” and all of its data.</>} />
                    <Button variant="danger">Delete connection</Button>
                  </form>
                </DangerZone>
              </div>
            </CollapsiblePanel>
          </Collapsible>
        )}
      </div>
    </Layout>
  );
}

/**
 * Real-time updates (SPEC F-17): off, a sentence and Turn on; on, the URL to paste into the
 * provider, where to paste it, and whether a call has arrived yet. Every action is a plain form.
 */
function RealtimeCard(props: {
  base: string;
  providerName: string;
  setup: ProviderWebhookSetup;
  webhook: NonNullable<ConnectionDetail['webhook']>;
  origin: string;
  now?: number;
}) {
  const { providerName: name, setup, webhook } = props;
  const action = (value: WebhookAction, label: string, variant: 'secondary' | 'ghost') => (
    <form method="post" action={`${props.base}/webhook`}>
      <input type="hidden" name="action" value={value} />
      <Button variant={variant} small={value !== 'on'}>
        {label}
      </Button>
    </form>
  );
  if (!webhook.path) {
    return (
      <Card title="Real-time updates" id="realtime">
        <p className="max-w-prose text-body text-muted-foreground">
          Sync about a minute after something changes in {name}, instead of at the next scheduled sync. You add a
          hoomuch URL as a webhook in {name}; a call to it only starts a sync, and hoomuch never reads what’s in it.
        </p>
        <div className="mt-4">{action('on', 'Turn on', 'secondary')}</div>
      </Card>
    );
  }
  const url = `${props.origin}${webhook.path}`;
  return (
    <Card
      title="Real-time updates"
      id="realtime"
      description={
        webhook.lastCallAt === null ? (
          <>Waiting for the first call from {name}.</>
        ) : (
          <>
            Last call from {name} <RelativeTime ms={webhook.lastCallAt} now={props.now} />.
          </>
        )
      }
    >
      <div className="grid max-w-prose gap-4 text-body">
        <WebhookUrl url={url} />
        <ol className="grid list-decimal gap-1 pl-5">
          {setup.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {setup.events.length > 0 ? (
          <div>
            <p className="text-muted-foreground">Events to select:</p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {setup.events.map((e) => (
                <li key={e}>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">{e}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {setup.note ? <p className="text-muted-foreground">{setup.note}</p> : null}
        <p className="text-muted-foreground">
          Keep the URL to yourself: anyone who has it can make hoomuch sync this connection, at most once every 5 minutes.
          If it leaks, get a new one.
        </p>
        <div className="flex flex-wrap gap-2">
          {action('rotate', 'New URL', 'secondary')}
          {action('off', 'Turn off', 'ghost')}
        </div>
      </div>
    </Card>
  );
}

/** The webhook URL, selectable as text without JavaScript; a Copy button appears once hydrated. */
function WebhookUrl(props: { url: string }) {
  const [canCopy, setCanCopy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setCanCopy(typeof navigator !== 'undefined' && Boolean(navigator.clipboard)), []);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="webhook-url" className="sr-only">
        Webhook URL
      </label>
      <input
        id="webhook-url"
        readOnly
        value={props.url}
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        className="h-8.5 min-w-0 flex-1 rounded-lg border bg-muted/40 px-3 font-mono text-sm sm:h-7.5"
      />
      {canCopy ? (
        <CossButton
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(props.url).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </CossButton>
      ) : null}
    </div>
  );
}

function SyncRunTable(props: { runs: SyncRunRow[]; now?: number }) {
  return (
    <ScrollTable labelledBy="recent-syncs-caption" className="mt-3">
      <caption id="recent-syncs-caption" className="sr-only">
        Recent sync runs, newest first
      </caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Kind</TableHead>
          <TableHead scope="col">Started</TableHead>
          <TableHead scope="col" className="text-right">
            Duration
          </TableHead>
          <TableHead scope="col">Result</TableHead>
          <TableHead scope="col" className="text-right">
            Events
          </TableHead>
          <TableHead scope="col">Message</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.runs.map((r, i) => (
          <TableRow key={`${r.startedAt}-${i}`}>
            <TableRowHeader>{RUN_KIND[r.kind]}</TableRowHeader>
            <TableCell>
              <RelativeTime ms={r.startedAt} now={props.now} />
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {r.finishedAt === null ? (
                <>
                  <span aria-hidden="true">—</span>
                  <span className="sr-only">Still running</span>
                </>
              ) : (
                formatDuration(r.finishedAt - r.startedAt)
              )}
            </TableCell>
            <TableCell>{runResult(r)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatNumber(r.events)}</TableCell>
            <TableCell className="whitespace-normal leading-5 text-muted-foreground">{r.message ?? ''}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </ScrollTable>
  );
}

const RECENT_SNAPSHOTS = 7;

function SnapshotTable(props: { id: string; rows: ConnectionDetail['snapshots']; currency: string; caption: string }) {
  const captionId = `${props.id}-caption`;
  return (
    <ScrollTable labelledBy={captionId}>
      <caption id={captionId} className="sr-only">
        {props.caption}
      </caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Date</TableHead>
          <TableHead scope="col" className="text-right">
            MRR
          </TableHead>
          <TableHead scope="col" className="text-right">
            Subscriptions
          </TableHead>
          <TableHead scope="col" className="text-right">
            Trials
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.rows.map((s) => (
          <TableRow key={s.day}>
            <TableRowHeader>
              <time dateTime={s.day}>{formatDay(s.day)}</time>
            </TableRowHeader>
            <TableCell className="text-right tabular-nums">{formatMoney(s.mrr, props.currency)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatNumber(s.activeSubscriptions)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {s.activeTrials === null ? <NotAvailable className="" /> : formatNumber(s.activeTrials)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </ScrollTable>
  );
}
