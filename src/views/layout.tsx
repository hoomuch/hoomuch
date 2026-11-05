/**
 * Page shell: the whole document (<html>, <head>, top nav, flash area, main column, footer).
 * Owner: Experience (design).
 * CONTRACT: `LayoutProps` is used by every page — don't change it without the Experience lead.
 *
 * The server renders it with React and the browser hydrates `document` with the same tree
 * (views/page-root.tsx), so everything here, <head> included, must render identically on both.
 *
 * At phone widths the header is two rows: mark + "Settings" on top, the nav on its own
 * full-width row below (scrolls sideways if it ever has to). From `sm` up it's one row.
 * `width="narrow"` centres a ~400px column; the page supplies the <Card> inside it.
 */

import { ArrowUpRight, LockKeyhole } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Flash as FlashMsg, SessionUser } from '../env';
import { cn } from '../lib/utils';
import { HeroBackdrop, QuietBackdrop } from './components/backdrop';
import { Celebration } from './components/celebration';
import { Flash } from './components/flash';
import { Wordmark } from './components/icons';
import { Owl } from './components/mascot';
import { PagePayloadScript } from './page-root';

export type NavKey = 'dashboard' | 'connections' | 'transactions' | 'settings';

/** What every page needs from the request to draw the chrome. */
export interface PageChrome {
  user: SessionUser | null;
  flash: FlashMsg | null;
  /** One confetti burst over the page (once, right after sign-up). */
  celebrate?: boolean;
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
   * Adds <meta http-equiv="refresh">: polling while a first sync runs, with or without JS.
   * Pass a `url` with a counter (e.g. "?poll=3") so callers can stop after a few tries.
   * `stopUrl` (same page, refresh turned off) adds a "Stop automatic refresh" link right after
   * the skip link, so keyboard and screen-reader users can turn the reloads off within a couple
   * of keystrokes, before the next reload resets their place (WCAG 2.2.1 Timing Adjustable).
   */
  refresh?: { seconds: number; url?: string; stopUrl?: string };
  /** Keep app pages out of search engines. */
  noindex?: boolean;
  /**
   * Public, personality-allowed pages (landing, 404): a "Log in" link in the signed-out header,
   * the soft brand glow behind the top of the page and the footer with the sleeping owl. Never
   * set it on settings, forms, errors or pricing.
   */
  marketing?: boolean;
  /**
   * A still ray light with grain behind the page header (views/components/backdrop.tsx). The
   * top-level app pages (dashboard, connections list, transactions, settings). The connect form, a
   * connection's page (keys, deletes) and errors stay plain. Marketing pages get the moving hero
   * version on their own.
   */
  backdrop?: boolean;
  /** Footer line on marketing pages, e.g. "Syncs every hour, so you can check less often." */
  footerNote?: string;
  children?: ReactNode;
}

export const APP_NAME = 'hoomuch';
/**
 * AGPL-3.0 §13: anyone using a modified, hosted copy must be offered its source.
 * If you run a modified version, point this at your fork.
 */
export const SOURCE_URL = 'https://github.com/tahabozdemir/hoomuch';
/** Where a self-hoster starts: the README's deploy section. */
const SELF_HOST_URL = `${SOURCE_URL}#deploy-to-cloudflare`;
const ISSUES_URL = `${SOURCE_URL}/issues`;
const LICENSE_URL = `${SOURCE_URL}/blob/main/LICENSE`;
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
  'sr-only rounded-lg border bg-background px-4 py-2 text-body font-semibold shadow-xs/5 focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50';

/**
 * Nav link, coss's underline tab made of a link. Regular weight in both states (no width jump);
 * the current one (aria-current) gets foreground text and a 2px brand bar sitting on the header's
 * hairline. Idle links are muted-foreground (AA). focus-inset keeps the ring visible inside the
 * scrolling phone nav.
 */
const NAV_LINK =
  'focus-inset relative inline-flex h-11 items-center rounded-md px-3 whitespace-nowrap text-body text-muted-foreground transition-colors duration-150 hover:text-foreground after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-transparent sm:h-14 aria-[current=page]:text-foreground aria-[current=page]:after:bg-brand';

