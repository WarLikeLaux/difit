import type { CommentThreadStatus } from '../../types/diff';

export const THREAD_STATUS_LABELS = {
  open: 'Open',
  accepted: 'Agent Working',
  changes_requested: 'Changes Requested',
  to_verify: 'Verify Fix',
  ready: 'Ready',
  closed: 'Closed',
  resolved: 'Resolved',
} satisfies Record<CommentThreadStatus, string>;
