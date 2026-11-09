/**
 * Paints a share image on a canvas (SPEC F-21), from layout.ts's numbers. Owner: Experience (design).
 *
 * Browser only, run from effects, never while rendering. Text is the page's Geist (the caller waits
 * for it to load) and owner text is drawn as text, never parsed. The logo is a same-origin image
 * (/media/…), so the canvas stays clean and can be saved as a PNG.
 */

import {
  calendarGrid,
  calendarLayout,
  CARD_THEMES,
  cardSize,
  chartGeometry,
  chartSeries,
  fitText,
  FOOTER_H,
  headline,
  initials,
  PAD,
  type CardData,
  type CardSpec,
  type CardTheme,
} from './layout';

const FAMILY = 'Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const font = (weight: number, size: number) => `${weight} ${size}px ${FAMILY}`;

export interface DrawInput {
  spec: CardSpec;
  data: CardData;
  theme: CardTheme;
  /** The chart line's or the calendar's colour, as hex for this theme. */
  color: string;
  logo: CanvasImageSource | null;
}

type Palette = (typeof CARD_THEMES)[CardTheme];

/** "#0864cd" at `a` opacity. */
function alpha(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Draws the card at its CSS size; the caller scales the context for the pixel ratio. */
export function drawCard(ctx: CanvasRenderingContext2D, input: DrawInput): void {
  const { spec, data } = input;
  const p = CARD_THEMES[input.theme];
  const { w, h } = cardSize(spec);
  ctx.clearRect(0, 0, w, h);

  // The card: rounded, hairline edge, transparent outside the corners.
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, w - 1, h - 1, 20);
  ctx.fillStyle = p.bg;
  ctx.fill();
  ctx.strokeStyle = p.border;
  ctx.lineWidth = 1;
  ctx.stroke();

  if (spec.kind === 'figure') drawFigure(ctx, input, p, w);
  else if (spec.kind === 'chart') drawChart(ctx, input, p, w, h);
  else drawCalendar(ctx, input, p, w);
  drawFooter(ctx, data, p, w, h);
}

function drawFigure(ctx: CanvasRenderingContext2D, input: DrawInput, p: Palette, w: number) {
  const { data, spec } = input;
  drawLogo(ctx, input, p, PAD, PAD, 44);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = font(600, 18);
  ctx.fillStyle = p.fg;
  ctx.fillText(fitText(data.name, w - PAD * 2 - 58, (s) => ctx.measureText(s).width), PAD + 58, PAD + 22);

  const head = headline(spec, data);
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(500, 13);
  ctx.fillStyle = p.muted;
  ctx.fillText(head.caption.toUpperCase(), PAD, PAD + 44 + 34);
  ctx.font = font(600, 50);
  ctx.fillStyle = p.fg;
  ctx.fillText(fitText(head.value, w - PAD * 2, (s) => ctx.measureText(s).width), PAD, PAD + 44 + 34 + 56);
}

/** The amount and its words on the left, the product on the right: the chart's and the calendar's top. */
function drawHeader(ctx: CanvasRenderingContext2D, input: DrawInput, p: Palette, w: number) {
  const { data, spec } = input;
  const head = headline(spec, data);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(600, 32);
  ctx.fillStyle = p.fg;
  ctx.fillText(head.value, PAD, PAD + 30);
  const valueW = ctx.measureText(head.value).width;
  ctx.font = font(400, 13);
  ctx.fillStyle = p.muted;
  ctx.fillText(head.caption, PAD, PAD + 52);

  // The product, right-aligned: its name, the logo before it.
  ctx.font = font(600, 15);
  const room = Math.max(60, w - PAD * 2 - valueW - 24 - 36);
  const name = fitText(data.name, room, (s) => ctx.measureText(s).width);
  const nameW = ctx.measureText(name).width;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = p.fg;
  ctx.fillText(name, w - PAD, PAD + 14);
  drawLogo(ctx, input, p, w - PAD - nameW - 36, PAD, 28);
}

function drawChart(ctx: CanvasRenderingContext2D, input: DrawInput, p: Palette, w: number, h: number) {
  drawHeader(ctx, input, p, w);
  const spec = input.spec as Extract<CardSpec, { kind: 'chart' }>;
  const series = chartSeries(spec.period, input.data);
  const box = { x: PAD + 44, y: PAD + 84, w: w - PAD * 2 - 52, h: h - PAD - 84 - FOOTER_H - 34 };
  const g = chartGeometry(series, box);

  ctx.font = font(400, 11);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  for (const t of g.ticks) {
    ctx.strokeStyle = p.border;
    ctx.beginPath();
    ctx.moveTo(box.x, Math.round(t.y) + 0.5);
    ctx.lineTo(box.x + box.w, Math.round(t.y) + 0.5);
    ctx.stroke();
    ctx.fillStyle = p.faint;
    ctx.fillText(t.label, box.x - 10, t.y);
  }

  if (g.points.length > 0) {
    const line = new Path2D();
    g.points.forEach((pt, i) => (i === 0 ? line.moveTo(pt.x, pt.y) : line.lineTo(pt.x, pt.y)));
    const area = new Path2D(line);
    area.lineTo(g.points.at(-1)!.x, g.base);
    area.lineTo(g.points[0]!.x, g.base);
    area.closePath();
    const fill = ctx.createLinearGradient(0, box.y, 0, box.y + box.h);
    fill.addColorStop(0, alpha(input.color, input.theme === 'dark' ? 0.32 : 0.22));
    fill.addColorStop(1, alpha(input.color, 0));
    ctx.fillStyle = fill;
    ctx.fill(area);
    ctx.strokeStyle = input.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(line);
  }

  ctx.font = font(400, 11);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = p.faint;
  for (const l of g.xLabels) {
    ctx.textAlign = l.align;
    ctx.fillText(l.label, l.x, box.y + box.h + 22);
  }
}

