/**
 * The privacy policy and terms of service (GET /privacy, /terms; lib/legal.ts). Owner: Experience
 * (pages).
 *
 * hoomuch.com's own texts: an individual operator in Türkiye, the KVKK (No. 6698) and the GDPR where
 * it applies. Like TrustMRR's, they name no court and no postal address. The privacy policy says
 * what the code does: what is stored (db, sync), which cookies exist (lib/auth.ts, lib/flash.ts,
 * routes/prefs.ts), who processes what (Cloudflare, Resend, the providers), and how long things are
 * kept. Change it when they change, and move LEGAL_UPDATED. A serious zone: no owl, no jokes
 * (design/brief.md).
 */

import type { ReactNode } from 'react';
import type { LegalOperator } from '../../lib/legal';
import { TextLink } from '../components/ui';
import { Layout, type PageChrome } from '../layout';

export interface LegalPageProps {
  chrome: PageChrome;
  doc: 'privacy' | 'terms';
  operator: LegalOperator;
  /** This instance's host, e.g. "hoomuch.com". */
  host: string;
}

/** When either text last changed. */
const LEGAL_UPDATED = '9 November 2026';

const TITLES = { privacy: 'Privacy Policy', terms: 'Terms of Service' } as const;

export function LegalPage(props: LegalPageProps) {
  const title = TITLES[props.doc];
  return (
    <Layout
      {...props.chrome}
      title={title}
      description={
        props.doc === 'privacy'
          ? `How ${props.host} handles personal data: what is collected, why, who processes it, how long it is kept and your rights.`
          : `The terms for using ${props.host}: accounts, read-only connections, public pages, acceptable use and liability.`
      }
      marketing
      quiet
    >
      <article className="max-w-[44rem]">
        <header className="mb-10">
          <h1 className="font-heading text-hero-sm">{title}</h1>
          <p className="mt-2 text-body text-muted-foreground">
            Last updated {LEGAL_UPDATED}. See also the{' '}
            {props.doc === 'privacy' ? <TextLink href="/terms">Terms of Service</TextLink> : <TextLink href="/privacy">Privacy Policy</TextLink>}.
          </p>
        </header>
        <div className="grid gap-8">{props.doc === 'privacy' ? <Privacy {...props} /> : <Terms {...props} />}</div>
      </article>
    </Layout>
  );
}

