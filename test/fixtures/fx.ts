/** frankfurter.dev v2 payloads for tests (src/sync/fx.ts). */

/** A day's rates as tests describe them: units of each currency per 1 USD. */
export interface FxDay {
  date: string;
  rates: Record<string, number>;
}

/**
 * The two sources out of step, as a live check at 11:07 UTC on 2026-11-06 found them: the blended
 * rates already dated that day, the ECB's still the day before (it publishes in the afternoon, CET).
 */
export const FX_BLENDED_AHEAD = {
  at: Date.parse('2026-11-06T11:07:00.000Z'),
  blended: { date: '2026-11-06', rates: { EUR: 0.89 } },
  ecb: { date: '2026-11-05', rates: { EUR: 0.8909 } },
} as const satisfies { at: number; blended: FxDay; ecb: FxDay };

/** The v2 `/rates` shape: one `{date, base, quote, rate}` per currency and day. */
export function fxV2(...days: FxDay[]): Array<{ date: string; base: string; quote: string; rate: number }> {
  return days.flatMap((d) => Object.entries(d.rates).map(([quote, rate]) => ({ date: d.date, base: 'USD', quote, rate })));
}
