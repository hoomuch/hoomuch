/**
 * The dashboard calendar: a month of net revenue, day by day, and what happened on the day you
 * pick. Owner: Experience (design).
 *
 * Works before hydration: every day is a link (?day=), the month arrows are links (?month=), and
 * the server renders the picked day. After hydration a day is picked in place (the whole month is
 * already in the payload) and the URL follows with replaceState; the arrows still load the page,
 * because another month needs its own read.
 *
 * Magnitude is one hue (brand), stronger for more, in four steps against the month's best day,
 * with a Less–More key. Every day also shows its amount (from sm up) and speaks it in full, so the
 * tint is never the only way to read it. Weeks start on Monday; days are UTC, like the rest.
 */

import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button as CossButton } from '@/components/ui/button';
import type { CalendarDay, CalendarMonth, ConnectionSummary } from '../../data/types';
import { formatMoney, formatNumber, toMajor } from '../../lib/money';
import { addDays, dayStart } from '../../lib/time';
import { cn } from '../../lib/utils';
import { ProviderDot } from './badges';
import { Card, TextLink } from './ui';

// ---------- formatting ----------

const utc = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts });
const LONG_DAY = utc({ weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
const SHORT_DAY = utc({ month: 'short', day: 'numeric' });
const FULL_DAY = utc({ month: 'short', day: 'numeric', year: 'numeric' });
const MONTH_YEAR = utc({ month: 'long', year: 'numeric' });
const MONTH = utc({ month: 'long' });

const at = (day: string) => new Date(dayStart(day));
/** "Tuesday, Nov 3, 2026" */
export const longDay = (day: string) => LONG_DAY.format(at(day));
/** "Nov 3" */
const shortDay = (day: string) => SHORT_DAY.format(at(day));
/** "Nov 3, 2026" */
const fullDay = (day: string) => FULL_DAY.format(at(day));
/** "November 2026" */
export const monthLabel = (month: string) => MONTH_YEAR.format(at(`${month}-01`));

const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

/** The figure inside a day: whole units, compact from 1,000 up ("$845", "$1.2K"). */
export function cellAmount(net: number, currency: string): string {
  return Math.abs(toMajor(net, currency)) < 1000
    ? formatMoney(net, currency, { whole: true })
    : formatMoney(net, currency, { compact: true });
}

// ---------- layout helpers ----------

const WEEKDAYS = [
  ['Mon', 'Monday'],
  ['Tue', 'Tuesday'],
  ['Wed', 'Wednesday'],
  ['Thu', 'Thursday'],
  ['Fri', 'Friday'],
  ['Sat', 'Saturday'],
  ['Sun', 'Sunday'],
] as const;

/** The month as Monday-first weeks, padded with nulls. */
export function calendarWeeks(days: CalendarDay[]): (CalendarDay | null)[][] {
  if (days.length === 0) return [];
  const lead = (at(days[0]!.day).getUTCDay() + 6) % 7;
  const cells: (CalendarDay | null)[] = [...Array<null>(lead).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  const out: (CalendarDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
  return out;
}

/** Tint steps, literal classes for the Tailwind scanner. 0 = no revenue (or none recorded). */
const HEAT = ['', 'bg-brand/8', 'bg-brand/16', 'bg-brand/26', 'bg-brand/40'] as const;

/** 1–4 against the month's best day; 0 for nothing, a loss, or no history. */
export function heatStep(net: number | null, max: number): number {
  if (net === null || net <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((net / max) * 4)));
}

const ARROWS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

// ---------- pieces ----------

function DayCell(props: {
  d: CalendarDay;
  today: string;
  currency: string;
  max: number;
  selected: boolean;
  href: string;
  onPick: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { d, currency: cur } = props;
  const n = Number(d.day.slice(8));
  const isToday = d.day === props.today;
  const box = 'flex h-11 flex-col justify-between rounded-md p-1.5 text-caption tabular-nums sm:h-16 sm:p-2';
  const number = (
    <span
      className={cn(
        'self-start',
        isToday && '-mt-0.5 -ml-0.5 inline-flex size-5 items-center justify-center rounded-full bg-foreground font-semibold text-background',
      )}
    >
      {n}
    </span>
  );

  if (d.day > props.today) {
    return <span className={cn(box, 'text-faint')}>{number}</span>;
  }

  const spoken =
    d.net === null ? 'no revenue history' : d.net === 0 ? 'no revenue' : `${formatMoney(d.net, cur)} net revenue`;
  return (
    <a
      href={props.href}
      data-day={d.day}
      onClick={props.onPick}
      aria-current={props.selected ? 'true' : undefined}
      aria-label={`${longDay(d.day)}${isToday ? ', today' : ''}: ${spoken}`}
      className={cn(
        box,
        HEAT[heatStep(d.net, props.max)],
        'focus-inset transition-[box-shadow,scale] duration-150 ease-out motion-safe:active:scale-[0.97]',
        props.selected ? 'ring-2 ring-foreground ring-inset' : 'hover:ring-1 hover:ring-input hover:ring-inset',
        d.net === null ? 'text-muted-foreground' : 'text-foreground',
      )}
    >
      {number}
      {d.net !== null ? (
        <span
          aria-hidden="true"
          className={cn(
            'hidden truncate font-medium sm:block',
            d.net === 0 && 'font-normal text-muted-foreground',
            d.net < 0 && 'text-destructive-foreground',
          )}
        >
          {cellAmount(d.net, cur)}
        </span>
      ) : null}
    </a>
  );
}

/** A change from the day before: arrow, spoken word and unsigned figure, like DeltaBadge. */
function Change(props: { value: number | null; format: (n: number) => string; since: string; neutral?: boolean }) {
  const v = props.value;
  if (v === null) return null;
  if (v === 0) return <span className="text-muted-foreground">No change</span>;
  const up = v > 0;
  return (
    <span
      title={`vs. ${props.since}`}
      className={cn(
        'inline-flex items-center gap-0.5 font-semibold whitespace-nowrap tabular-nums',
        props.neutral ? 'text-foreground' : up ? 'text-success-foreground' : 'text-destructive-foreground',
      )}
    >
      {up ? <ArrowUp className="size-3.5 shrink-0" strokeWidth={2.5} /> : <ArrowDown className="size-3.5 shrink-0" strokeWidth={2.5} />}
      <span className="sr-only">{up ? 'Up' : 'Down'} </span>
      {props.format(Math.abs(v))}
      <span className="sr-only"> from {props.since}</span>
    </span>
  );
}

function Figure(props: { label: string; value: ReactNode; change?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="flex flex-wrap items-baseline justify-end gap-x-2 text-right tabular-nums">
        <span>{props.value}</span>
        {props.change}
      </dd>
    </div>
  );
}

/** "$1,300.00 from 14 charges, $65.44 refunded (2 refunds)." */
export function revenueLine(d: CalendarDay, cur: string): string {
  const money = (n: number) => formatMoney(n, cur);
  const parts: string[] = [];
  if (d.gross > 0) parts.push(d.charges > 0 ? `${money(d.gross)} from ${plural(d.charges, 'charge')}` : `${money(d.gross)} in charges`);
  if (d.refunds > 0) {
    parts.push(d.refundCount > 0 ? `${money(d.refunds)} refunded (${plural(d.refundCount, 'refund')})` : `${money(d.refunds)} refunded`);
  }
  return parts.length > 0 ? `${parts.join(', ')}.` : 'No charges or refunds.';
}

function DayDetail(props: {
  d: CalendarDay;
  cal: CalendarMonth;
  connections: ConnectionSummary[];
  backHref: string;
  onBack: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { d, cal } = props;
  const cur = cal.currency;
  const isToday = d.day === cal.today;
  const since = shortDay(addDays(d.day, -1));
  const byId = new Map(props.connections.map((c) => [c.id, c]));
  const rows = Object.entries(d.byConnection)
    .map(([id, net]) => ({ id, net, c: byId.get(id) }))
    .sort((a, b) => b.net - a.net);
  const listed = d.charges + d.refundCount;

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <h3 id="calendar-day" className="font-semibold">
          {longDay(d.day)}
        </h3>
        <CossButton
          render={<a href={props.backHref} onClick={props.onBack} aria-label={`Close ${shortDay(d.day)}, back to ${MONTH.format(at(d.day))}`} />}
          variant="ghost"
          size="icon-xs"
          className="-mt-0.5 -mr-1 text-muted-foreground"
        >
          <X />
        </CossButton>
      </div>
      {isToday ? (
        <p className="mt-1">
          <Badge variant="outline">Today so far</Badge>
        </p>
      ) : null}

      {d.net === null ? (
        <p className="mt-3 text-muted-foreground">
          {cal.revenueFrom
            ? `No revenue history for this day. It starts on ${fullDay(cal.revenueFrom)}.`
            : 'No revenue history yet. It shows up after the first sync.'}
        </p>
      ) : (
        <>
          <p className="mt-3 text-muted-foreground">Net revenue</p>
          <p className={cn('text-title tabular-nums wrap-anywhere', d.net < 0 && 'text-destructive-foreground')}>
            {formatMoney(d.net, cur)}
          </p>
          <p className="mt-1 text-muted-foreground">{revenueLine(d, cur)}</p>
          {rows.length > 0 && props.connections.length > 1 ? (
            <ul className="mt-3 space-y-1.5" aria-label="By connection">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    {r.c ? <ProviderDot dotClass={r.c.dotClass} /> : null}
                    <span className="truncate">{r.c?.name ?? 'Removed connection'}</span>
                  </span>
                  <span className={cn('tabular-nums', r.net < 0 && 'text-destructive-foreground')}>{formatMoney(r.net, cur)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}

      <dl className="mt-4 space-y-2 border-t pt-4">
        {d.mrr === null ? (
          <p className="text-muted-foreground">
            {cal.mrrFrom && cal.mrrFrom > d.day
              ? `MRR history starts on ${fullDay(cal.mrrFrom)}.`
              : 'No MRR recorded for this day.'}
          </p>
        ) : (
          <>
            <Figure
              label={isToday ? 'MRR now' : 'MRR at day end'}
              value={formatMoney(d.mrr, cur, { whole: true })}
              change={<Change value={d.mrrChange} since={since} format={(n) => formatMoney(n, cur, { whole: true })} />}
            />
            <Figure
              label="Subscriptions"
              value={formatNumber(d.activeSubscriptions ?? 0)}
              change={<Change value={d.subscriptionsChange} since={since} format={formatNumber} />}
            />
            {d.activeTrials !== null ? (
              <Figure
                label="Trials"
                value={formatNumber(d.activeTrials)}
                change={<Change value={d.trialsChange} since={since} format={formatNumber} neutral />}
              />
            ) : null}
          </>
        )}
      </dl>

      {listed > 0 ? (
        <p className="mt-4">
          <TextLink href={`/transactions?provider=all&day=${d.day}`}>
            See {listed === 1 ? 'the transaction' : `the ${formatNumber(listed)} transactions`}
          </TextLink>
        </p>
      ) : null}
    </div>
  );
}

function MonthSummary(props: {
  cal: CalendarMonth;
  dayHref: (day: string) => string;
  onPick: (day: string) => (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { cal } = props;
  const cur = cal.currency;
  const known = cal.days.filter((d) => d.net !== null);
  const total = known.reduce((s, d) => s + (d.net ?? 0), 0);
  const refunds = known.reduce((s, d) => s + d.refunds, 0);
  const best = known.reduce<CalendarDay | null>((b, d) => ((d.net ?? 0) > 0 && (!b || (d.net ?? 0) > (b.net ?? 0)) ? d : b), null);
  const current = cal.month === cal.today.slice(0, 7);
  const name = MONTH.format(at(`${cal.month}-01`));
  const partial = cal.revenueFrom !== null && cal.revenueFrom > `${cal.month}-01` && known.length > 0;

  return (
    <div>
      <h3 id="calendar-day" className="font-semibold">
        {current ? `${name} so far` : `In ${name}`}
      </h3>
      {known.length === 0 ? (
        <p className="mt-1 text-muted-foreground">
          {cal.revenueFrom && cal.revenueFrom > cal.today
            ? 'No revenue history yet.'
            : cal.revenueFrom
              ? `No revenue history this far back. It starts on ${fullDay(cal.revenueFrom)}.`
              : 'No revenue history yet. It shows up after the first sync.'}
        </p>
      ) : (
        <>
          <p className="mt-3 text-muted-foreground">Net revenue{partial ? ` since ${shortDay(cal.revenueFrom!)}` : ''}</p>
          <p className={cn('text-title tabular-nums wrap-anywhere', total < 0 && 'text-destructive-foreground')}>
            {formatMoney(total, cur, { whole: true })}
          </p>
          {refunds > 0 ? <p className="mt-1 text-muted-foreground">{formatMoney(refunds, cur, { whole: true })} refunded.</p> : null}
          {best ? (
            <p className="mt-3">
              Best day:{' '}
              <TextLink href={props.dayHref(best.day)} onClick={props.onPick(best.day)}>
                {shortDay(best.day)}
              </TextLink>
              , {formatMoney(best.net!, cur, { whole: true })}
            </p>
          ) : null}
        </>
      )}
      <p className="mt-4 text-muted-foreground">Pick a day to see what happened.</p>
    </div>
  );
}

// ---------- the card ----------

export interface CalendarCardProps {
  calendar: CalendarMonth;
  /** To name and dot the connections in a day's breakdown. */
  connections: ConnectionSummary[];
  /** The day the server rendered open (?day=), or null for the month summary. */
  selected?: string | null;
  /** Month and day links; defaults to "/dashboard". */
  basePath?: string;
  /** Lines under the card (providers missing from it). */
  notes?: ReactNode;
  className?: string;
}

export function CalendarCard(props: CalendarCardProps) {
  const cal = props.calendar;
  const cur = cal.currency;
  const base = props.basePath ?? '/dashboard';
  const valid = (d: string | null | undefined) => (d && d <= cal.today && cal.days.some((x) => x.day === d) ? d : null);
  const [selected, setSelected] = useState<string | null>(valid(props.selected));
  const [announce, setAnnounce] = useState('');
  const grid = useRef<HTMLTableElement>(null);

  const monthHref = (m: string) => `${base}?month=${m}#calendar`;
  const dayHref = (d: string) => `${base}?day=${d}#calendar`;
  const max = Math.max(0, ...cal.days.map((d) => d.net ?? 0));
  const day = selected ? (cal.days.find((d) => d.day === selected) ?? null) : null;

  /** After hydration: pick in place, keep the URL in step, and keep focus on a day. */
  const pick = (next: string | null, focusDay?: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    setSelected(next);
    window.history.replaceState(window.history.state, '', next ? dayHref(next) : monthHref(cal.month));
    setAnnounce(next ? `Showing ${longDay(next)}.` : `Showing ${monthLabel(cal.month)}.`);
    // The link that was clicked may be gone after the swap: put focus on the day instead.
    const target = focusDay ?? next;
    if (target) requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(`a[data-day="${target}"]`)?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>) => {
    const step = ARROWS[e.key];
    const from = (e.target as HTMLElement).closest<HTMLElement>('a[data-day]')?.dataset['day'];
    if (!step || !from) return;
    const to = e.currentTarget.querySelector<HTMLElement>(`a[data-day="${addDays(from, step)}"]`);
    if (!to) return;
    e.preventDefault();
    to.focus();
  };

  const label = monthLabel(cal.month);
  const nav = 'text-muted-foreground';
  return (
    <Card
      id="calendar"
      title="Calendar"
      description="Net revenue per day (UTC). Pick a day to see what happened."
      className={props.className}
    >
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_17rem] md:gap-8">
        <div className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="font-semibold">{label}</h3>
            <nav aria-label="Month" className="flex items-center gap-1">
              {cal.prevMonth ? (
                <CossButton
                  render={<a href={monthHref(cal.prevMonth)} aria-label={`Previous month, ${monthLabel(cal.prevMonth)}`} />}
                  variant="ghost"
                  size="icon-sm"
                  className={nav}
                >
                  <ChevronLeft />
                </CossButton>
              ) : null}
              {cal.nextMonth ? (
                <CossButton
                  render={<a href={monthHref(cal.nextMonth)} aria-label={`Next month, ${monthLabel(cal.nextMonth)}`} />}
                  variant="ghost"
                  size="icon-sm"
                  className={nav}
                >
                  <ChevronRight />
                </CossButton>
              ) : null}
            </nav>
          </div>

          <table ref={grid} onKeyDown={onKeyDown} className="w-full table-fixed border-separate border-spacing-0.5">
            <caption className="sr-only">
              {label}: net revenue per day in {cur}. Arrow keys move between days.
            </caption>
            <thead>
              <tr>
                {WEEKDAYS.map(([short, long]) => (
                  <th key={short} scope="col" abbr={long} className="pb-1 text-left text-caption font-normal text-muted-foreground">
                    <span className="px-1.5 sm:px-2">{short}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {calendarWeeks(cal.days).map((week, i) => (
                <tr key={i}>
                  {week.map((d, j) => (
                    <td key={d?.day ?? `pad-${i}-${j}`} className="p-0">
                      {d ? (
                        <DayCell
                          d={d}
                          today={cal.today}
                          currency={cur}
                          max={max}
                          selected={d.day === selected}
                          href={dayHref(d.day)}
                          onPick={pick(d.day)}
                        />
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {/* The key for the tint: no revenue, then the four steps. */}
          <div aria-hidden="true" className="mt-3 flex items-center justify-end gap-1.5 text-caption text-muted-foreground">
            <span className="mr-0.5">Less</span>
            <span className="size-3 rounded-[3px] border" />
            {HEAT.slice(1).map((cls) => (
              <span key={cls} className={cn('size-3 rounded-[3px]', cls)} />
            ))}
            <span className="ml-0.5">More</span>
          </div>
        </div>

        <section
          aria-labelledby="calendar-day"
          className="min-w-0 border-t pt-5 md:border-t-0 md:border-l md:pt-0 md:pl-8"
        >
          {day ? (
            <DayDetail
              d={day}
              cal={cal}
              connections={props.connections}
              backHref={monthHref(cal.month)}
              onBack={pick(null, day.day)}
            />
          ) : (
            <MonthSummary cal={cal} dayHref={dayHref} onPick={(d) => pick(d)} />
          )}
          <p role="status" className="sr-only">
            {announce}
          </p>
        </section>
      </div>
      {props.notes}
    </Card>
  );
}
