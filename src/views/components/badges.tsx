/**
 * ProviderDot, StatusBadge, TestModeBadge. Owner: Experience (design). CONTRACT: props are fixed.
 * `dotClass` is a literal Tailwind class from the provider registry (e.g. "bg-[#635BFF]");
 * CSP forbids inline styles, so never build colours with style="".
 *
 * Provider identity is a filled dot; connection status uses outline glyphs (check, arc, clock,
 * exclamation) so the two never read as the same signal, even where RevenueCat's coral sits
 * next to an error.
 */

import type { ConnectionStatus } from '../../db/queries';
import { IconCheckCircle, IconClock, IconErrorCircle, IconSync } from './icons';
import { cx } from './ui';

/** Hairline darker rim keeps light brand colours (Lemon Squeezy yellow) crisp on white. */
const DOT_SIZE = { sm: 'size-2', md: 'size-2.5' } as const;

export function ProviderDot(props: { dotClass: string; size?: 'sm' | 'md'; class?: string }) {
  return (
    <span
      aria-hidden="true"
      class={cx('inline-block shrink-0 rounded-full border border-black/10', DOT_SIZE[props.size ?? 'sm'], props.dotClass, props.class)}
    />
  );
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  pending: 'Pending',
  syncing: 'Syncing',
  ok: 'Up to date',
  error: 'Error',
};

const PILL = 'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption font-semibold whitespace-nowrap';

const STATUS_CLASS: Record<ConnectionStatus, string> = {
  ok: 'border-base-300 text-base-content',
  syncing: 'border-base-300 text-base-content',
  pending: 'border-base-300 text-ink-2',
  error: 'border-error/40 text-error',
};

function StatusIcon(props: { status: ConnectionStatus }) {
  switch (props.status) {
    case 'ok':
      return <IconCheckCircle class="size-3.5 shrink-0 text-success" />;
    case 'syncing':
      return <IconSync class="size-3.5 shrink-0 text-info motion-safe:animate-spin" />;
    case 'error':
      return <IconErrorCircle class="size-3.5 shrink-0" />;
    default:
      return <IconClock class="size-3.5 shrink-0" />;
  }
}

export function StatusBadge(props: { status: ConnectionStatus; class?: string }) {
  return (
    <span class={cx(PILL, STATUS_CLASS[props.status], props.class)}>
      <StatusIcon status={props.status} />
      {STATUS_LABEL[props.status]}
    </span>
  );
}

export function TestModeBadge(props: { class?: string } = {}) {
  return (
    <span class={cx(PILL, 'border-warning/50 text-warning', props.class)} title="Data from the provider’s test mode">
      Test mode
    </span>
  );
}
