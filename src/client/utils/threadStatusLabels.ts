import type { CommentThreadStatus } from '../../types/diff';

export const THREAD_STATUS_LABELS = {
  open: 'Open',
  accepted: 'Accepted',
  to_verify: 'Verify by agent',
  ready: 'Ready for review',
  resolved: 'Resolved',
} satisfies Record<CommentThreadStatus, string>;
