/**
 * What an owner tells visitors about a product (SPEC F-21): the About section of its public page,
 * and the icons its tags wear there and on the Share page's form. Owner: Experience (design).
 *
 * All of it is the owner's words, so the section says so and sits apart from the verified figures.
 * Only what's filled in shows. Tags come from fixed lists (lib/product-details.ts); brands wear
 * their marks from public/brand-icons.svg (scripts/update-tech-icons.mjs), the rest a lucide icon.
 */

import {
  BadgeCheck,
  Blocks,
  MessageSquareQuote,
  Quote,
  Briefcase,
  Building2,
  ChartColumn,
  CodeXml,
  CircleDollarSign,
  Cloud,
  GraduationCap,
  Handshake,
  HeartPulse,
  House,
  Info,
  LifeBuoy,
  Lightbulb,
  List,
  ListChecks,
  Mail,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Music,
  Newspaper,
  Palette,
  PenLine,
  Plane,
  Scale,
  Search,
  Send,
  Shield,
  ShoppingBag,
  Smartphone,
  Sparkles,
  Store,
  Tag,
  Target,
  TrendingUp,
  Users,
  UsersRound,
  Utensils,
  Wallet,
  Bitcoin,
  Gamepad2,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card as CossCard } from '@/components/ui/card';
import {
  CHANNELS,
  describePlan,
  FUNDING,
  groupPlans,
  hasDetails,
  labelOf,
  MARKETS,
  MODELS,
  PLAN_PERIODS,
  TECH,
  yearlySaving,
  type ChannelId,
  type MarketId,
  type PricePlan,
  type ProductDetails,
} from '../../lib/product-details';
import { formatMoney, formatNumber } from '../../lib/money';
import { cn } from '../../lib/utils';
import { Avatar } from './avatar';
import { BRAND_ICON_IDS } from './brand-icon-ids';
import { LinkedInMark, XMark } from './icons';

// ---------- tag icons ----------

const MARKET_ICON: Record<MarketId, LucideIcon> = {
  ai: Sparkles,
  analytics: ChartColumn,
  community: MessagesSquare,
  content: PenLine,
  crypto: Bitcoin,
  design: Palette,
  devtools: CodeXml,
  ecommerce: ShoppingBag,
  education: GraduationCap,
  finance: Wallet,
  food: Utensils,
  games: Gamepad2,
  health: HeartPulse,
  hr: Briefcase,
  legal: Scale,
  marketing: Megaphone,
  mobile: Smartphone,
  music: Music,
  nocode: Blocks,
  productivity: ListChecks,
  'real-estate': House,
  saas: Cloud,
  sales: TrendingUp,
  security: Shield,
  social: Users,
  support: LifeBuoy,
  travel: Plane,
};

/** Channels without a brand mark of their own. */
const CHANNEL_ICON: Partial<Record<ChannelId, LucideIcon>> = {
  seo: Search,
  content: PenLine,
  press: Newspaper,
  ads: Megaphone,
  outreach: Send,
  newsletter: Mail,
  affiliates: Handshake,
  communities: UsersRound,
  aso: Store,
  directories: List,
  partnerships: Building2,
  'word-of-mouth': MessageCircle,
};

/** A brand's mark from the sprite, in the text's colour. */
function BrandMark(props: { id: string; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className={props.className}>
      <use href={`/brand-icons.svg#${props.id}`} />
    </svg>
  );
}

/** The icon a tag wears: its brand's mark where the sprite has one, else a lucide icon. Decorative. */
export function TagIcon(props: { kind: 'market' | 'channel' | 'tech'; id: string; className?: string }) {
  const cls = cn('size-3.5 shrink-0', props.className);
  if (props.kind === 'market') {
    const Icon = MARKET_ICON[props.id as MarketId] ?? Tag;
    return <Icon aria-hidden="true" className={cls} />;
  }
  if (props.kind === 'channel') {
    if (props.id === 'x') return <XMark className={cls} />;
    if (props.id === 'linkedin') return <LinkedInMark className={cls} />;
    if (BRAND_ICON_IDS.has(`c-${props.id}`)) return <BrandMark id={`c-${props.id}`} className={cls} />;
    const Icon = CHANNEL_ICON[props.id as ChannelId] ?? Megaphone;
    return <Icon aria-hidden="true" className={cls} />;
  }
  if (BRAND_ICON_IDS.has(`t-${props.id}`)) return <BrandMark id={`t-${props.id}`} className={cls} />;
  return <CodeXml aria-hidden="true" className={cls} />;
}

// ---------- the section ----------

function Chip(props: { children: ReactNode }) {
  return (
    <li className="inline-flex h-7 items-center gap-1.5 rounded-full border bg-background px-2.5 text-caption font-medium">{props.children}</li>
  );
}

