/** Production ProviderContext factory. Owner: Lead. Tests build their own context with a fake fetch. */

import type { ProviderContext } from './types';

export function createProviderContext(opts: { pageBudget: number; tag?: string }): ProviderContext {
  return {
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    log: (event, data) => console.log(JSON.stringify({ event, tag: opts.tag, ...data })),
    pageBudget: opts.pageBudget,
  };
}