export function Layout(props: LayoutProps) {
  const fullTitle = props.title ? `${props.title} · ${APP_NAME}` : APP_NAME;
  const narrow = props.width === 'narrow';
  const user = props.user;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{fullTitle}</title>
        <meta name="description" content={props.description ?? DEFAULT_DESCRIPTION} />
        {props.noindex ? <meta name="robots" content="noindex" /> : null}
        {props.refresh ? (
          <meta
            httpEquiv="refresh"
            content={props.refresh.url ? `${props.refresh.seconds};url=${props.refresh.url}` : String(props.refresh.seconds)}
          />
        ) : null}
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0f1013" media="(prefers-color-scheme: dark)" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="preload" href="/fonts/geist.woff2" as="font" type="font/woff2" crossOrigin="" />
        <link rel="stylesheet" href="/app.css" />
        {/* Same origin (CSP script-src 'self'), a deferred module: hydrates the page after it has parsed. */}
        <script type="module" src="/client/entry.js" />
      </head>
      <body className="flex min-h-dvh flex-col bg-background font-sans text-body text-foreground antialiased">
        <a href="#main" className={SKIP_LINK}>
          Skip to content
        </a>
        {props.refresh?.stopUrl ? (
          <a href={props.refresh.stopUrl} className={SKIP_LINK}>
            Stop automatic refresh
          </a>
        ) : null}

        {/* Light from above, behind the header: ray light and grain (Magic UI). Moving on marketing
            pages, still on the dashboard. */}
        {props.marketing ? <HeroBackdrop /> : props.backdrop ? <QuietBackdrop /> : null}

        <header className={cn('border-b', props.marketing && 'border-transparent')}>
          <div className={`${FRAME} flex flex-wrap items-center gap-x-6`}>
            <a
              href={user ? '/dashboard' : '/'}
              className="-ml-1 flex h-12 items-center rounded-md px-1 text-title font-semibold tracking-tight sm:h-14"
            >
              <Wordmark />
            </a>
            {user ? (
              <>
                {/* Below sm the nav bleeds to both screen edges (-mx-4 + 2rem wider) and scrolls;
                    -mb-px lets the active bar sit on the header's hairline. */}
                <nav
                  aria-label="Main"
                  className="order-last -mx-4 -mb-px flex w-[calc(100%+2rem)] flex-nowrap justify-between self-end overflow-x-auto px-1 sm:order-none sm:mx-0 sm:w-auto sm:justify-start sm:overflow-visible sm:px-0"
                >
                  {NAV.map((n) => (
                    <a
                      key={n.key}
                      href={n.href}
                      data-slot="nav-link"
                      aria-current={props.nav === n.key ? 'page' : undefined}
                      className={NAV_LINK}
                    >
                      {n.label}
                    </a>
                  ))}
                </nav>
                {/* Same look and current-page marker as the nav, kept apart from the daily places.
                    -mr-3 puts its text on the frame's right edge. */}
                <div className="-mr-3 -mb-px ml-auto flex self-end">
                  <a
                    href="/settings"
                    data-slot="nav-link"
                    aria-current={props.nav === 'settings' ? 'page' : undefined}
                    className={NAV_LINK}
                  >
                    Settings
                  </a>
                </div>
              </>
            ) : props.marketing ? (
              <a
                href="/login"
                className="-mr-1 ml-auto flex h-12 items-center rounded-md px-1 text-body text-muted-foreground transition-colors hover:text-foreground sm:h-14"
              >
                Log in
              </a>
            ) : null}
          </div>
        </header>

        <main id="main" className={narrow ? `${FRAME_NARROW} flex-1 py-12 sm:py-20` : `${FRAME} flex-1 py-8 sm:py-10`}>
          <Flash flash={props.flash} />
          {props.children}
        </main>

        {props.marketing ? (
          <MarketingFooter note={props.footerNote} signedIn={Boolean(user)} />
        ) : (
          // The owl naps on the footer of the daily pages (dashboard, connections list,
          // transactions): the ones with the backdrop, minus Settings. Never on settings, connect
          // forms, a connection's page (keys, deletes), auth or error pages.
          <AppFooter owl={Boolean(props.backdrop) && props.nav !== 'settings'} />
        )}
        {props.celebrate ? <Celebration /> : null}
        <PagePayloadScript />
      </body>
    </html>
  );
}

