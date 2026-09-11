import { execFileSync } from 'child_process';

const GITLAB_MERGE_REQUEST_PATH = /\/-\/merge_requests\/\d+(?:\/diffs)?\/?$/;

export function normalizeGitLabMergeRequestUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !GITLAB_MERGE_REQUEST_PATH.test(url.pathname)
    ) {
      return undefined;
    }

    url.pathname = url.pathname.replace(/\/diffs\/?$/, '').replace(/\/$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export function detectGitLabMergeRequestUrl(
  repoPath: string | undefined,
  targetCommitish: string,
): string | undefined {
  const branchArgument =
    targetCommitish === 'HEAD' ||
    targetCommitish === '.' ||
    targetCommitish === 'working' ||
    targetCommitish === 'staged'
      ? []
      : [targetCommitish.replace(/^origin\//, '')];

  try {
    const output = execFileSync('glab', ['mr', 'view', ...branchArgument, '--output', 'json'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      env: { ...process.env, GLAB_PROMPT_DISABLED: 'true' },
    });
    const result = JSON.parse(output) as { web_url?: unknown };
    return typeof result.web_url === 'string'
      ? normalizeGitLabMergeRequestUrl(result.web_url)
      : undefined;
  } catch {
    return undefined;
  }
}
