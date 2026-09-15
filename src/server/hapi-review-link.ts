import { execFile } from 'child_process';

export interface HapiReviewLink {
  hapiSessionId: string;
  reviewId: string;
  browserUrl?: string;
  reviewUrl?: string;
  branch?: string;
}

export function updateHapiReviewLink(
  action: 'attach' | 'detach',
  link: HapiReviewLink,
  run: typeof execFile = execFile,
): Promise<void> {
  const executable = process.env.HAPI_CLI_EXECUTABLE?.trim() || 'hapi';
  const args = [
    'difit-review',
    action,
    '--session-id',
    link.hapiSessionId,
    '--review-id',
    link.reviewId,
  ];
  if (action === 'attach') {
    if (!link.browserUrl) return Promise.reject(new Error('DIFIT browser URL is required'));
    args.push('--url', link.browserUrl);
    if (link.reviewUrl) args.push('--review-url', link.reviewUrl);
    if (link.branch) args.push('--branch', link.branch);
  }

  return new Promise((resolve, reject) => {
    run(executable, args, { timeout: 15_000, windowsHide: true }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}