const WEEKDAY_LABELS: Array<[number, string]> = [
  [0, 'Mon'],
  [2, 'Wed'],
  [4, 'Fri'],
];

function drawCalendar(ctx: CanvasRenderingContext2D, input: DrawInput, p: Palette, w: number) {
  drawHeader(ctx, input, p, w);
  const spec = input.spec as Extract<CardSpec, { kind: 'calendar' }>;
  const grid = calendarGrid(input.data.daily, input.data.today, spec.period);
  const l = calendarLayout(spec.period);
  const step = l.cell + l.gap;
  const radius = Math.max(2, Math.round(l.cell * 0.25));
  const fills = [p.empty, alpha(input.color, 0.3), alpha(input.color, 0.55), alpha(input.color, 0.78), input.color];

  ctx.font = font(400, 11);
  ctx.fillStyle = p.faint;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const m of grid.months) ctx.fillText(m.label, l.left + m.col * step, l.top - 8);
  ctx.textBaseline = 'middle';
  for (const [row, label] of WEEKDAY_LABELS) ctx.fillText(label, PAD, l.top + row * step + l.cell / 2);

  for (const c of grid.cells) {
    if (c.outside) continue;
    ctx.beginPath();
    ctx.roundRect(l.left + c.col * step, l.top + c.row * step, l.cell, l.cell, radius);
    ctx.fillStyle = fills[c.level]!;
    ctx.fill();
  }

  // The key: Less, the five steps, More.
  const keyY = l.top + 7 * step - l.gap + 22;
  const keyCell = 11;
  ctx.font = font(400, 11);
  ctx.fillStyle = p.faint;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('Less', l.left, keyY);
  let x = l.left + ctx.measureText('Less').width + 8;
  for (const f of fills) {
    ctx.beginPath();
    ctx.roundRect(x, keyY - keyCell / 2, keyCell, keyCell, 3);
    ctx.fillStyle = f;
    ctx.fill();
    x += keyCell + 3;
  }
  ctx.fillStyle = p.faint;
  ctx.fillText('More', x + 5, keyY);
}

function drawLogo(ctx: CanvasRenderingContext2D, input: DrawInput, p: Palette, x: number, y: number, size: number) {
  const r = Math.round(size * 0.24);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, r);
  ctx.clip();
  if (input.logo) {
    ctx.fillStyle = p.empty;
    ctx.fillRect(x, y, size, size);
    ctx.drawImage(input.logo, x, y, size, size);
  } else {
    ctx.fillStyle = alpha(p.brand, 0.12);
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = p.brand;
    ctx.font = font(600, Math.round(size * 0.4));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials(input.data.name), x + size / 2, y + size / 2 + 1);
  }
  ctx.restore();
  // A hairline over the edge, so a white logo still reads as a tile on a white card.
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, size - 1, size - 1, r);
  ctx.strokeStyle = alpha(p.fg, 0.1);
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** hoomuch's rings (views/components/icons.tsx RingsMark), on its 32-unit grid. */
function drawRings(ctx: CanvasRenderingContext2D, p: Palette, x: number, y: number, size: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 32, size / 32);
  ctx.lineWidth = 3;
  const circle = (cx: number, color: string) => {
    ctx.beginPath();
    ctx.arc(cx, 16, 7, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.stroke();
  };
  const arc = (d: string, color: string, width: number) => {
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke(new Path2D(d));
  };
  circle(12.5, p.fg);
  circle(19.5, p.brand);
  arc('M19.5 16A7 7 0 0 1 9 22.06', p.bg, 5);
  arc('M19.47 15.39A7 7 0 0 1 8.49 21.73', p.fg, 3);
  arc('M12.5 16A7 7 0 0 1 23 9.94', p.bg, 5);
  arc('M12.53 16.61A7 7 0 0 1 23.52 10.27', p.brand, 3);
  ctx.restore();
}

/** Who checked it and where the page is: the line that brings the next visitor. */
function drawFooter(ctx: CanvasRenderingContext2D, data: CardData, p: Palette, w: number, h: number) {
  const top = h - FOOTER_H;
  ctx.strokeStyle = p.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, Math.round(top) + 0.5);
  ctx.lineTo(w - PAD, Math.round(top) + 0.5);
  ctx.stroke();
  const mid = top + FOOTER_H / 2;
  drawRings(ctx, p, PAD - 3, mid - 11, 22);
  ctx.font = font(500, 12);
  ctx.fillStyle = p.muted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('Verified by hoomuch', PAD + 23, mid);
  const used = PAD + 23 + ctx.measureText('Verified by hoomuch').width + 16;
  ctx.font = font(400, 12);
  ctx.fillStyle = p.faint;
  ctx.textAlign = 'right';
  ctx.fillText(fitText(`${data.host}/p/${data.slug}`, w - PAD - used, (s) => ctx.measureText(s).width), w - PAD, mid);
}
