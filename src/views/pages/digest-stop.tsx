/**
 * The page a digest's "Stop these emails" link opens (GET /digest/stop): one button that turns the
 * digest off, with or without a session. Owner: Experience (pages). See SPEC F-25.
 */

import { Button, Card, LinkButton } from '../components/ui';
import { Layout, type PageChrome } from '../layout';

export interface DigestStopPageProps {
  chrome: PageChrome;
  /** confirm: a link of ours, waiting for the click. done: turned off. invalid: not a link of ours. */
  state: 'confirm' | 'done' | 'invalid';
  /** confirm: the link's two parts, carried in hidden fields. */
  userId?: string;
  token?: string;
}

const LEAD = 'mt-2 text-body text-muted-foreground';

export function DigestStopPage(props: DigestStopPageProps) {
  if (props.state === 'confirm') {
    return (
      <Layout {...props.chrome} title="Stop the email digest" width="narrow" noindex>
        <Card>
          <h1 className="font-heading text-title">Stop the email digest</h1>
          <p className={LEAD}>One click and the digest stops. You can turn it back on in Settings.</p>
          <form method="post" action="/digest/stop" className="mt-6">
            <input type="hidden" name="u" value={props.userId ?? ''} />
            <input type="hidden" name="t" value={props.token ?? ''} />
            <Button block busyLabel="Stopping…">
              Stop these emails
            </Button>
          </form>
        </Card>
      </Layout>
    );
  }

  const done = props.state === 'done';
  const heading = done ? 'The digest is off' : 'This link doesn’t work';
  return (
    <Layout {...props.chrome} title={heading} width="narrow" noindex>
      <Card>
        <h1 className="font-heading text-title">{heading}</h1>
        <p className={LEAD}>
          {done
            ? 'No more digest emails will be sent. You can turn it back on in Settings.'
            : 'It may have been copied only in part. You can turn the digest off in Settings.'}
        </p>
        <div className="mt-6">
          <LinkButton block variant="secondary" href="/settings#email-digest">
            Open Settings
          </LinkButton>
        </div>
      </Card>
    </Layout>
  );
}
