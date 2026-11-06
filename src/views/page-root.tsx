/**
 * What every page tree is wrapped in, on the server and in the browser. Owner: Experience (design).
 *
 * The server renders a page with React, writes its props into a JSON data block, and the browser
 * hydrates the same component from it (src/client/entry.tsx). Both sides wrap the page in
 * <PageRoot>, so the tree, and therefore the markup, is identical:
 *  - `json` is the serialized payload, rendered back verbatim by <PagePayloadScript>.
 *  - `now` is the server's clock for that request. Relative times ("4 min ago") read it through
 *    useNow(), so the browser doesn't hydrate a different minute than the server rendered.
 *  - `timeZone` is the signed-in user's zone (UTC when signed out). Dates and times read it
 *    through useTimeZone(), never the browser's own zone, so both sides print the same time.
 */

import { createContext, useContext, type ReactNode } from 'react';

export interface PageContextValue {
  json: string;
  now: number;
  timeZone?: string;
}

const PageContext = createContext<PageContextValue | null>(null);

/** The request's clock (server time). Outside a page (unit tests) it's the current time. */
export function useNow(): number {
  return useContext(PageContext)?.now ?? Date.now();
}

/** The zone times are shown in (the user's, SPEC §6). Outside a page (unit tests) it's UTC. */
export function useTimeZone(): string {
  return useContext(PageContext)?.timeZone ?? 'UTC';
}

/** The page payload as a JSON data block. Not executed, so CSP script-src doesn't apply to it. */
export function PagePayloadScript() {
  const ctx = useContext(PageContext);
  if (!ctx) return null;
  return <script id="hm-page" type="application/json" dangerouslySetInnerHTML={{ __html: ctx.json }} />;
}

export function PageRoot(props: PageContextValue & { children?: ReactNode }) {
  return (
    <PageContext.Provider value={{ json: props.json, now: props.now, timeZone: props.timeZone ?? 'UTC' }}>
      {props.children}
    </PageContext.Provider>
  );
}

/**
 * JSON that is safe inside <script>: `<` is escaped so no string can close the element, and the
 * two JS-hostile line separators are escaped too.
 */
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), 'g');
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), 'g');

export function serializePayload(payload: unknown): string {
  return JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(LINE_SEPARATOR, '\\u2028')
    .replace(PARAGRAPH_SEPARATOR, '\\u2029');
}