// ---------- footer ----------
//
// Two footers that share one bottom line. Every page links to its source (AGPL-3.0 §13).
// Both carry the wordmark, with the asleep owl resting on the top hairline above it.
// Marketing pages (landing, signed-out 404): the wordmark and the page's dry line, four links,
// then the meta line. App pages: one row, the wordmark, Source code and Report an issue, the
// read-only promise; the owl only on the daily pages. Hover is colour only (design/system.md §3.6).

/**
 * Quiet footer link. py-1 makes it a 28px target in body text, 24px in captions (WCAG 2.5.8);
 * -mx-1 px-1 gives the focus ring room without moving the text off the frame's edge.
 */
function FooterLink(props: { href: string; external?: boolean; children: ReactNode }) {
  return (
    <a
      href={props.href}
      className="-mx-1 inline-flex items-center gap-1 rounded-md px-1 py-1 text-muted-foreground transition-colors duration-150 hover:text-foreground"
    >
      {props.children}
      {props.external ? (
        <>
          <ArrowUpRight className="size-3.5 shrink-0" />
          <span className="sr-only"> (GitHub)</span>
        </>
      ) : null}
    </a>
  );
}

/**
 * Asleep on the hairline: the PNG's lowest pixels are its bottom edge, so bottom-full rests it
 * on the footer's top border. Lined up with the wordmark below it. Needs a `relative` parent.
 */
function FooterOwl() {
  return <Owl pose="asleep" className="absolute bottom-full left-4 opacity-70 sm:left-6" />;
}

/** Same size and weight as the header's, so the name reads as the logo at both ends. */
function FooterWordmark() {
  return <Wordmark className="text-title font-semibold tracking-tight text-foreground" />;
}

/** The promise every page repeats, with its one icon. */
function TrustLine() {
  return (
    <p className="flex items-center gap-2">
      <LockKeyhole className="size-3.5 shrink-0 text-faint" />
      Only ever reads. Keys are encrypted at rest.
    </p>
  );
}

function MarketingFooter(props: { note?: string; signedIn: boolean }) {
  return (
    // mt-*: room above the hairline for the owl, whatever section ends the page.
    <footer className="mt-12 border-t sm:mt-16">
      <div className={`${FRAME} relative`}>
        <FooterOwl />
        <div className="flex flex-col gap-x-12 gap-y-5 py-10 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <FooterWordmark />
            {props.note ? <p className="mt-1 text-body text-muted-foreground">{props.note}</p> : null}
          </div>
          <nav aria-label="Footer">
            <ul className="flex flex-wrap gap-x-6 gap-y-1 text-body">
              <li>
                <FooterLink href="/#demo">Demo</FooterLink>
              </li>
              <li>
                <FooterLink href="/#store">What we store</FooterLink>
              </li>
              <li>
                <FooterLink href={SELF_HOST_URL} external>
                  Self-host
                </FooterLink>
              </li>
              <li>
                {props.signedIn ? (
                  <FooterLink href="/dashboard">Dashboard</FooterLink>
                ) : (
                  <FooterLink href="/login">Log in</FooterLink>
                )}
              </li>
            </ul>
          </nav>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t py-5 text-caption text-muted-foreground">
          <TrustLine />
          <p>
            Open source under{' '}
            <FooterLink href={LICENSE_URL} external>
              AGPL-3.0
            </FooterLink>
          </p>
        </div>
      </div>
    </footer>
  );
}

function AppFooter(props: { owl: boolean }) {
  return (
    // mt-8 with the owl: room above the hairline so it never touches the last card.
    <footer className={cn('border-t', props.owl && 'mt-8')}>
      <div
        className={`${FRAME} relative flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-6 text-caption text-muted-foreground`}
      >
        {props.owl ? <FooterOwl /> : null}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <FooterWordmark />
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5">
            <FooterLink href={SOURCE_URL} external>
              Source code
            </FooterLink>
            <FooterLink href={ISSUES_URL} external>
              Report an issue
            </FooterLink>
          </nav>
        </div>
        <TrustLine />
      </div>
    </footer>
  );
}