function Chips(props: { kind: 'market' | 'channel' | 'tech'; ids: readonly string[]; list: readonly { id: string; label: string }[]; label: string }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={props.label}>
      {props.ids.map((id) => (
        <Chip key={id}>
          <TagIcon kind={props.kind} id={id} />
          {labelOf(props.list, id)}
        </Chip>
      ))}
    </ul>
  );
}

/** One of the visitor's questions, answered: a heading with its icon, and what the founder says. */
function Block(props: { icon: LucideIcon; title: string; className?: string; children: ReactNode }) {
  const Icon = props.icon;
  return (
    <CossCard render={<section />} className={cn('min-w-0 gap-4 p-5 sm:p-6', props.className)}>
      <h3 className="flex items-center gap-2 font-heading text-base">
        <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        {props.title}
      </h3>
      {props.children}
    </CossCard>
  );
}

/** A small label over the founder's answer, inside a block. */
function Part(props: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1 text-caption font-medium text-muted-foreground">{props.label}</h4>
      {props.children}
    </div>
  );
}

/** Owner text: their line breaks kept, long words broken, never turned into links. */
function Words(props: { children: string; className?: string }) {
  return <p className={cn('text-body whitespace-pre-line wrap-break-word text-pretty', props.className)}>{props.children}</p>;
}

const people = (n: number) => `${formatNumber(n)} ${n === 1 ? 'person' : 'people'}`;

/** Literal classes for the facts row, one column per fact from `sm` (the CSS build sees whole names only). */
const FACT_COLUMNS = ['', 'sm:grid-cols-1', 'sm:grid-cols-2', 'sm:grid-cols-3'] as const;

/**
 * One plan as an item of its own: its name and how it's billed, the price, what it comes to a
 * month when it isn't monthly, what a yearly plan saves against the monthly one of the same name,
 * and the founder's note.
 */
function Plan(props: { plan: PricePlan; plans: readonly PricePlan[] }) {
  const p = props.plan;
  const read = describePlan(p);
  const saving = yearlySaving(p, props.plans);
  return (
    <li className="flex min-w-0 flex-col rounded-xl border bg-background p-4">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 font-medium wrap-break-word">{p.name}</span>
        {/* A free plan's price already says Free. */}
        {p.period === 'free' ? null : (
          <Badge variant="outline" className="shrink-0">
            {labelOf(PLAN_PERIODS, p.period)}
          </Badge>
        )}
      </div>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-title tabular-nums">{read.price}</span>
        {read.unit ? <span className="text-body text-muted-foreground">{read.unit}</span> : null}
      </p>
      {read.compare || saving ? (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
          {read.compare ? <span className="tabular-nums">{read.compare}</span> : null}
          {saving ? <Badge variant="success">Saves {saving}% against monthly</Badge> : null}
        </p>
      ) : null}
      {p.note ? <p className="mt-2 border-t pt-2 text-caption text-pretty wrap-break-word text-muted-foreground">{p.note}</p> : null}
    </li>
  );
}

/**
 * The founder to visitors, in their own voice: a quote, signed with their photo and name (linked
 * to their profile). It opens the section, between the figures and the rest of the founder's words.
 */
function FounderMessage(props: { message: string; product: string; founder: { name: string; handle: string; avatar: string | null } | null }) {
  const f = props.founder;
  return (
    <CossCard render={<figure />} className="relative min-w-0 gap-5 overflow-hidden p-5 sm:p-6 md:col-span-2">
      <h3 className="flex items-center gap-2 font-heading text-base">
        <MessageSquareQuote aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />A message from the founder
      </h3>
      {/* The quote mark is decoration; the words are the owner's, kept as typed. */}
      <Quote aria-hidden="true" className="pointer-events-none absolute top-4 right-5 size-14 rotate-180 text-foreground/[0.05]" />
      <blockquote className="text-lead whitespace-pre-line wrap-break-word text-pretty">{props.message}</blockquote>
      {f ? (
        <figcaption className="flex items-center gap-3">
          <Avatar name={f.name} src={f.avatar} className="size-9 text-caption" />
          <span className="min-w-0">
            <a href={`/u/${f.handle}`} className="block font-medium wrap-break-word hover:underline">
              {f.name}
            </a>
            <span className="block text-caption text-muted-foreground wrap-break-word">Founder of {props.product}</span>
          </span>
        </figcaption>
      ) : null}
    </CossCard>
  );
}

/**
 * "About <name>", in the order a visitor asks: the founder's message, the facts at a glance (who
 * it sells to, the team, the funding), then what it is, the problem it solves and who it's for, how it makes money, how it
 * finds customers and how it's built.
 * Only what the founder filled in shows, and nothing at all when that's nothing. The one figure
 * here hoomuch checks, what a subscription brings in on average, says so.
 */
