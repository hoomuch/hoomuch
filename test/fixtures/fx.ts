/** frankfurter.dev v2 payloads for tests (src/sync/fx.ts). */

/** A day's rates as tests describe them: units of each currency per 1 USD. */
export interface FxDay {
  date: string;
  rates: Record<string, number>;
}

/** The v2 `/rates` shape: one `{date, base, quote, rate}` per currency and day. */
export function fxV2(...days: FxDay[]): Array<{ date: string; base: string; quote: string; rate: number }> {
  return days.flatMap((d) => Object.entries(d.rates).map(([quote, rate]) => ({ date: d.date, base: 'USD', quote, rate })));
}
