import type { DiffLine } from '../../types/diff';

const textEncoder = new TextEncoder();

export function getGitLabLineFragment(line: DiffLine | undefined): string | undefined {
  if (!line) return undefined;
  if (line.type === 'add') {
    return line.newLineNumber === undefined ? undefined : `A${line.newLineNumber}`;
  }

  return line.oldLineNumber === undefined ? undefined : String(line.oldLineNumber);
}

export async function buildGitLabDiffLineUrl(
  mergeRequestUrl: string,
  filePath: string,
  lineFragment: string,
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', textEncoder.encode(filePath));
  const fileHash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const baseUrl = mergeRequestUrl.replace(/\/diffs\/?$/, '').replace(/\/$/, '');
  const url = new URL(`${baseUrl}/diffs`);
  url.searchParams.set('file_path', filePath);
  url.hash = `line_${fileHash.slice(0, 9)}_${lineFragment}`;

  return url.toString();
}