export function ProductAbout(props: {
  name: string;
  details: ProductDetails;
  /** Who signs the message: the founder (SPEC F-22), every published product has one. */
  founder: { name: string; handle: string; avatar: string | null } | null;
  /** Verified MRR per active subscription (USD minor units), null without subscriptions. */
  perSubscription: number | null;
}) {
  const d = props.details;
  if (!hasDetails(d)) return null;

  const facts = [
    d.model ? { label: 'Sells to', value: labelOf(MODELS, d.model) } : null,
    d.teamSize !== null ? { label: 'Team', value: people(d.teamSize) } : null,
    d.funding ? { label: 'Funding', value: labelOf(FUNDING, d.funding) } : null,
  ].filter((f): f is { label: string; value: string } => f !== null);
  const whatItIs = Boolean(d.description || d.markets.length > 0);
  // The two questions a visitor asks first, a card each, side by side; one alone takes the row.
  const pair = d.problem && d.audience ? undefined : 'md:col-span-2';
  const money = d.plans.length > 0 || Boolean(d.pricing);
  const plans = groupPlans(d.plans);

  return (
    <section aria-labelledby="about-title" className="mt-6">
      <h2 id="about-title" className="font-heading text-title wrap-break-word">
        About {props.name}
      </h2>
      <p className="mt-1 text-caption text-muted-foreground">In the founder’s words. hoomuch checks only the figures above.</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {d.message ? <FounderMessage message={d.message} product={props.name} founder={props.founder} /> : null}

        {facts.length > 0 ? (
          <CossCard className="overflow-hidden md:col-span-2">
            <dl className={cn('grid grid-cols-2 gap-px bg-border', FACT_COLUMNS[facts.length])}>
              {facts.map((f) => (
                <div key={f.label} className="bg-card px-5 py-3.5 sm:px-6">
                  <dt className="text-caption text-muted-foreground">{f.label}</dt>
                  <dd className="mt-0.5 text-body font-medium">{f.value}</dd>
                </div>
              ))}
            </dl>
          </CossCard>
        ) : null}

        {whatItIs ? (
          <Block icon={Lightbulb} title="What it is" className="md:col-span-2">
            {d.description ? <Words className="text-lead">{d.description}</Words> : null}
            {d.markets.length > 0 ? (
              <Part label="Market">
                <Chips kind="market" ids={d.markets} list={MARKETS} label="Market" />
              </Part>
            ) : null}
          </Block>
        ) : null}

        {d.problem ? (
          <Block icon={Target} title="Problem it solves" className={pair}>
            <Words>{d.problem}</Words>
          </Block>
        ) : null}
        {d.audience ? (
          <Block icon={Users} title="Who it’s for" className={pair}>
            <Words>{d.audience}</Words>
          </Block>
        ) : null}

        {money ? (
          <Block icon={CircleDollarSign} title="How it makes money" className="md:col-span-2">
            {plans.length > 0 ? (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Pricing plans">
                {plans.map((p, i) => (
                  <Plan key={i} plan={p} plans={plans} />
                ))}
              </ul>
            ) : null}
            {d.pricing ? <Words className="text-muted-foreground">{d.pricing}</Words> : null}
            {props.perSubscription !== null && props.perSubscription > 0 ? (
              <p className="flex items-start gap-2 border-t pt-3 text-caption text-muted-foreground">
                <BadgeCheck aria-hidden="true" className="mt-px size-3.5 shrink-0 text-success-foreground" />
                <span>
                  Checked by hoomuch: a subscription brings in{' '}
                  <span className="font-medium text-foreground tabular-nums">{formatMoney(props.perSubscription, 'USD')}</span> a month on
                  average (MRR divided by active subscriptions).
                </span>
              </p>
            ) : null}
          </Block>
        ) : null}

        {d.channels.length > 0 ? (
          <Block icon={Megaphone} title="How it finds customers" className={d.tech.length > 0 ? undefined : 'md:col-span-2'}>
            <Chips kind="channel" ids={d.channels} list={CHANNELS} label="Marketing channels" />
          </Block>
        ) : null}
        {d.tech.length > 0 ? (
          <Block icon={CodeXml} title="How it’s built" className={d.channels.length > 0 ? undefined : 'md:col-span-2'}>
            <Chips kind="tech" ids={d.tech} list={TECH} label="Tech stack" />
          </Block>
        ) : null}

        {d.more ? (
          <Block icon={Info} title="Anything else" className="md:col-span-2">
            <Words>{d.more}</Words>
          </Block>
        ) : null}
      </div>
    </section>
  );
}
