/**
 * Share images (SPEC F-21): a product's figure, its revenue chart or its revenue calendar as a
 * picture to post, in a light or dark theme and a colour of the owner's or visitor's choosing,
 * downloaded as a PNG or copied. Owner: Experience (design).
 *
 * Works only once hydrated: the picture is drawn on a canvas (draw.ts) in an effect. Before that
 * the controls are disabled. A card that needs the history behind the lock (the year's chart, the
 * calendar) shows `lockedPanel` in its place for a visitor without an account, and picking one
 * asks the page to open it (`onLocked`).
 */

import { Check, Copy, Download, Lock } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button as CossButton } from '@/components/ui/button';
import { cn } from '../../../lib/utils';
import { SegmentedChoice } from '../ui';
import { drawCard } from './draw';
import {
  CARD_COLORS,
  cardSize,
  cardSummary,
  fileName,
  type CalendarPeriod,
  type CardData,
  type CardKind,
  type CardSpec,
  type CardTheme,
  type ChartPeriod,
  type FigureChoice,
} from './layout';

/** How much sharper than CSS pixels the image is drawn (a download is this many times wider). */
const SCALE = 2;
const COPIED_MS = 2000;

/** The preview's widest, the card's own width: whole literal classes for the CSS build. */
const PREVIEW_WIDTH: Record<CardKind, string> = { figure: 'max-w-[520px]', chart: 'max-w-[640px]', calendar: 'max-w-[720px]' };

const FAMILY = 'Geist';

