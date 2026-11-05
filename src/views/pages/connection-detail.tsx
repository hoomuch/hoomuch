/**
 * Connection detail (GET /connections/:id). Owner: Experience (pages). Spec: design/system.md §9.
 *
 * Status and numbers first; everything that changes the connection (rename, replace key, delete)
 * waits in one Manage section, closed unless it's needed. The header holds the one primary
 * action: Sync now, or Replace key once a sync has failed. Syncs run in the background and the
 * page follows them, so no button ever holds the page.
 */

import type { ConnectionDetail, SyncRunRow } from '../../data/types';
import { formatMoney, formatNumber } from '../../lib/money';
import { getProviderMeta } from '../../providers/registry';
import { ProviderDot, StatusBadge, TestModeBadge } from '../components/badges';
import { ConnectionForm } from '../components/connection-form';
import { DangerZone } from '../components/danger-zone';
import { RelativeTime } from '../components/relative-time';
import {
  Alert,
  Button,
  Card,
  ConfirmCheckbox,
  Field,
  LinkButton,
  NotAvailable,
  PageHeader,
  TableScroller,
} from '../components/ui';
import { Layout, type PageChrome } from '../layout';
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
}

const RUN_KIND: Record<SyncRunRow['kind'], string> = {
  cron: 'Scheduled',
  manual: 'Manual',
  initial: 'Initial',
};

function runResult(run: SyncRunRow) {
  if (run.ok === null) return <span class="text-ink-2">Running</span>;
  return run.ok ? <span>OK</span> : <span class="text-error">Failed</span>;
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
                <a href={refresh.stopUrl} class="link">
                  Stop refreshing
                </a>
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
      <Alert tone="success" role="status" class="fade-in">
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
          <span class="inline-flex flex-wrap items-center gap-2">
            <ProviderDot dotClass={d.dotClass} size="md" />
            {meta.name}
            <StatusBadge status={d.status} />
            {d.testMode ? <TestModeBadge /> : null}
          </span>
        }
        actions={actions}
      />

      <div class="grid gap-6">
        {props.sync ? <SyncNotice sync={props.sync} connected={[d.name]} /> : null}
        {props.manual ? <ManualSyncNotice manual={props.manual} hasError={Boolean(d.lastError)} /> : null}

        {d.lastError ? (
          <Alert tone="error" title="Last sync failed">
            {d.lastError}
          </Alert>
        ) : null}

        <Card title="Details">
          <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-body">
            <dt class="text-ink-3">Last synced</dt>
            <dd>
              <RelativeTime ms={d.lastSyncedAt} now={props.now} />
            </dd>
            <dt class="text-ink-3">Connected</dt>
            <dd>
              <RelativeTime ms={d.createdAt} now={props.now} />
            </dd>
            {d.keyHint ? (
              <>
                <dt class="text-ink-3">Key</dt>
                <dd class="font-mono">{d.keyHint}</dd>
              </>
            ) : null}
            {config.map((row) => (
              <>
                <dt class="text-ink-3">{row.label}</dt>
                <dd class="break-all">{row.value}</dd>
              </>
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
                <details class="mt-3">
                  <summary class="cursor-pointer text-body text-ink-2">
                    Show {d.snapshots.length - RECENT_SNAPSHOTS} earlier days
                  </summary>
                  <SnapshotTable
                    id="earlier-snapshots"
                    rows={d.snapshots.slice(RECENT_SNAPSHOTS)}
                    currency={d.currency}
                    caption="Earlier daily snapshots, newest first"
                  />
                </details>
              ) : null}
            </>
          ) : (
            <p class="text-body text-ink-2">No snapshots yet. The first one is taken on the first sync.</p>
          )}
        </Card>

        <Card title="Sync history">
          {d.recentRuns.length > 0 ? (
            <details>
              <summary class="cursor-pointer text-body text-ink-2">
                Show the last {d.recentRuns.length === 1 ? 'sync' : `${formatNumber(d.recentRuns.length)} syncs`}
              </summary>
              <SyncRunTable runs={d.recentRuns} now={props.now} />
            </details>
          ) : (
            <p class="text-body text-ink-2">No syncs yet.</p>
          )}
        </Card>

        {isDemo ? null : (
          <details id="manage" open={manageOpen} class="rounded-box border border-base-300">
            <summary class="cursor-pointer rounded-box px-5 py-4 sm:px-6">
              <h2 class="inline font-semibold">Manage</h2>
              <span class="text-ink-2"> · Rename, replace the key or delete</span>
            </summary>
            <div class="grid gap-8 border-t border-base-300 p-5 sm:p-6">
              <section aria-labelledby="rename-title">
                <h3 id="rename-title" class="font-semibold">
                  Rename
                </h3>
                <form method="post" action={`${base}/rename`} class="mt-4 max-w-sm">
                  <Field name="name" label="Name" value={d.name} required maxlength={60} autocomplete="off" />
                  <Button variant="secondary">Save name</Button>
                </form>
              </section>

              {meta.fields.length > 0 ? (
                <section id="replace-key" aria-labelledby="replace-key-title" class="border-t border-base-300 pt-8">
                  <h3 id="replace-key-title" class="font-semibold">
                    Replace key
                  </h3>
                  <p class="mt-1 mb-4 text-body text-ink-2">The current key stays in use until {meta.name} accepts the new one.</p>
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
          </details>
        )}
      </div>
    </Layout>
  );
}

