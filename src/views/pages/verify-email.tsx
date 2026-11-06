/**
 * Email verification: the check-your-inbox page an unverified account is held at, and the page a
 * mailed link opens (one button that confirms). Owner: Experience (pages). See SPEC.md §8.
 */

import { Button, Card, FormError, LinkButton, LinkSubmit } from '../components/ui';
import { Layout, type PageChrome } from '../layout';

export interface VerifyEmailPageProps {
  chrome: PageChrome;
  /**
   * pending: held until the address is confirmed. confirm: a mailed link, waiting for the click.
   * expired / invalid: a mailed link that no longer works.
   */
  state: 'pending' | 'confirm' | 'expired' | 'invalid';
  /** pending: the address the link went to (the signed-in person's own). */
  email?: string;
  /** confirm: the link's token, carried in a hidden field. */
  token?: string;
  /** expired / invalid: whether someone is signed in, which decides where "send a new one" goes. */
  signedIn?: boolean;
  /** pending: why the last resend didn't go out. */
  error?: string | null;
  /** How long a link works, in hours (from lib/email-verification). */
  linkHours: number;
}

const LEAD = 'mt-2 text-body text-muted-foreground';

export function VerifyEmailPage(props: VerifyEmailPageProps) {
  if (props.state === 'confirm') {
    return (
      <Layout {...props.chrome} title="Confirm your email" width="narrow" noindex>
        <Card>
          <h1 className="font-heading text-title">Confirm your email</h1>
          <p className={LEAD}>One click and your account is ready.</p>
          <form method="post" action="/verify-email/confirm" className="mt-6">
            <input type="hidden" name="token" value={props.token ?? ''} />
            <Button block busyLabel="Confirming…">
              Confirm my email
            </Button>
          </form>
        </Card>
      </Layout>
    );
  }

  if (props.state === 'expired' || props.state === 'invalid') {
    const expired = props.state === 'expired';
    const heading = expired ? 'This link has expired' : 'This link doesn’t work';
    return (
      <Layout {...props.chrome} title={heading} width="narrow" noindex>
        <Card>
          <h1 className="font-heading text-title">{heading}</h1>
          <p className={LEAD}>
            {expired
              ? `Confirmation links work for ${props.linkHours} hours.`
              : 'It may have been used already, or copied only in part.'}{' '}
            {props.signedIn ? 'Send yourself a new one.' : 'Log in to send yourself a new one.'}
          </p>
          <div className="mt-6">
            <LinkButton block href={props.signedIn ? '/verify-email' : '/login?next=%2Fverify-email'}>
              {props.signedIn ? 'Get a new link' : 'Log in'}
            </LinkButton>
          </div>
        </Card>
      </Layout>
    );
  }

  return (
    <Layout {...props.chrome} title={props.error ? 'Error: Check your inbox' : 'Check your inbox'} width="narrow" noindex>
      <Card>
        <h1 className="font-heading text-title">Check your inbox</h1>
        {/* Worded so it still holds when the send failed (the flash above says so). */}
        <p className={LEAD}>
          Open the link we email to <strong className="font-medium break-all text-foreground">{props.email}</strong> to
          confirm it’s your address. Then your dashboard is ready.
        </p>
        <p className={LEAD}>The link works for {props.linkHours} hours. Nothing there? Check your spam folder, or send it again.</p>
        <form method="post" action="/verify-email/resend" className="mt-6">
          <FormError message={props.error} autoFocus={Boolean(props.error)} />
          <Button block variant="secondary" busyLabel="Sending…">
            Send the link again
          </Button>
        </form>
        <form method="post" action="/logout" className="mt-6 text-body text-muted-foreground">
          Wrong address? <LinkSubmit>Log out</LinkSubmit> and sign up again with the right one.
        </form>
      </Card>
    </Layout>
  );
}
