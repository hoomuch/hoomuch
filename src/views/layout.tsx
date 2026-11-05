/**
 * Page shell: doctype, <head>, top nav, flash area, main column. Owner: Experience (design).
 * CONTRACT: `LayoutProps` is used by every page — don't change it without the Experience lead.
 *
 * At phone widths the header is two rows: mark + "Settings" on top, the nav on its own
 * full-width row below (scrolls sideways if it ever has to). From `sm` up it's one row.
 * `width="narrow"` centres a ~400px column; the page supplies the <Card> inside it.
 */

import type { Child } from 'hono/jsx';
import { raw } from 'hono/html';
import type { Flash as FlashMsg, SessionUser } from '../env';
import { Flash } from './components/flash';
import { Wordmark } from './components/icons';
import { Owl } from './components/mascot';

export type NavKey = 'dashboard' | 'connections' | 'transactions' | 'settings';

/** What every page needs from the request to draw the chrome. */
export interface PageChrome {
  user: SessionUser | null;
  flash: FlashMsg | null;
}

export interface LayoutProps extends PageChrome {
  /** Page title without the app name; the layout appends " · hoomuch". */
  title: string;
  /** Meta description. Defaults to the app's one-line value proposition. */
  description?: string;
  /** Highlights the matching top-nav item. */
  nav?: NavKey | null;
  /** 'narrow' centres a single card (auth pages); 'default' is the ~960px app column. */
  width?: 'default' | 'narrow';
  /**
   * Adds <meta http-equiv="refresh"> — zero-JS polling while a first sync runs.
   * Pass a `url` with a counter (e.g. "?poll=3") so callers can stop after a few tries.
   * `stopUrl` (same page, refresh turned off) adds a "Stop automatic refresh" link right after
   * the skip link, so keyboard and screen-reader users can turn the reloads off within a couple
   * of keystrokes, before the next reload resets their place (WCAG 2.2.1 Timing Adjustable).
   */
  refresh?: { seconds: number; url?: string; stopUrl?: string };
  /** Keep app pages out of search engines. */
  noindex?: boolean;
  /**
   * Public, personality-allowed pages (landing, 404): a "Log in" link in the signed-out header
   * and the footer with the sleeping owl. Never set it on settings, forms, errors or pricing.
   */
  marketing?: boolean;
  /** Footer line on marketing pages, e.g. "Syncs every hour, so you can check less often." */
  footerNote?: string;
  children?: Child;
}

export const APP_NAME = 'hoomuch';
/**
 * AGPL-3.0 §13: anyone using a modified, hosted copy must be offered its source.
 * If you run a modified version, point this at your fork.
 */
export const SOURCE_URL = 'https://github.com/tahabozdemir/hoomuch';
export const DEFAULT_DESCRIPTION =
  'MRR, ARR, subscriptions and revenue from Stripe, Lemon Squeezy and RevenueCat, on one dashboard.';

/** The daily places. Settings sits apart on the right; Log out lives inside Settings. */
const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: 'dashboard', href: '/dashboard', label: 'Dashboard' },
  { key: 'connections', href: '/connections', label: 'Connections' },
  { key: 'transactions', href: '/transactions', label: 'Transactions' },
];

/** Shared horizontal frame so header, main and footer edges line up: 960px content box. */
const FRAME = 'mx-auto w-full max-w-[60rem] px-4 sm:px-6';
const FRAME_NARROW = 'mx-auto w-full max-w-[28rem] px-4 sm:px-6'; // 400px card at sm+

/** Visually hidden until focused, then pinned top-left over the header (skip link + stop-refresh link). */
const SKIP_LINK =
  'sr-only rounded-field border border-base-300 bg-base-100 px-4 py-2 text-body font-semibold focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50';

/**
 * Nav link: a daisyUI tab (inside `tabs tabs-border`), regular weight in both states (no width
 * jump). The current one (aria-current, daisyUI's active state) gets ink and the tab's bar, drawn
 * in the accent (before:text-accent: the bar is the tab's currentColor). Idle tabs are ink-2:
 * daisyUI's idle tone (base-content/50) is under AA. focus-inset keeps the ring visible inside
 * the scrolling phone nav.
 */
const NAV_TAB =
  'tab focus-inset h-11 whitespace-nowrap text-ink-2 before:text-accent hover:text-base-content sm:h-14 aria-[current=page]:text-base-content';

