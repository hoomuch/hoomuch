/**
 * Choosing a photo or logo: with a button, or by dragging an image onto the card or field.
 * Owner: Experience (design).
 *
 * Two shapes. ImageUploadCard is a card that sends its image on its own (routes/media.tsx): the
 * profile's photo, a product's logo on its Edit page. ImageField is one field of a bigger form: the
 * logo on the new-product form, sent with the rest when it's saved.
 *
 * Before hydration both are a plain file input (the card with an Upload button), multipart, so they
 * work without JavaScript. Once hydrated the input hides behind a button, the whole card or field
 * takes a dropped image, and either way the image is scaled down in the browser first (a square of
 * UPLOAD_SIDE, cropped to the middle, as WebP where the browser writes it, else JPEG unless it has
 * transparency). Nothing is shown from the file as an <img>: the CSP allows no blob: images. The
 * field draws its preview on a canvas.
 * The server checks whatever arrives either way.
 */

import { ImagePlus, ImageUp } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';
import { Button as CossButton } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { UPLOAD_SIDE } from '../../lib/media';
import { cn } from '../../lib/utils';
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

const encode = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/** No pixel of it is see-through, so it loses nothing as a JPEG. */
function opaque(canvas: HTMLCanvasElement): boolean {
  const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
  if (!data) return false;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
  return true;
}

/** The file scaled down for upload; null when the browser can't draw it (the original goes then). */
async function shrink(file: File): Promise<File | null> {
  const canvas = await draw(file);
  if (!canvas) return null;
  let blob = await encode(canvas, 'image/webp', 0.9);
  if (!blob) return null;
  // A browser that can't write WebP (Safari) hands back PNG: several times the size for a photo,
  // so an image without transparency goes as a JPEG instead. A logo with a see-through edge stays PNG.
  if (blob.type !== 'image/webp' && opaque(canvas)) blob = (await encode(canvas, 'image/jpeg', 0.88)) ?? blob;
  const type = blob.type === 'image/webp' || blob.type === 'image/jpeg' ? blob.type : 'image/png';
  return new File([blob], `image.${type === 'image/jpeg' ? 'jpg' : type.slice(6)}`, { type });
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

// ---------- a field in a bigger form ----------

/**
 * An optional image in a form that posts as multipart: a tile (initials until one is chosen, then
 * a preview drawn on a canvas), Choose, and Remove to go back to none. The form sends the file with
 * the rest.
 */
export function ImageField(props: {
  id: string;
  name: string;
  label: string;
  /** Shown while nothing is chosen, e.g. the product's initials or an icon. */
  placeholder: ReactNode;
  help?: ReactNode;
  error?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ready = useEnhanced();
  const [chosen, setChosen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const choose = async (file: File) => {
    if (!input.current) return;
    if (!isImage(file)) {
      setProblem(NOT_AN_IMAGE);
      return;
    }
    setProblem(null);
    await place(input.current, file);
    setChosen(await preview(canvas, file));
  };
  const clear = () => {
    if (input.current) input.current.value = '';
    setChosen(false);
  };
  const drop = useDrop(ready, (file) => void choose(file));
  const message = problem ?? props.error;
  const helpId = `${props.id}-help`;

  return (
    <div className="mb-5 grid gap-2" data-slot="field" data-invalid={message ? '' : undefined}>
      <label htmlFor={props.id} className="text-body font-medium">
        {props.label} <span className="font-normal text-faint">(optional)</span>
      </label>
      <div className="relative flex flex-wrap items-center gap-4 rounded-xl" {...drop.handlers}>
        <DropOverlay show={drop.over} label="Drop to use it" />
        {ready ? (
          <span className="relative size-16 shrink-0">
            {/* The preview: drawn, never loaded, so the CSP's img-src needs nothing new. */}
            <canvas
              ref={canvas}
              width={128}
              height={128}
              aria-hidden="true"
              className={cn('size-16 rounded-2xl bg-muted outline -outline-offset-1 outline-foreground/10', !chosen && 'hidden')}
            />
            {chosen ? null : props.placeholder}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <input
            ref={input}
            id={props.id}
            name={props.name}
            type="file"
            accept={ACCEPT}
            tabIndex={ready ? -1 : undefined}
            aria-describedby={props.help ? helpId : undefined}
            aria-invalid={message ? true : undefined}
            onChange={ready ? (e) => e.currentTarget.files?.[0] && void choose(e.currentTarget.files[0]) : undefined}
            className={ready ? 'sr-only' : FILE_INPUT}
          />
          {ready ? (
            <>
              <CossButton type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
                <ImagePlus />
                {chosen ? 'Choose another' : 'Choose a logo'}
              </CossButton>
              {chosen ? (
                <CossButton type="button" variant="ghost" size="sm" onClick={clear}>
                  Remove
                </CossButton>
              ) : null}
              <DropHint show />
            </>
          ) : null}
        </div>
      </div>
      {message ? (
        <p role="alert" className="text-caption text-destructive-foreground">
          {message}
        </p>
      ) : null}
      {props.help ? (
        <p id={helpId} className="text-caption text-muted-foreground">
          {props.help}
        </p>
      ) : null}
    </div>
  );
}

/** Draws the chosen image on the preview canvas; false when it can't be drawn. */
async function preview(canvas: RefObject<HTMLCanvasElement | null>, file: File): Promise<boolean> {
  if (!canvas.current) return false;
  try {
    return (await draw(file, canvas.current)) !== null;
  } catch {
    return false;
  }
}