/** The logo as a drawable image (same origin, so the canvas stays clean); null when it won't load. */
async function loadImage(url: string | null): Promise<HTMLImageElement | null> {
  if (!url) return null;
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

/** The canvas as a PNG. */
function pngOf(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No image'))), 'image/png'));
}

const withLock = (label: string, locked: boolean): ReactNode =>
  locked ? (
    <span className="inline-flex items-center gap-1">
      {label}
      <Lock aria-label="needs a free account" className="size-3 shrink-0 opacity-70" />
    </span>
  ) : (
    label
  );

export function ShareCards(props: {
  data: CardData;
  /** Whether a card needs what the viewer can't open yet; nothing is locked when absent (the owner). */
  locked?: (spec: CardSpec) => boolean;
  /** A locked card was picked: try to open it (load the history, or explain how). */
  onLocked?: (spec: CardSpec) => void;
  /** Shown in place of a locked card's preview. */
  lockedPanel?: ReactNode;
  initialKind?: CardKind;
}) {
  const [kind, setKind] = useState<CardKind>(props.initialKind ?? 'figure');
  const [theme, setTheme] = useState<CardTheme>('light');
  const [figure, setFigure] = useState<FigureChoice>('mrr');
  const [chartPeriod, setChartPeriod] = useState<ChartPeriod>('30d');
  const [calendarPeriod, setCalendarPeriod] = useState<CalendarPeriod>('12m');
  const [colorId, setColorId] = useState(CARD_COLORS[0]!.id);
  const [mounted, setMounted] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [copied, setCopied] = useState(false);
  const [canCopy, setCanCopy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const logo = useRef<{ url: string | null; img: Promise<HTMLImageElement | null> } | null>(null);

  const specOf = (k: CardKind, f = figure, cp = chartPeriod, kp = calendarPeriod): CardSpec =>
    k === 'figure' ? { kind: 'figure', figure: f } : k === 'chart' ? { kind: 'chart', period: cp } : { kind: 'calendar', period: kp };
  const spec = specOf(kind);
  const isLocked = (s: CardSpec) => props.locked?.(s) ?? false;
  const locked = isLocked(spec);
  const color = CARD_COLORS.find((c) => c.id === colorId) ?? CARD_COLORS[0]!;
  const size = cardSize(spec);
  const key = JSON.stringify(spec);

  /** Every choice goes through here: a locked one asks the page to open it. */
  const pick = (next: CardSpec) => {
    if (isLocked(next)) props.onLocked?.(next);
  };

  useEffect(() => {
    setMounted(true);
    setCanCopy(typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function');
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (locked) return;
    let cancelled = false;
    setDrawn(false);
    if (logo.current?.url !== props.data.logo) logo.current = { url: props.data.logo, img: loadImage(props.data.logo) };
    const fonts = document.fonts ? Promise.all([400, 500, 600].map((w) => document.fonts.load(`${w} 16px ${FAMILY}`))) : Promise.resolve();
    void Promise.all([fonts.catch(() => undefined), logo.current.img]).then(([, img]) => {
      const el = canvas.current;
      const ctx = el?.getContext('2d');
      if (cancelled || !el || !ctx) return;
      ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
      drawCard(ctx, { spec, data: props.data, theme, color: theme === 'dark' ? color.dark : color.light, logo: img });
      setDrawn(true);
    });
    return () => {
      cancelled = true;
    };
    // `key` stands for `spec`, which is a new object on every render.
  }, [key, theme, color, props.data, locked]);

  const download = async () => {
    if (!canvas.current) return;
    const url = URL.createObjectURL(await pngOf(canvas.current));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName(spec, props.data.slug);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copy = async () => {
    if (!canvas.current) return;
    const el = canvas.current;
    // Safari wants the item made inside the click, with the image still to come.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngOf(el) })]);
    setCopied(true);
  };

  const ready = mounted && drawn && !locked;
  return (
    <div className="grid min-w-0 gap-4">
      <SegmentedChoice
        label="Image"
        value={kind}
        className="w-full"
        options={[
          { value: 'figure', label: 'Figure' },
          { value: 'chart', label: 'Revenue chart' },
          // Locked whatever its period: the calendar always reaches past the open 30 days.
          { value: 'calendar', label: withLock('Calendar', isLocked({ kind: 'calendar', period: '3m' })) },
        ]}
        onChange={(k) => {
          setKind(k);
          pick(specOf(k));
        }}
      />
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Choice label="Theme">
          <SegmentedChoice
            label="Theme"
            value={theme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            onChange={setTheme}
          />
        </Choice>
        {kind === 'figure' ? (
          <Choice label="Figure">
            <SegmentedChoice
              label="Figure"
              value={figure}
              options={[
                { value: 'mrr', label: 'MRR' },
                { value: 'revenue', label: 'Revenue, 30 days' },
                { value: 'total', label: 'Total revenue' },
              ]}
              onChange={setFigure}
            />
          </Choice>
        ) : kind === 'chart' ? (
          <Choice label="Period">
            <SegmentedChoice
              label="Period"
              value={chartPeriod}
              options={(['7d', '30d', '1y'] as const).map((p) => ({
                value: p,
                label: withLock(p === '7d' ? '7 days' : p === '30d' ? '30 days' : '12 months', isLocked({ kind: 'chart', period: p })),
              }))}
              onChange={(p) => {
                setChartPeriod(p);
                pick({ kind: 'chart', period: p });
              }}
            />
          </Choice>
        ) : (
          <Choice label="Period">
            <SegmentedChoice
              label="Period"
              value={calendarPeriod}
              options={(['3m', '6m', '12m'] as const).map((p) => ({ value: p, label: p === '3m' ? '3 months' : p === '6m' ? '6 months' : '12 months' }))}
              onChange={(p) => {
                setCalendarPeriod(p);
                pick({ kind: 'calendar', period: p });
              }}
            />
          </Choice>
        )}
      </div>
      {kind === 'figure' ? null : (
        <Choice label="Colour" note={color.name}>
          <div role="group" aria-label="Colour" className="flex flex-wrap gap-1.5">
            {CARD_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={c.id === colorId}
                aria-label={c.name}
                title={c.name}
                onClick={() => setColorId(c.id)}
                className={cn(
                  'flex size-8 items-center justify-center rounded-full border transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/24 focus-visible:outline-none',
                  c.id === colorId ? 'border-foreground' : 'border-transparent',
                )}
              >
                <span aria-hidden="true" className={cn('size-5 rounded-full', theme === 'dark' ? c.swatch.dark : c.swatch.light)} />
              </button>
            ))}
          </div>
        </Choice>
      )}

      <div className={cn('flex min-h-48 items-center justify-center rounded-xl border p-3 sm:p-6', theme === 'dark' ? 'bg-[#0b0c0e]' : 'bg-muted/60')}>
        {locked ? (
          props.lockedPanel
        ) : (
          <canvas
            ref={canvas}
            width={size.w * SCALE}
            height={size.h * SCALE}
            role="img"
            aria-label={cardSummary(spec, props.data)}
            className={cn('h-auto w-full', PREVIEW_WIDTH[kind])}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {canCopy ? (
          <CossButton type="button" variant="outline" disabled={!ready} onClick={() => void copy().catch(() => undefined)}>
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy image'}
          </CossButton>
        ) : null}
        <CossButton type="button" disabled={!ready} onClick={() => void download()}>
          <Download />
          Download PNG
        </CossButton>
      </div>
    </div>
  );
}

function Choice(props: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <p className="flex items-baseline justify-between gap-4 text-caption font-medium text-muted-foreground">
        <span>{props.label}</span>
        {props.note ? <span className="font-normal">{props.note}</span> : null}
      </p>
      {props.children}
    </div>
  );
}
