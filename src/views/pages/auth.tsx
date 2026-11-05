/** Log in and sign up (one narrow card, two fields). Owner: Experience (pages). */

import { PASSWORD_MIN } from '../../lib/auth';
import { Button, Card, Field, FormError, LinkButton } from '../components/ui';
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
          <h1 class="text-title">Sign-ups are closed</h1>
          <p class="mt-2 text-body text-ink-2">
            This hoomuch instance isn’t accepting new accounts. If you already have one, log in.
          </p>
          <div class="mt-6">
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
        <h1 class={isSignup ? 'text-title' : 'mb-6 text-title'}>{title}</h1>
        {isSignup ? <p class="mt-1.5 mb-6 text-body text-ink-2">Two fields, then your MRR.</p> : null}
        <form method="post" action={isSignup ? '/signup' : '/login'}>
          <FormError message={formError} autofocus={focus === 'form'} />
          {props.next ? <input type="hidden" name="next" value={props.next} /> : null}
          <Field
            name="email"
            label="Email"
            type="email"
            value={props.email}
            autocomplete="email"
            required
            maxlength={254}
            autofocus={focus === 'email'}
            error={emailError}
          />
          <Field
            name="password"
            label="Password"
            type="password"
            autocomplete={isSignup ? 'new-password' : 'current-password'}
            required
            minlength={isSignup ? PASSWORD_MIN : undefined}
            maxlength={256}
            autofocus={focus === 'password'}
            help={isSignup ? `At least ${PASSWORD_MIN} characters.` : undefined}
            error={passwordError}
          />
          <div class="mt-6">
            <Button busyLabel={isSignup ? 'Creating account…' : 'Logging in…'}>{isSignup ? 'Create account' : 'Log in'}</Button>
          </div>
        </form>
        <p class="mt-6 text-body text-ink-2">
          {isSignup ? (
            <>
              Already have an account?{' '}
              <a href={withNext('/login', props.next)} class="link">
                Log in
              </a>
            </>
          ) : props.signupOpen ? (
            <>
              New here?{' '}
              <a href={withNext('/signup', props.next)} class="link">
                Create an account
              </a>
            </>
          ) : (
            'Sign-ups are closed on this instance.'
          )}
        </p>
      </Card>
    </Layout>
  );
}
