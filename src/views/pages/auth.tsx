/** Log in and sign up (one narrow card, two fields). Owner: Experience (pages). */

import { PASSWORD_MIN } from '../../lib/auth';
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
}

function withNext(path: string, next: string | null | undefined): string {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}

export function AuthPage(props: AuthPageProps) {
  const isSignup = props.mode === 'signup';
  const title = isSignup ? 'Create your account' : 'Log in';

  if (isSignup && !props.signupOpen) {
    return (
      <Layout {...props.chrome} title="Sign-ups closed" width="narrow">
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

  return (
    <Layout {...props.chrome} title={pageTitle} width="narrow">
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
