/**
 * 404 and 500 pages. Owner: Experience (pages). Never show stack traces or internals here.
 *
 * The 404 is a personality zone (the owl, one dry line). The 500 is an error: literal, calm,
 * no owl, no joke (design/brief.md §3.6–3.7).
 */

import type { Child } from 'hono/jsx';
import { Owl } from '../components/mascot';
import { LinkButton } from '../components/ui';
import { Layout, type PageChrome } from '../layout';

function ErrorShell(props: {
  chrome: PageChrome;
  title: string;
  heading: string;
  message: string;
  illustration?: Child;
  marketing?: boolean;
}) {
  const home = props.chrome.user ? '/dashboard' : '/';
  return (
    <Layout {...props.chrome} title={props.title} noindex marketing={props.marketing}>
      <section class="mx-auto max-w-md py-16 text-center">
        {props.illustration}
        <h1 class="text-title">{props.heading}</h1>
        <p class="mt-2 text-pretty text-ink-2">{props.message}</p>
        <div class="mt-8">
          <LinkButton href={home} variant="secondary">
            {props.chrome.user ? 'Back to the dashboard' : 'Back to the home page'}
          </LinkButton>
        </div>
      </section>
    </Layout>
  );
}

export function NotFoundPage(props: { chrome: PageChrome }) {
  return (
    <ErrorShell
      chrome={props.chrome}
      title="Page not found"
      heading="This page isn’t here."
      message="We looked everywhere. The owl even turned its head upside down."
      illustration={<Owl pose="lost" eager class="mx-auto mb-6" />}
      marketing={!props.chrome.user}
    />
  );
}

export function ServerErrorPage(props: { chrome: PageChrome }) {
  return (
    <ErrorShell
      chrome={props.chrome}
      title="Something went wrong"
      heading="Something went wrong."
      message="The error has been logged. Try again in a moment."
    />
  );
}
