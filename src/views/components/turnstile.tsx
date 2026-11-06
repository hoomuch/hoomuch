/**
 * Cloudflare Turnstile widget for the log-in and sign-up forms. Owner: Experience (components).
 * Rendered only when the instance configures Turnstile (lib/bot-defense.ts). The server renders an
 * empty box; after hydration the widget loads Cloudflare's script and fills it in, writing its
 * token into a hidden `cf-turnstile-response` input inside the form.
 */

import { useEffect, useRef, useState } from 'react';
import { TURNSTILE_FIELD, TURNSTILE_ORIGIN, type BotAction } from '../../lib/bot-defense';

interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string | null | undefined;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** Must be fetched from exactly this URL (Cloudflare's rule); the CSP allows this origin on auth pages. */
const SCRIPT_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;

let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.addEventListener('load', () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('no turnstile'))));
    script.addEventListener('error', () => {
      loading = null;
      reject(new Error('turnstile failed to load'));
    });
    document.head.appendChild(script);
  });
  return loading;
}

export function TurnstileWidget(props: { siteKey: string; action: BotAction }) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    let widgetId: string | null | undefined;
    loadTurnstile()
      .then((turnstile) => {
        if (!live || !box.current) return;
        widgetId = turnstile.render(box.current, {
          sitekey: props.siteKey,
          action: props.action,
          size: 'flexible',
          theme: 'auto',
          'response-field-name': TURNSTILE_FIELD,
          'error-callback': () => setFailed(true),
        });
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [props.siteKey, props.action]);

  const verb = props.action === 'signup' ? 'sign up' : 'log in';
  return (
    <div className="mt-2 flex flex-col gap-2">
      {/* Turnstile owns this box's contents; React never renders children into it. */}
      <div ref={box} className="min-h-[65px] w-full" />
      {failed ? (
        <p role="alert" className="text-caption text-destructive-foreground">
          The security check couldn’t run. Allow challenges.cloudflare.com in your content blocker, then reload.
        </p>
      ) : null}
      <noscript>
        <p className="text-caption text-muted-foreground">Turn on JavaScript to {verb}: this page runs a short security check.</p>
      </noscript>
    </div>
  );
}
