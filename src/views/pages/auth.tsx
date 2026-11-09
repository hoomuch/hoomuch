/** Log in and sign up (one narrow card, two fields). Owner: Experience (pages). */

import { HONEYPOT_FIELD } from '../../lib/bot-defense';
import { PASSWORD_MIN } from '../../lib/password-policy';
import { TurnstileWidget } from '../components/turnstile';
import { Button, Card, Field, FormError, LinkButton, TextLink } from '../components/ui';
import { Layout, type PageChrome } from '../layout';

export interface AuthPageProps {
  chrome: PageChrome;
  mode: 'login' | 'signup';
  /** A safe relative path to return to after success; carried in a hidden field. */
  next?: string | null;
  /** Re-filled after an error. The password never is. */
  email?: string;
  error?: string | null;
  /** Field the error belongs to; otherwise it is shown above the form. */
  field?: 'email' | 'password';
  /** False when ALLOW_SIGNUP=false. */
  signupOpen: boolean;
  /** Turnstile's public site key when the instance turns it on; the form then shows the widget. */
  turnstileSiteKey?: string | null;
}

function withNext(path: string, next: string | null | undefined): string {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}

export function AuthPage(props: AuthPageProps) {
  const isSignup = props.mode === 'signup';
  const title = isSignup ? 'Create your account' : 'Log in';

  if (isSignup && !props.signupOpen) {
    return (
      // One line on a private instance: nothing for a search engine to show.
      <Layout {...props.chrome} title="Sign-ups closed" width="narrow" noindex>
        <Card>
          <h1 className="font-heading text-title">Sign-ups are closed</h1>
          <p className="mt-2 text-body text-muted-foreground">
            This hoomuch instance isn’t accepting new accounts. If you already have one, log in.
          </p>
          <div className="mt-6">
            <LinkButton href={withNext('/login', props.next)}>Log in</LinkButton>
          </div>
        </Card>
      </Layout>
    );
  }

  const emailError = props.field === 'email' ? (props.error ?? undefined) : undefined;
  const passwordError = props.field === 'password' ? (props.error ?? undefined) : undefined;
  const formError = props.field ? null : props.error;
  // After a failed submit, focus goes to what needs fixing: the field with the error, else the
  // form-level message. Exactly one element gets autofocus.
  const focus = passwordError ? 'password' : emailError ? 'email' : formError ? 'form' : 'email';
  // "Error: " leads the title, so the failure is announced as the re-rendered page loads.
  const pageTitle = (props.error ? 'Error: ' : '') + (isSignup ? 'Sign up' : 'Log in');
  // Search engines show these two pages for the name, so each gets its own line.
  const description = isSignup
    ? 'Two fields, then your MRR. Connect Stripe, Paddle, RevenueCat, the App Store, Google Play and more with one key each, or start with demo data.'
    : 'Log in to see your MRR, ARR, subscriptions and revenue from every store you sell in, on one dashboard.';

  return (
    <Layout {...props.chrome} title={pageTitle} description={description} width="narrow">
      <Card>
        <h1 className={isSignup ? 'font-heading text-title' : 'mb-6 font-heading text-title'}>{title}</h1>
        {isSignup ? <p className="mt-1.5 mb-6 text-body text-muted-foreground">Two fields, then your MRR.</p> : null}
        <form method="post" action={isSignup ? '/signup' : '/login'}>
          <FormError message={formError} autoFocus={focus === 'form'} />
          {props.next ? <input type="hidden" name="next" value={props.next} /> : null}
          <Field
            name="email"
            label="Email"
            type="email"
            value={props.email}
            autoComplete="email"
            required
            maxLength={254}
            autoFocus={focus === 'email'}
            error={emailError}
          />
          <Field
            name="password"
            label="Password"
            type="password"
            autoComplete={isSignup ? 'new-password' : 'current-password'}
            required
            minLength={isSignup ? PASSWORD_MIN : undefined}
            maxLength={256}
            autoFocus={focus === 'password'}
            help={isSignup ? `At least ${PASSWORD_MIN} characters.` : undefined}
            error={passwordError}
          />
          {/* Honeypot: hidden from people and assistive tech, so only a bot fills it in (lib/bot-defense.ts). */}
          <div className="hidden" aria-hidden="true">
            <label>
              Leave this empty
              <input type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" />
            </label>
          </div>
          {props.turnstileSiteKey ? (
            <TurnstileWidget siteKey={props.turnstileSiteKey} action={isSignup ? 'signup' : 'login'} />
          ) : null}
          <div className="mt-6">
            <Button block busyLabel={isSignup ? 'Creating account…' : 'Logging in…'}>{isSignup ? 'Create account' : 'Log in'}</Button>
          </div>
        </form>
        <p className="mt-6 text-body text-muted-foreground">
          {isSignup ? (
            <>
              Already have an account?{' '}
              <TextLink href={withNext('/login', props.next)}>Log in</TextLink>
            </>
          ) : props.signupOpen ? (
            <>
              New here?{' '}
              <TextLink href={withNext('/signup', props.next)}>Create an account</TextLink>
            </>
          ) : (
            'Sign-ups are closed on this instance.'
          )}
        </p>
      </Card>
    </Layout>
  );
}