function Section(props: { n: number; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`s${props.n}`} className="grid gap-3 text-body leading-relaxed text-pretty text-muted-foreground">
      <h2 id={`s${props.n}`} className="font-heading text-base text-foreground">
        {props.n}. {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function List(props: { children: ReactNode }) {
  return <ul className="grid list-disc gap-1.5 pl-5 marker:text-faint">{props.children}</ul>;
}

/** What a reader calls the operator and where they write. */
function Contact(props: { operator: LegalOperator }) {
  return <TextLink href={`mailto:${props.operator.email}`}>{props.operator.email}</TextLink>;
}

// ---------- privacy ----------

function Privacy(props: LegalPageProps) {
  const { operator, host } = props;
  return (
    <>
      <div className="rounded-2xl border bg-muted/30 px-5 py-4 text-body leading-relaxed text-pretty sm:px-6">
        <p className="font-medium text-foreground">In short</p>
        <p className="mt-1 text-muted-foreground">
          We keep your account, your encrypted keys and your revenue figures, and never your customers’ names, emails or
          card details. Nothing is public until you publish it. There are no analytics, ads or tracking cookies. Delete your
          account and everything goes with it.
        </p>
      </div>

      <Section n={1} title="Who we are">
        <p>
          This Privacy Policy explains how personal data is processed when you use hoomuch at {host} (the “Service”). The
          Service is operated by {operator.name}, an individual resident in the Republic of Türkiye (“we”, “us”), who is the
          data controller under the Turkish Law on the Protection of Personal Data No. 6698 (“KVKK”) and, where it applies,
          the EU General Data Protection Regulation (“GDPR”). You can reach us at <Contact operator={operator} />.
        </p>
      </Section>

      <Section n={2} title="What we collect">
        <List>
          <li>
            <strong className="font-medium text-foreground">Account data:</strong> your email address, a salted hash of your
            password (never the password itself), your display currency and time zone, and when your account and sessions
            were created. Until you choose a time zone, it is set from the region your connection comes from.
          </li>
          <li>
            <strong className="font-medium text-foreground">Connection data:</strong> the API keys or credentials you give
            us for your payment and app store accounts, encrypted at rest with AES-256-GCM, and the names you give your
            connections.
          </li>
          <li>
            <strong className="font-medium text-foreground">Business data read from those accounts:</strong> amounts,
            currencies, dates, subscription and trial counts, product and plan names, and the providers’ own transaction
            identifiers. We do not collect your customers’ names, email addresses, phone numbers, postal addresses or
            payment card details. Where a store report includes a buyer’s location, we do not read it.
          </li>
          <li>
            <strong className="font-medium text-foreground">Public page data, only if you publish:</strong> your handle,
            name, bio, website, X username and photo; each product’s name, address, tagline, website and logo; and the
            figures shown with them. If you give a product website, we fetch that website’s public icon. We remove
            embedded metadata, such as location, from photos and logos before storing them.
          </li>
          <li>
            <strong className="font-medium text-foreground">Technical data:</strong> your IP address, used briefly and in
            hashed form to limit sign-in attempts and abusive traffic; request and error logs kept by our hosting provider
            for a few days; and, on the sign-in and sign-up pages, the data Cloudflare Turnstile uses to tell people from
            bots.
          </li>
          <li>
            <strong className="font-medium text-foreground">Correspondence:</strong> what you send us by email.
          </li>
        </List>
        <p>We do not use analytics, advertising or tracking tools, and we do not sell personal data.</p>
      </Section>

      <Section n={3} title="Why we use it">
        <List>
          <li>
            To provide the Service: creating and securing your account, syncing your connections, showing your dashboard,
            and sending account emails such as address confirmation. Legal basis: performance of our contract with you
            (KVKK Art. 5(2)(c); GDPR Art. 6(1)(b)).
          </li>
          <li>
            To publish your public pages, badges and Explore listing, when and for as long as you choose to. Legal basis:
            performance of our contract, at your request (same articles).
          </li>
          <li>
            To keep the Service secure and prevent abuse: rate limits, bot protection and logs. Legal basis: our legitimate
            interests (KVKK Art. 5(2)(f); GDPR Art. 6(1)(f)).
          </li>
          <li>
            To meet legal obligations and respond to lawful requests (KVKK Art. 5(2)(ç); GDPR Art. 6(1)(c)).
          </li>
        </List>
      </Section>

      <Section n={4} title="Public pages">
        <p>
          Nothing is public until you publish it. What you publish can be seen by anyone, and may be cached by browsers and
          indexed or copied by others, including search engines and AI assistants. When you unpublish a product or delete
          your account, its pages, badges and listing are removed from the Service at once; copies already cached elsewhere
          may remain for a short time.
        </p>
      </Section>

      <Section n={5} title="Your customers’ data">
        <p>
          The transaction identifiers and amounts we read may relate to your own customers. For that data, you are the data
          controller and we process it on your behalf, only to provide the Service to you and as these documents describe.
          We do not use it for any other purpose.
        </p>
      </Section>

      <Section n={6} title="Who processes it">
        <List>
          <li>
            <strong className="font-medium text-foreground">Cloudflare, Inc.</strong> hosts the Service: computing,
            database, file storage, queues, bot protection, logs and email routing. Our database and files are stored in
            Cloudflare’s European regions; requests are handled across its global network.
          </li>
          <li>
            <strong className="font-medium text-foreground">Resend</strong> sends account emails on our behalf; it
            receives your email address and the message.
          </li>
          <li>
            <strong className="font-medium text-foreground">Your providers</strong> (for example Stripe or App Store
            Connect) receive your key when we read your data. They act under their own terms and privacy policies.
          </li>
        </List>
        <p>
          Exchange rates come from a public service; no personal data is sent to it. We disclose personal data to
          authorities only where the law requires it.
        </p>
      </Section>

      <Section n={7} title="International transfers">
        <p>
          Because our providers operate internationally, your data may be processed outside Türkiye and the European
          Economic Area. Such transfers are made in accordance with Article 9 of the KVKK and Chapter V of the GDPR, relying
          on the safeguards our providers offer, such as standard contractual clauses.
        </p>
      </Section>

      <Section n={8} title="How long we keep it">
        <List>
          <li>
            Account, connection and synced data: until you delete your account, or the connection, which deletes its key and
            its data from our database at once. Photos and logos are deleted from storage at the same time. Our database provider’s restore
            points may hold a copy for up to 30 days.
          </li>
          <li>Sessions: 30 days, renewed while you use the Service, and never longer than 90 days.</li>
          <li>Sign-in and rate-limit records: between 15 minutes and one day.</li>
          <li>Sync history: the latest 100 runs of each connection.</li>
          <li>Accounts whose email address was never confirmed: deleted once every confirmation link has expired.</li>
          <li>Logs: a few days. Correspondence: as long as needed to deal with it.</li>
        </List>
      </Section>

      <Section n={9} title="Cookies">
        <p>We only use cookies the Service needs to work, so we do not ask for cookie consent:</p>
        <List>
          <li>
            <code className="text-foreground">hm_session</code> keeps you signed in (30 days, not readable by scripts), and{' '}
            <code className="text-foreground">hm_in</code> tells our public pages you are signed in (30 days).
          </li>
          <li>
            <code className="text-foreground">hm_flash</code>, <code className="text-foreground">hm_celebrate</code> and{' '}
            <code className="text-foreground">hm_next</code> carry a one-time message or the page to return to after
            confirming your email (one minute to one day).
          </li>
          <li>
            <code className="text-foreground">hm_range</code>, <code className="text-foreground">hm_provider</code> and{' '}
            <code className="text-foreground">hm_revenue</code> remember how you last viewed your dashboard (one year).
          </li>
        </List>
        <p>Over HTTPS each name carries the <code className="text-foreground">__Host-</code> prefix.</p>
      </Section>

      <Section n={10} title="Your rights">
        <p>
          Under Article 11 of the KVKK and, where it applies, Articles 15 to 22 of the GDPR, you may ask whether and how your
          personal data is processed, and request access to it, its correction or deletion, the restriction of its
          processing, or a copy in a portable format; object to processing based on our legitimate interests; and claim
          compensation for damage caused by unlawful processing. You can delete your account at any time in Settings. For
          anything else, write to <Contact operator={operator} />; we answer within 30 days. You may also complain to the
          Personal Data Protection Authority of Türkiye (Kişisel Verileri Koruma Kurumu) or, in the EU, to your local
          supervisory authority.
        </p>
      </Section>

      <Section n={11} title="Security">
        <p>
          Keys are encrypted, passwords are hashed with PBKDF2, all traffic uses HTTPS, and the Service only ever reads from
          your accounts. No system is perfectly secure; if a breach affects your personal data, we will notify you and the
          authorities as the law requires.
        </p>
      </Section>

      <Section n={12} title="Children">
        <p>The Service is not intended for anyone under 18, and we do not knowingly collect their data.</p>
      </Section>

      <Section n={13} title="Self-hosted copies">
        <p>
          hoomuch is open-source software. This policy covers only the Service at {host}. Anyone who runs their own copy is
          responsible for how it processes personal data.
        </p>
      </Section>

      <Section n={14} title="Changes">
        <p>
          We may update this policy. The date at the top shows the latest version; if a change materially affects how we use
          your data, we will tell you by email or in the Service before it takes effect.
        </p>
      </Section>
    </>
  );
}

// ---------- terms ----------

function Terms(props: LegalPageProps) {
  const { operator, host } = props;
  return (
    <>
      <Section n={1} title="Agreement">
        <p>
          These Terms of Service (the “Terms”) govern your use of hoomuch at {host} (the “Service”), operated by{' '}
          {operator.name}, an individual resident in the Republic of Türkiye (“we”, “us”). By creating an account or using
          the Service, you agree to these Terms and confirm you have read the <TextLink href="/privacy">Privacy Policy</TextLink>.
          If you use the Service for an organisation, you accept these Terms on its behalf and confirm you are authorised to
          do so.
        </p>
      </Section>

      <Section n={2} title="The Service">
        <p>
          The Service reads data from the payment and app store accounts you connect, using credentials you provide, and
          shows your revenue metrics. You may choose to publish product pages, a founder profile, badges and an Explore
          listing. hoomuch is open-source software licensed under AGPL-3.0; that licence governs the software, and these
          Terms govern only the hosted Service at {host}, not copies that others run.
        </p>
      </Section>

      <Section n={3} title="Your account">
        <p>
          You must be at least 18 and give accurate information. The Service is meant for business use: you use it in your
          trade, business or profession. You are responsible for keeping your password safe and for activity under your
          account. Tell us at <Contact operator={operator} /> if you believe it has been used without
          your permission.
        </p>
      </Section>

      <Section n={4} title="Your connections">
        <p>
          You confirm that you are authorised to give us access to each account you connect, and that doing so does not
          breach your provider’s terms or any agreement that binds you. Use restricted, read-only keys where your provider
          offers them; some providers only issue keys that could do more, and for those too we only read. We never create,
          change or delete anything in your provider accounts. You can revoke a key at your provider, or remove the
          connection, which deletes the key at once, at any time.
        </p>
      </Section>

      <Section n={5} title="Public pages, badges and Explore">
        <List>
          <li>
            You may publish only products you own or are authorised to represent. Figures are calculated from your connected
            accounts; you must not manipulate them, for example with transactions to yourself, artificial or test payments,
            or someone else’s account.
          </li>
          <li>
            You are responsible for what you add (names, descriptions, links, photos and logos), and confirm that you have the
            rights to it and that it is lawful, accurate and not misleading.
          </li>
          <li>
            While it is published, you grant us a worldwide, non-exclusive, royalty-free licence to host, reproduce, display
            and distribute that content and the published figures as part of the Service, including in badges, link
            previews, search results and machine-readable versions of your pages.
          </li>
          <li>
            We may decide what appears on Explore and in what order, and may hide or remove any page, listing or content that
            we reasonably believe breaks these Terms or the law or is misleading, with or without notice. If someone claims a
            published product is theirs, we may ask both sides for proof and unpublish it until the claim is resolved.
          </li>
        </List>
      </Section>

      <Section n={6} title="Acceptable use">
        <p>You must not:</p>
        <List>
          <li>use the Service unlawfully, or to access accounts or data that are not yours;</li>
          <li>interfere with, overload or probe the Service, or get around its limits or security measures;</li>
          <li>create accounts by automated means, or impersonate any person or business;</li>
          <li>present figures from the Service as more recent, complete or verified than the Service shows them;</li>
          <li>upload malicious, infringing or unlawful content; or</li>
          <li>resell or provide the hosted Service to others without our written permission.</li>
        </List>
      </Section>

      <Section n={7} title="Fees">
        <p>
          The Service is currently free. If we introduce paid plans, we will tell you in advance, show the price and terms
          before you pay, and charge you only if you choose a paid plan.
        </p>
      </Section>

      <Section n={8} title="No advice; accuracy">
        <p>
          Figures depend on your providers’ data, exchange rates and the timing of syncs, and may be delayed, incomplete or
          estimated. The Service is for information only and is not financial, accounting, tax, investment or legal advice.
          Anyone relying on figures shown by the Service, including on a public page, does so at their own risk.
        </p>
      </Section>

      <Section n={9} title="Availability and changes">
        <p>
          The Service is provided “as is” and “as available”. We may change, suspend or discontinue any part of it; where a
          change is significant, we will try to give you reasonable notice. If we discontinue the Service, we will give at
          least 30 days’ notice where possible.
        </p>
      </Section>

      <Section n={10} title="Termination">
        <p>
          You may stop using the Service and delete your account at any time in Settings; your data is then deleted as the
          Privacy Policy describes. We may suspend or close an account that breaches these Terms, or that exposes the
          Service, us or others to harm or legal risk, giving notice where reasonable.
        </p>
      </Section>

      <Section n={11} title="Liability">
        <p>
          To the fullest extent permitted by law, we disclaim all warranties, express or implied, and are not liable for
          indirect or consequential loss, lost profits or revenue, or loss of data. Our total liability for all claims
          relating to the Service is limited to the greater of the amount you paid us in the 12 months before the claim and
          USD 100. Nothing in these
          Terms limits liability for intent or gross negligence, or any other liability that cannot be limited under
          applicable law.
        </p>
        <p>
          You agree to compensate us for losses arising from content you publish or from your breach of these Terms, to the
          extent caused by you.
        </p>
      </Section>

      <Section n={12} title="Changes to these Terms">
        <p>
          We may update these Terms. We will tell you about material changes by email or in the Service before they take
          effect; continuing to use the Service after that means you accept them. If you do not, you may delete your account.
        </p>
      </Section>

      <Section n={13} title="General">
        <p>
          If any part of these Terms is found unenforceable, the rest remains in force. Not enforcing a right is not a
          waiver of it. We may transfer these Terms to a successor operating the Service, for example a company we set up
          for it, and will tell you if we do. Questions: <Contact operator={operator} />.
        </p>
      </Section>
    </>
  );
}
