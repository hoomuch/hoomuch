/**
 * Server rendering: one React page → a complete HTML document. Owner: Experience (design).
 *
 * Routes call `renderPage(c, 'dashboard', props)`. The page is rendered to a string with React,
 * its props go into a JSON data block, and /client/entry.js hydrates the same component in the
 * browser. Forms are still plain POST forms, so every action works before (and without) hydration.
 */

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { PageRoot, serializePayload } from './page-root';
import { PAGES, type PageName, type PagePropsOf } from './pages';

export interface PagePayload {
  name: PageName;
  props: unknown;
  /** Server clock for this request (epoch ms); see useNow(). */
  now: number;
}

/** The full document for a page, doctype included. Exported for tests. */
export function renderDocument<N extends PageName>(name: N, props: PagePropsOf<N>, now: number = Date.now()): string {
  const json = serializePayload({ name, props, now } satisfies PagePayload);
  // The registry's union of components can't be called with a generic N's props; the signature
  // above already ties `name` to its props.
  const Page = PAGES[name] as unknown as ComponentType<Record<string, unknown>>;
  return (
    '<!doctype html>' +
    renderToString(
      <PageRoot json={json} now={now}>
        <Page {...(props as Record<string, unknown>)} />
      </PageRoot>,
    )
  );
}

export function renderPage<N extends PageName>(
  c: Context,
  name: N,
  props: PagePropsOf<N>,
  status?: ContentfulStatusCode,
): Response {
  return c.html(renderDocument(name, props), status);
}
