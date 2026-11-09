/**
 * Uploading a photo or logo (routes/media.tsx). Owner: Experience (design).
 *
 * Before hydration it's a plain multipart form: a file field and Upload. Once hydrated the field
 * hides behind one button, as on a social network's "Change photo": picking a file scales it down
 * in the browser (a square of UPLOAD_SIDE, cropped to the middle, as WebP where the browser writes
 * it) and sends it at once. Nothing is shown from the file before it's sent: the CSP allows no
 * blob: images. The server checks whatever arrives either way.
 */

import { ImageUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button as CossButton } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { UPLOAD_SIDE } from '../../lib/media';
import { Button } from './ui';

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

/** The file as a centred square at most UPLOAD_SIDE across; null when the browser can't draw it. */
async function shrink(file: File): Promise<File | null> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(side, UPLOAD_SIDE);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  if (!blob) return null;
  // A browser that can't write WebP hands back PNG, which is fine too.
  const webp = blob.type === 'image/webp';
  return new File([blob], webp ? 'image.webp' : 'image.png', { type: webp ? 'image/webp' : 'image/png' });
}

export function ImageUpload(props: { id: string; action: string; field: string; label: string }) {
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setReady(typeof createImageBitmap === 'function' && typeof DataTransfer === 'function'), []);
  // Back from the page this one posted to (the browser's back button): the button works again.
  useEffect(() => {
    const reset = () => setBusy(false);
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  const send = async () => {
    const field = input.current;
    const file = field?.files?.[0];
    if (!field || !file || !form.current) return;
    setBusy(true);
    try {
      const smaller = await shrink(file);
      if (smaller) {
        const picked = new DataTransfer();
        picked.items.add(smaller);
        field.files = picked.files;
      }
    } catch {
      // Not something this browser can draw: send it as it is, and the server says what's wrong.
    }
    form.current.requestSubmit();
  };

  return (
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
        onChange={ready ? () => void send() : undefined}
        className={ready ? 'sr-only' : 'max-w-full text-body file:mr-3 file:rounded-md file:border file:bg-background file:px-2.5 file:py-1 file:text-body'}
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
  );
}