export function Layout(props: LayoutProps) {
  const fullTitle = props.title ? `${props.title} · ${APP_NAME}` : APP_NAME;
  const narrow = props.width === 'narrow';
  const user = props.user;
  return (
    <>
      {raw('<!doctype html>')}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{fullTitle}</title>
          <meta name="description" content={props.description ?? DEFAULT_DESCRIPTION} />
          {props.noindex ? <meta name="robots" content="noindex" /> : null}
          {props.refresh ? (
            <meta
              http-equiv="refresh"
              content={props.refresh.url ? `${props.refresh.seconds};url=${props.refresh.url}` : String(props.refresh.seconds)}
            />
          ) : null}
          <meta name="color-scheme" content="light dark" />
          <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
          <meta name="theme-color" content="#0f1013" media="(prefers-color-scheme: dark)" />
          <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
          <link rel="stylesheet" href="/app.css" />
          {/* Optional, same-origin (CSP script-src 'self'): submit feedback only. Every form works without it. */}
          <script src="/app.js" defer></script>
        </head>
        <body class="flex min-h-dvh flex-col bg-base-100 font-sans text-body text-base-content antialiased">
          <a href="#main" class={SKIP_LINK}>
            Skip to content
          </a>
          {props.refresh?.stopUrl ? (
            <a href={props.refresh.stopUrl} class={SKIP_LINK}>
              Stop automatic refresh
            </a>
          ) : null}

          <header class="border-b border-base-300">
            <div class={`${FRAME} flex flex-wrap items-center gap-x-8`}>
              <a
                href={user ? '/dashboard' : '/'}
                class="-ml-1 flex h-12 items-center rounded-field px-1 text-title tracking-tight sm:h-14"
              >
                <Wordmark />
              </a>
              {user ? (
                <>
                  {/* -mb-px lets the active 2px accent bar sit on the header's hairline. Below sm the
                      nav bleeds to both screen edges (-mx-4 + 2rem wider): with plain w-full it
                      stopped 2rem short, and a half-hidden item wasn't scrolled into view on focus. */}
                  {/* px-1 below sm: the tabs' own 12px padding lines their text up with the wordmark. */}
                  <nav
                    aria-label="Main"
                    class="tabs tabs-border order-last -mx-4 -mb-px w-[calc(100%+2rem)] flex-nowrap justify-between self-end overflow-x-auto px-1 sm:order-none sm:mx-0 sm:w-auto sm:justify-start sm:overflow-visible sm:px-0"
                  >
                    {NAV.map((n) => (
                      <a href={n.href} aria-current={props.nav === n.key ? 'page' : undefined} class={NAV_TAB}>
                        {n.label}
                      </a>
                    ))}
                  </nav>
                  {/* Same look and current-page marker as the nav, kept apart from the daily places.
                      -mr-3 puts its text on the frame's right edge. */}
                  <div class="tabs tabs-border -mr-3 ml-auto">
                    <a href="/settings" aria-current={props.nav === 'settings' ? 'page' : undefined} class={NAV_TAB}>
                      Settings
                    </a>
                  </div>
                </>
              ) : props.marketing ? (
                <a
                  href="/login"
                  class="-mr-1 ml-auto flex h-12 items-center rounded-field px-1 text-body text-ink-2 hover:text-base-content sm:h-14"
                >
                  Log in
                </a>
              ) : null}
            </div>
          </header>

          <main id="main" class={narrow ? `${FRAME_NARROW} flex-1 py-12 sm:py-20` : `${FRAME} flex-1 py-8 sm:py-10`}>
            <Flash flash={props.flash} />
            {props.children}
          </main>

          <footer class="border-t border-base-300">
            {props.marketing ? (
              <div class={`${FRAME} flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-8 text-body text-ink-2`}>
                <span class="flex items-center gap-3">
                  <Owl pose="asleep" class="opacity-70" />
                  <Wordmark class="font-semibold tracking-tight text-base-content" />
                </span>
                {props.footerNote ? <span>{props.footerNote}</span> : null}
              </div>
            ) : (
              <div class={`${FRAME} flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-6 text-caption text-ink-2`}>
                <span>{APP_NAME}</span>
                <span>Only ever reads. Keys are encrypted at rest.</span>
              </div>
            )}
          </footer>
        </body>
      </html>
    </>
  );
}
