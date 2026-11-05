/** DangerZone: a coss Card with a destructive-toned border, for destructive forms. Owner: Experience (design). CONTRACT: props are fixed. */

import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card';

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function DangerZone(props: { title: string; description?: ReactNode; children?: ReactNode; id?: string }) {
  const headingId = `${(props.id ?? slug(props.title)) || 'danger'}-title`;
  return (
    <Card render={<section aria-labelledby={headingId} />} className="border-destructive/32">
      <CardHeader className="px-5 pt-5 sm:px-6 sm:pt-6">
        <CardTitle render={<h2 id={headingId} />} className="flex items-center gap-2 text-base text-destructive-foreground">
          <TriangleAlert className="size-4 shrink-0" />
          {props.title}
        </CardTitle>
        {props.description ? <CardDescription className="max-w-prose">{props.description}</CardDescription> : null}
      </CardHeader>
      {props.children ? <CardPanel className="px-5 pb-5 sm:px-6 sm:pb-6">{props.children}</CardPanel> : null}
    </Card>
  );
}
