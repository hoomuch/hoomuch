/**
 * Choosing a photo or logo: with a button, or by dragging an image onto the card or field.
 * Owner: Experience (design).
 *
 * ImageUploadCard is a card that sends its image on its own (routes/media.tsx): the profile's photo,
 * a product's logo on its Edit page.
 *
 * Before hydration it's a plain file input and an Upload button, multipart, so it works without
 * JavaScript. Once hydrated the input hides behind a button, the whole card takes a dropped image,
 * and either way the image is scaled down in the browser first (a square of UPLOAD_SIDE, cropped to
 * the middle, as WebP where the browser writes it). Nothing is shown from the file before it's
 * sent: the CSP allows no blob: images. The server checks whatever arrives either way.
 */

import { ImageUp } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Button as CossButton } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { UPLOAD_SIDE } from '../../lib/media';
import { Button } from './ui';

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const NOT_AN_IMAGE = 'That isn’t an image. Use a PNG, JPEG, WebP or GIF.';

/** The image drawn as a centred square at most UPLOAD_SIDE across, or into `onto` at its size. */
async function draw(file: File, onto?: HTMLCanvasElement): Promise<HTMLCanvasElement | null> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = onto ?? document.createElement('canvas');
  const out = onto ? canvas.width : Math.min(side, UPLOAD_SIDE);
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  bitmap.close();
  return canvas;
}

/** The file scaled down for upload; null when the browser can't draw it (the original goes then). */
async function shrink(file: File): Promise<File | null> {
  const canvas = await draw(file);
  if (!canvas) return null;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  if (!blob) return null;
  // A browser that can't write WebP hands back PNG, which is fine too.
  const webp = blob.type === 'image/webp';
  return new File([blob], webp ? 'image.webp' : 'image.png', { type: webp ? 'image/webp' : 'image/png' });
}

/** Puts `file` (scaled down where the browser can) in the file input, as if it had been picked. */
async function place(input: HTMLInputElement, file: File): Promise<void> {
  let chosen = file;
  try {
    chosen = (await shrink(file)) ?? file;
  } catch {
    // Not something this browser can draw: send it as it is, and the server says what's wrong.
  }
  const picked = new DataTransfer();
  picked.items.add(chosen);
  input.files = picked.files;
}

/** Hydrated, and the browser can scale an image and set a file input. */
function useEnhanced(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(typeof createImageBitmap === 'function' && typeof DataTransfer === 'function'), []);
  return ready;
}

/** The drag handlers for a drop target, and whether an image is being dragged over it. */
function useDrop(enabled: boolean, onFile: (file: File) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  if (!enabled) return { over: false, handlers: {} };
  return {
    over,
    handlers: {
      onDragEnter: (e: DragEvent) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (e: DragEvent) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      },
      // Children fire their own enter and leave: only leaving the target itself counts.
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
      },
    },
  };
}

/** The outline and note over a target while an image is dragged onto it. */
function DropOverlay(props: { show: boolean; label: string }) {
  return props.show ? (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-brand/70 bg-background/85 text-body font-medium text-foreground"
    >
      {props.label}
    </span>
  ) : null;
}

/** "or drop one here": only where there's a pointer to drag with. */
function DropHint(props: { show: boolean }) {
  return props.show ? <span className="hidden text-caption text-muted-foreground pointer-fine:inline">or drop one here</span> : null;
}

function isImage(file: File): boolean {
  return /^image\/(png|jpeg|webp|gif)$/.test(file.type);
}

// ---------- a card that sends its own image ----------

export function ImageUploadCard(props: {
  id: string;
  /** Where the image is posted (multipart), and under which field name. */
  action: string;
  field: string;
  /** The button, e.g. "Change photo". */
  label: string;
  /** The photo or logo as it is now. */
  preview: ReactNode;
  title: string;
  description: ReactNode;
  /** More actions beside the button (their own forms): Remove, Use your website's icon. */
  extra?: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const ready = useEnhanced();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Back from the page this one posted to (the browser's back button): the button works again.
  useEffect(() => {
    const reset = () => setBusy(false);
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  const send = async (file: File) => {
    if (!input.current || !form.current) return;
    if (!isImage(file)) {
      setError(NOT_AN_IMAGE);
      return;
    }
    setError(null);
    setBusy(true);
    await place(input.current, file);
    form.current.requestSubmit();
  };
  const drop = useDrop(ready && !busy, (file) => void send(file));

  return (
    <div className="relative flex flex-wrap items-center gap-x-5 gap-y-4" {...drop.handlers}>
      <DropOverlay show={drop.over} label="Drop to upload" />
      {props.preview}
      <div className="grid min-w-0 flex-1 basis-56 gap-3">
        <div>
          <h2 className="font-heading text-base">{props.title}</h2>
          <p className="text-body text-pretty text-muted-foreground">{props.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form ref={form} method="post" action={props.action} encType="multipart/form-data" className="flex flex-wrap items-center gap-2">
            <label htmlFor={props.id} className="sr-only">
              {props.label}
            </label>
            <input
              ref={input}
              id={props.id}
              name={props.field}
              type="file"
              accept={ACCEPT}
              required
              tabIndex={ready ? -1 : undefined}
              onChange={ready ? (e) => e.currentTarget.files?.[0] && void send(e.currentTarget.files[0]) : undefined}
              className={ready ? 'sr-only' : FILE_INPUT}
            />
            {ready ? (
              <CossButton type="button" variant="outline" size="sm" disabled={busy} aria-busy={busy || undefined} onClick={() => input.current?.click()}>
                {busy ? <Spinner aria-hidden="true" role={undefined} aria-label={undefined} className="size-4" /> : <ImageUp />}
                {busy ? 'Uploading…' : props.label}
              </CossButton>
            ) : (
              <Button variant="secondary" small>
                Upload
              </Button>
            )}
          </form>
          {props.extra}
          <DropHint show={ready && !busy} />
        </div>
        {error ? (
          <p role="alert" className="text-caption text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

const FILE_INPUT = 'max-w-full text-body file:mr-3 file:rounded-md file:border file:bg-background file:px-2.5 file:py-1 file:text-body';
