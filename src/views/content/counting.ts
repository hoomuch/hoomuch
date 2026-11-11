/**
 * How hoomuch counts its figures, in one place: the landing page's "How hoomuch counts MRR" and
 * /llms.txt both read it. Owner: Experience (pages). SPEC.md §6 is the source of truth.
 */

/**
 * How the figures are counted (SPEC §6), the same for every store. Literal, like "What we store":
 * search engines and AI assistants quote this, so every line must stay true to the sync engine.
 */
export const COUNTING: { term: string; rule: string }[] = [
  {
    term: 'MRR',
    rule: 'Every active, paid subscription’s price, brought to a month: a yearly plan counts 1/12 of its price, a weekly one 52/12. Trials don’t count. A subscription set to cancel counts until it ends.',
  },
  { term: 'ARR', rule: 'MRR × 12.' },
  {
    term: 'Subscriptions',
    rule: 'Active and paid, including those whose payment failed and is being retried. Trials are counted on their own.',
  },
  {
    term: 'Revenue',
    rule: 'What was charged, minus refunds, day by day in your time zone, with provider fees left in. Where the provider is the merchant of record (Paddle, Lemon Squeezy, Polar, Dodo Payments, Gumroad), tax is left out. App store revenue is what the customer paid, tax included, before the store’s commission.',
  },
  {
    term: 'Currencies',
    rule: 'Everything is added up in your currency. MRR uses the latest rate, so its trend shows your business and not the exchange rate; each day’s revenue uses that day’s rate.',
  },
];