function SyncRunTable(props: { runs: SyncRunRow[]; now?: number }) {
  return (
    <TableScroller labelledBy="recent-syncs-caption" class="mt-3">
      <table class="table table-sm">
        <caption id="recent-syncs-caption" class="sr-only">
          Recent sync runs, newest first
        </caption>
        <thead>
          <tr>
            <th scope="col">Kind</th>
            <th scope="col">Started</th>
            <th scope="col" class="text-right">
              Duration
            </th>
            <th scope="col">Result</th>
            <th scope="col" class="text-right">
              Events
            </th>
            <th scope="col">Message</th>
          </tr>
        </thead>
        <tbody>
          {props.runs.map((r) => (
            <tr>
              <th scope="row" class="font-normal">
                {RUN_KIND[r.kind]}
              </th>
              <td class="whitespace-nowrap">
                <RelativeTime ms={r.startedAt} now={props.now} />
              </td>
              <td class="text-right whitespace-nowrap tabular-nums">
                {r.finishedAt === null ? (
                  <>
                    <span aria-hidden="true">—</span>
                    <span class="sr-only">Still running</span>
                  </>
                ) : (
                  formatDuration(r.finishedAt - r.startedAt)
                )}
              </td>
              <td>{runResult(r)}</td>
              <td class="text-right tabular-nums">{formatNumber(r.events)}</td>
              <td class="text-ink-2">{r.message ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroller>
  );
}

const RECENT_SNAPSHOTS = 7;

function SnapshotTable(props: { id: string; rows: ConnectionDetail['snapshots']; currency: string; caption: string }) {
  const captionId = `${props.id}-caption`;
  return (
    <TableScroller labelledBy={captionId}>
      <table class="table table-sm">
        <caption id={captionId} class="sr-only">
          {props.caption}
        </caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col" class="text-right">MRR</th>
            <th scope="col" class="text-right">Subscriptions</th>
            <th scope="col" class="text-right">Trials</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((s) => (
            <tr>
              <th scope="row" class="font-normal whitespace-nowrap">
                <time datetime={s.day}>{formatDay(s.day)}</time>
              </th>
              <td class="text-right tabular-nums">{formatMoney(s.mrr, props.currency)}</td>
              <td class="text-right tabular-nums">{formatNumber(s.activeSubscriptions)}</td>
              <td class="text-right tabular-nums">{s.activeTrials === null ? <NotAvailable class="" /> : formatNumber(s.activeTrials)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroller>
  );
}
