/** Production ProviderContext factory. Owner: Lead. Tests build their own context with a fake fetch. */

import type { ProviderContext } from './types';

export function createProviderContext(opts: {
  pageBudget: number;
  tag?: string;
  /** Epoch ms after which no new request starts (`ProviderContext.deadline`). */
  deadline?: number;
  /** Aborts requests in flight (`ProviderContext.signal`). */
  signal?: AbortSignal;
}): ProviderContext {
  const ctx: ProviderContext = {
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    log: (event, data) => console.log(JSON.stringify({ event, tag: opts.tag, ...data })),
    pageBudget: opts.pageBudget,
  };
  if (opts.deadline !== undefined) ctx.deadline = opts.deadline;
  if (opts.signal !== undefined) ctx.signal = opts.signal;
  return ctx;
}
