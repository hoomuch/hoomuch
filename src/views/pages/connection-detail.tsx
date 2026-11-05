/** Connection detail (GET /connections/:id) with rename / sync / rotate / delete forms. Owner: Experience (pages). */

import type { ConnectionDetail, SyncRunRow } from '../../data/types';
import { formatMoney, formatNumber } from '../../lib/money';
import { getProviderMeta } from '../../providers/registry';
import { ProviderDot, StatusBadge, TestModeBadge } from '../components/badges';
import { ConnectionForm } from '../components/connection-form';
import { DangerZone } from '../components/danger-zone';
import { RelativeTime } from '../components/relative-time';
import { Alert, Button, Card, ConfirmCheckbox, Field, NotAvailable, PageHeader, TableScroller } from '../components/ui';
import { Layout, type PageChrome } from '../layout';
import {
  BackLink,
  describeConfig,
  formatDay,
  formatDuration,
  SyncNotice,
  type SyncState,
} from './shared';

export interface ConnectionDetailPageProps {
  chrome: PageChrome;
  detail: ConnectionDetail;
  /** Non-null while the connection waits for its first sync. */
  sync: SyncState | null;
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
  if (run.ok === null) return <span class="text-base-content/70">Running</span>;
  return run.ok ? <span>OK</span> : <span class="text-error">Failed</span>;
}

export function ConnectionDetailPage(props: ConnectionDetailPageProps) {
  const d = props.detail;
  const meta = getProviderMeta(d.provider);
  const base = `/connections/${d.id}`;
  const config = describeConfig(meta, d.config);
  const nonSecretFields = meta.fields.filter((f) => !f.secret).map((f) => f.name);
  const rotateValues =
    props.rotate?.values ??
    Object.fromEntries(nonSecretFields.filter((k) => d.config[k]).map((k) => [k, d.config[k]!]));
  const rotateFailed = Boolean(props.rotate?.error) || Object.values(props.rotate?.fieldErrors ?? {}).some(Boolean);

  return (
    <Layout
      {...props.chrome}
      title={rotateFailed ? `Error: ${d.name}` : d.name}
      nav="connections"
      noindex
      refresh={props.sync?.refresh ?? undefined}
    >
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
        actions={
          <form method="post" action={`${base}/sync`}>
            <Button variant="secondary">Sync now</Button>
          </form>
        }
      />

      <div class="grid gap-6">
        {props.sync ? <SyncNotice sync={props.sync} /> : null}

        {d.lastError ? (
          <Alert tone="error" title="Last sync failed">
            {d.lastError}
          </Alert>
        ) : null}

        <Card title="Details">
          <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt class="text-base-content/60">Last synced</dt>
            <dd>
              <RelativeTime ms={d.lastSyncedAt} now={props.now} />
            </dd>
            <dt class="text-base-content/60">Connected</dt>
            <dd>
              <RelativeTime ms={d.createdAt} now={props.now} />
            </dd>
            {d.keyHint ? (
              <>
                <dt class="text-base-content/60">Key</dt>
                <dd class="font-mono">{d.keyHint}</dd>
              </>
            ) : null}
            {config.map((row) => (
              <>
                <dt class="text-base-content/60">{row.label}</dt>
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
                  <summary class="cursor-pointer text-sm text-base-content/70">
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
            <p class="text-sm text-base-content/70">No snapshots yet. The first one is taken on the first sync.</p>
          )}
        </Card>

        <Card title="Recent syncs">
          {d.recentRuns.length > 0 ? (
            <TableScroller labelledBy="recent-syncs-caption">
              <table class="table table-sm">
                <caption id="recent-syncs-caption" class="sr-only">
                  Recent sync runs, newest first
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col">Started</th>
                    <th scope="col" class="text-right">Duration</th>
                    <th scope="col">Result</th>
                    <th scope="col" class="text-right">Events</th>
                    <th scope="col">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {d.recentRuns.map((r) => (
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
                      <td class="text-base-content/70">{r.message ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
          ) : (
            <p class="text-sm text-base-content/70">No syncs yet.</p>
          )}
        </Card>

        <Card title="Rename">
          <form method="post" action={`${base}/rename`} class="max-w-sm">
            <Field name="name" label="Name" value={d.name} required maxlength={60} autocomplete="off" />
            <Button variant="secondary">Save name</Button>
          </form>
        </Card>

        {meta.fields.length > 0 ? (
          <Card
            id="replace-key"
            title="Replace key"
            description={`The current key stays in use until ${meta.name} accepts the new one.`}
          >
            <ConnectionForm
              meta={meta}
              mode="rotate"
              action={`${base}/rotate`}
              values={rotateValues}
              fieldErrors={props.rotate?.fieldErrors}
              error={props.rotate?.error}
            />
          </Card>
        ) : null}

        <DangerZone
          title="Delete connection"
          description={
            d.provider === 'demo'
              ? 'Deletes the demo data. You can add it again any time.'
              : `Deletes the stored key and all snapshots, transactions and sync history for this connection. This can’t be undone. The key stays active in ${meta.name}; revoke it there if you no longer need it.`
          }
        >
          <form method="post" action={`${base}/delete`}>
            <ConfirmCheckbox label={<>Yes, delete “{d.name}” and all of its data.</>} />
            <Button variant="danger">Delete connection</Button>
          </form>
        </DangerZone>
      </div>
    </Layout>
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
