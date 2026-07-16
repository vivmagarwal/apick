import { cn, formatDateTime } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import type { Envelope } from '../types';

export type DocStatus = 'draft' | 'modified' | 'published' | 'scheduled';

type StatusSource = Pick<Envelope, 'version' | 'publishedVersion' | 'scheduledPublishAt'>;

/** Draft/modified/published/scheduled, derived from an envelope. */
export function statusOf(env: StatusSource): DocStatus {
  if (env.scheduledPublishAt) return 'scheduled';
  if (env.publishedVersion === null) return 'draft';
  return env.publishedVersion < env.version ? 'modified' : 'published';
}

const STYLES: Record<DocStatus, string> = {
  draft: 'bg-status-draft/10 text-status-draft border-status-draft/25',
  modified: 'bg-status-modified/10 text-status-modified border-status-modified/25',
  published: 'bg-status-published/10 text-status-published border-status-published/25',
  scheduled: 'bg-status-scheduled/10 text-status-scheduled border-status-scheduled/25',
};

const LABELS: Record<DocStatus, string> = {
  draft: 'Draft',
  modified: 'Modified',
  published: 'Published',
  scheduled: 'Scheduled',
};

export function StatusPill({ env, className }: { env: StatusSource; className?: string }) {
  const status = statusOf(env);
  const pill = (
    <span
      data-status={status}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        STYLES[status],
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {LABELS[status]}
    </span>
  );
  if (status === 'scheduled' && env.scheduledPublishAt) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{pill}</TooltipTrigger>
        <TooltipContent>Publishes {formatDateTime(env.scheduledPublishAt)}</TooltipContent>
      </Tooltip>
    );
  }
  return pill;
}
