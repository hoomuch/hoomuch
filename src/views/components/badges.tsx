/**
 * ProviderDot, StatusBadge, TestModeBadge. Owner: Experience (design). CONTRACT: props are fixed.
 * `dotClass` is a literal Tailwind class from the provider registry (e.g. "bg-[#635BFF]"), so
 * brand colours come from compiled CSS, never from a style attribute.
 *
 * Provider identity is a filled dot; connection status uses outline Lucide glyphs (check, arc,
 * clock, alert) inside a coss Badge, so the two never read as the same signal, even where
 * RevenueCat's coral sits next to an error.
 */

import { CircleAlert, CircleCheck, Clock, LoaderCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { ConnectionStatus } from '../../db/queries';
import { cn } from '../../lib/utils';

/** A hairline darker rim keeps light brand colours (Lemon Squeezy yellow) crisp on white. */
const DOT_SIZE = { sm: 'size-2', md: 'size-2.5' } as const;

export function ProviderDot(props: { dotClass: string; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block shrink-0 rounded-full border border-black/10', DOT_SIZE[props.size ?? 'sm'], props.dotClass, props.className)}
    />
  );
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  pending: 'Pending',
  syncing: 'Syncing',
  ok: 'Up to date',
  error: 'Error',
};

/** coss badge variants: neutral outline for the calm states, error-toned when a sync failed. */
const STATUS_VARIANT = {
  ok: 'outline',
  syncing: 'outline',
  pending: 'outline',
  error: 'error',
} as const satisfies Record<ConnectionStatus, string>;

function StatusIcon(props: { status: ConnectionStatus }) {
  switch (props.status) {
    case 'ok':
      return <CircleCheck className="text-success" />;
    case 'syncing':
      return <LoaderCircle className="text-info motion-safe:animate-spin" />;
    case 'error':
      return <CircleAlert />;
    default:
      return <Clock />;
  }
}

export function StatusBadge(props: { status: ConnectionStatus; className?: string }) {
  return (
    <Badge
      variant={STATUS_VARIANT[props.status]}
      className={cn(props.status === 'pending' && 'text-muted-foreground', props.className)}
    >
      <StatusIcon status={props.status} />
      {STATUS_LABEL[props.status]}
    </Badge>
  );
}

export function TestModeBadge(props: { className?: string } = {}) {
  return (
    <Badge variant="warning" className={props.className} title="Data from the provider’s test mode">
      Test mode
    </Badge>
  );
}
