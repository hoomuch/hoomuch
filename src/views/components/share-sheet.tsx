/**
 * Sharing a public page (SPEC F-21/F-22): one tap to post it on X, LinkedIn or Bluesky, copy its
 * link, or open the device's own share menu where there is one. Owner: Experience (design).
 *
 * The posts are plain links to each network's compose page with the text and link filled in: no
 * script of theirs runs here, and the person edits the post there before it goes out. Copy and the
 * device's menu (navigator.share: Messages, WhatsApp, Slack, …) appear once hydrated, where the
 * browser has them.
 *
 * ShareButtons is the row of round buttons, for the public pages' headers. ShareSheet puts the link
 * in a field to copy before them, for the owner's Share page.
 */

import { Check, Ellipsis, Link2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button as CossButton } from '@/components/ui/button';
import { CopyField } from './copy-field';
import { BlueskyMark, LinkedInMark, XMark } from './icons';

const enc = encodeURIComponent;

/** How long the copy button shows its check. */
const COPIED_MS = 2000;

/** A post on X with the page's link: the share that brings the next visitor. */
function xIntent(text: string, url: string): string {
  return `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}`;
}

interface Shared {
  /** The page's absolute URL. */
  url: string;
  /** The post's words, before the link, e.g. "Acme is at $1,200 MRR, verified by hoomuch". */
  text: string;
  /** What's shared, for the device's menu, e.g. "Acme". */
  title: string;
}

export function ShareSheet(props: Shared & { id: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1 basis-64">
        <CopyField id={props.id} label={`Link to ${props.title}`} value={props.url} />
      </div>
      <ShareButtons url={props.url} text={props.text} title={props.title} />
    </div>
  );
}

/** The round buttons. `copy` adds one that copies the link, where there's no field holding it. */
export function ShareButtons(props: Shared & { copy?: boolean }) {
  const { url, text } = props;
  const [canShare, setCanShare] = useState(false);
  const [canCopy, setCanCopy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCanShare(typeof navigator.share === 'function');
    setCanCopy(Boolean(navigator.clipboard));
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <ul className="flex items-center gap-1.5" aria-label="Share">
      <Target href={xIntent(text, url)} label="Post on X">
        <XMark className="size-4" />
      </Target>
      <Target href={`https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`} label="Share on LinkedIn">
        <LinkedInMark className="size-4" />
      </Target>
      <Target href={`https://bsky.app/intent/compose?text=${enc(`${text} ${url}`)}`} label="Post on Bluesky">
        <BlueskyMark className="size-4" />
      </Target>
      {props.copy && canCopy ? (
        <Action label={copied ? 'Link copied' : 'Copy link'} onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}>
          {copied ? <Check /> : <Link2 />}
        </Action>
      ) : null}
      {canShare ? (
        // A dismissed menu rejects; there's nothing to tell anyone then.
        <Action label="More ways to share" onClick={() => void navigator.share({ title: props.title, text, url }).catch(() => undefined)}>
          <Ellipsis />
        </Action>
      ) : null}
    </ul>
  );
}

function Target(props: { href: string; label: string; children: ReactNode }) {
  return (
    <li>
      <CossButton
        render={<a href={props.href} target="_blank" rel="noopener noreferrer" aria-label={props.label} title={props.label} />}
        variant="outline"
        size="icon"
        className="rounded-full"
      >
        {props.children}
      </CossButton>
    </li>
  );
}

function Action(props: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <li>
      <CossButton type="button" variant="outline" size="icon" aria-label={props.label} title={props.label} className="rounded-full" onClick={props.onClick}>
        {props.children}
      </CossButton>
    </li>
  );
}
