/**
 * The landing page's provider strip: every provider hoomuch reads, straight from the registry, in
 * one slow loop. Owner: Experience (pages).
 *
 * CSS only (`.marquee` in app.css), so it moves before hydration and renders the same on the
 * server and in the browser. Two copies of the list sit side by side and the track slides by one
 * copy, so the loop has no seam; the second copy is aria-hidden. It pauses on hover, and the toggle
 * pauses it for keyboard and touch users too (WCAG 2.2.2). The toggle is a checkbox drawn as an icon
 * button, so it works without JavaScript. Under reduced motion it's a still, wrapped list and the
 * toggle goes away.
 */

import { Pause, Play } from 'lucide-react';
import { cn } from '../../lib/utils';
import { PROVIDERS } from '../../providers/registry';
import { ProviderLogo } from './provider-logos';

const LISTED = PROVIDERS.filter((p) => p.id !== 'demo');
const TOGGLE_ID = 'provider-strip-pause';

export function ProviderStrip(props: { className?: string }) {
  return (
    <div className={props.className}>
      <input id={TOGGLE_ID} type="checkbox" className="marquee-pause sr-only motion-reduce:hidden" />
      <p className="flex items-center justify-center gap-1.5 text-caption text-muted-foreground">
        Works with {LISTED.length} billing platforms and app stores
        <label
          htmlFor={TOGGLE_ID}
          className="marquee-toggle inline-flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors duration-150 hover:bg-accent hover:text-foreground motion-reduce:hidden"
        >
          <Pause className="marquee-icon-pause size-3.5" />
          <Play className="marquee-icon-play size-3.5" />
          <span className="sr-only">Pause the list of providers</span>
        </label>
      </p>
      <div className="marquee-viewport mt-4 overflow-hidden">
        <div className="marquee flex w-max motion-reduce:w-auto">
          <ProviderList />
          <ProviderList copy />
        </div>
      </div>
    </div>
  );
}

function ProviderList(props: { copy?: boolean }) {
  return (
    <ul
      aria-label={props.copy ? undefined : 'Supported providers'}
      aria-hidden={props.copy || undefined}
      className={cn(
        'flex shrink-0 items-center gap-x-10 gap-y-3 pr-10 motion-reduce:flex-1 motion-reduce:flex-wrap motion-reduce:justify-center motion-reduce:gap-x-6 motion-reduce:pr-0',
        props.copy && 'motion-reduce:hidden',
      )}
    >
      {LISTED.map((p) => (
        <li key={p.id} className="flex items-center gap-2.5 whitespace-nowrap text-lead text-muted-foreground">
          <ProviderLogo provider={p.id} size="md" />
          {p.name}
        </li>
      ))}
    </ul>
  );
}
